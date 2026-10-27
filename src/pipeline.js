// Import and revalidation pipeline shared by the HTTP server and the evaluation harness, so
// what is measured is exactly what runs in the application.
const path = require('node:path');
const crypto = require('node:crypto');
const { FIELD_DEFINITIONS, CAPACITY_RULE, normaliseRecord, schemaSuggestion, validate, reconcile, syncCapacityFindings } = require('./engine');
const { assignLineage } = require('./lineage');
const { mergeFindings, applyAutomation } = require('./automation');
const { valueShape } = require('./ai-provider');

const ALIAS_TOKENS = {
  apaar_id: ['apaar', 'apaar id', 'abc id', 'student id', 'apaar number'],
  student_name: ['student name', 'name of student', 'candidate name', 'learner name', 'full name'],
  date_of_birth: ['dob', 'date of birth', 'birth date', 'birthdate'],
  institution_code: ['institution code', 'college code', 'aishe code', 'institute code'],
  institution_name: ['institution name', 'college name', 'institute name'],
  programme: ['programme', 'program', 'course', 'degree'],
  academic_session: ['academic session', 'academic year', 'session'],
  admission_year: ['admission year', 'year of admission', 'batch year'],
  enrolment_status: ['enrolment status', 'enrollment status', 'status'],
  seat_category: ['seat category', 'admission category', 'quota', 'category']
};
const tokens = value => String(value ?? '').toLocaleLowerCase('en-IN').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// Deterministic header interpretation for headers the exact alias list did not recognise:
// a field is suggested when all tokens of one of its aliases appear in the header and no other
// field matches equally well. Ambiguous headers are reported instead of guessed.
function headerSimilaritySuggestion(headers, mapping) {
  const used = new Set(Object.values(mapping));
  const suggestions = {}; const ambiguous = [];
  for (const header of headers.filter(h => !used.has(h))) {
    const words = new Set(tokens(header));
    const scored = Object.entries(ALIAS_TOKENS).filter(([field]) => !mapping[field]).map(([field, aliases]) => {
      const best = Math.max(0, ...aliases.map(alias => { const t = tokens(alias); return t.every(w => words.has(w)) ? t.length : 0; }));
      return { field, best };
    }).filter(x => x.best > 0).sort((a, b) => b.best - a.best);
    if (!scored.length) continue;
    if (scored[1] && scored[1].best === scored[0].best) { ambiguous.push({ header, fields: scored.filter(x => x.best === scored[0].best).map(x => x.field) }); continue; }
    if (suggestions[scored[0].field]) { ambiguous.push({ header, fields: [scored[0].field] }); continue; }
    suggestions[scored[0].field] = header;
  }
  return { suggestions, ambiguous };
}

// Column shapes a field can plausibly have. A model suggestion whose column shape does not fit
// the field is rejected before it reaches the user (for example a date column for a name).
const FIELD_SHAPES = {
  apaar_id: ['12-digit number', 'mixed text and digits'],
  student_name: ['text (2–4 words)', 'text (1 word)', 'text (5+ words)'],
  date_of_birth: ['date'],
  institution_code: ['short uppercase code', 'text (1 word)', 'mixed text and digits'],
  institution_name: ['text (1 word)', 'text (2–4 words)', 'text (5+ words)', 'short uppercase code'],
  programme: ['short uppercase code', 'text (1 word)', 'text (2–4 words)', 'text (5+ words)', 'mixed text and digits'],
  academic_session: ['year range', 'mixed text and digits', 'short number'],
  admission_year: ['short number'],
  enrolment_status: ['text (1 word)', 'text (2–4 words)', 'short uppercase code'],
  seat_category: ['short uppercase code', 'text (1 word)', 'text (2–4 words)']
};
const MIN_MODEL_CONFIDENCE = 0.6;
// Why a model mapping suggestion cannot be accepted, or null when it passes validation.
function rejectSuggestion(m, mapping, shapes) {
  if (!m.header) return 'abstained';
  if (m.confidence < MIN_MODEL_CONFIDENCE) return `confidence ${m.confidence} is below ${MIN_MODEL_CONFIDENCE}`;
  if (mapping[m.field]) return 'field is already mapped';
  if (Object.values(mapping).includes(m.header)) return 'header is already mapped';
  const shape = shapes[m.header] || 'empty';
  if (shape === 'empty') return 'column is empty';
  if (!(FIELD_SHAPES[m.field] || []).some(kind => shape.split(' or ').includes(kind))) return `column shape "${shape}" does not fit ${m.field}`;
  return null;
}

// Mapping suggestion: exact aliases, then deterministic header similarity, then (only when a
// provider is configured) model-assisted interpretation of what is still unmapped. Every
// suggestion is shown to the user for confirmation before import.
async function suggestMapping(parsed, provider) {
  const mapping = schemaSuggestion(parsed.headers);
  const sources = Object.fromEntries(Object.keys(mapping).map(k => [k, 'alias']));
  const similar = headerSimilaritySuggestion(parsed.headers, mapping);
  Object.entries(similar.suggestions).forEach(([field, header]) => { mapping[field] = header; sources[field] = 'header_similarity'; });
  const unmappedFields = FIELD_DEFINITIONS.filter(f => !mapping[f.key]);
  const unusedHeaders = parsed.headers.filter(h => !Object.values(mapping).includes(h));
  const status = provider.status();
  const model = { available: status.tasks.schema_interpretation.available, used: false, provider: status.provider, model: status.model, note: status.tasks.schema_interpretation.reason, sent: null, suggestions: [], rejected: [], latency_ms: null, usage: null };
  if (model.available && unmappedFields.length && unusedHeaders.length) {
    // Minimised input: header names and coarse value shapes only — no values leave the server.
    const shapes = Object.fromEntries(unusedHeaders.map(h => [h, valueShape(parsed.rows.slice(0, 25).map(r => r[h]))]));
    const input = {
      unmapped_fields: unmappedFields.map(f => ({ key: f.key, label: f.label, required: f.required })),
      headers: unusedHeaders.map(h => ({ name: h, shape: shapes[h] }))
    };
    const result = await provider.run('schema_interpretation', input);
    model.sent = { fields: input.unmapped_fields.map(f => f.key), headers: input.headers };
    model.latency_ms = result.provenance?.latency_ms ?? result.latency_ms ?? null;
    model.usage = result.provenance?.usage ?? result.usage ?? null;
    if (result.ok) {
      model.used = true; model.model = result.provenance.model; model.note = 'Model-assisted suggestions passed validation, are marked, and must be confirmed in the mapping step.';
      for (const m of result.output.mappings) {
        const why = rejectSuggestion(m, mapping, shapes);
        if (why === 'abstained') continue;
        if (why) { model.rejected.push({ field: m.field, header: m.header, confidence: m.confidence, reason: why }); continue; }
        mapping[m.field] = m.header; sources[m.field] = 'model';
        model.suggestions.push({ field: m.field, header: m.header, confidence: m.confidence, reason: m.reason });
      }
    } else model.note = result.reason;
  }
  return { mapping, sources, ambiguous: similar.ambiguous, model };
}

function recordFromMapping(row, mapping) { return normaliseRecord(Object.fromEntries(Object.entries(mapping).map(([canonical, source]) => [canonical, row[source]]))); }

function rowOutcome(rec, sourceRow, batchInstitution, multiInstitution, knownInstitutions) {
  const wrongInstitution = multiInstitution ? !knownInstitutions.has(rec.institution_code) : rec.institution_code !== batchInstitution;
  if (wrongInstitution) return { source_row: sourceRow, outcome: 'skipped', reason: multiInstitution ? 'Institution code is not recognised for multi-institution import.' : `Institution code does not match selected source institution ${batchInstitution}.` };
  const rowIssues = validate(rec);
  const requiredIssues = rowIssues.filter(issue => issue.code === 'REQUIRED_FIELD_MISSING');
  if (requiredIssues.length) return { source_row: sourceRow, outcome: 'rejected', reason: `Required values missing: ${requiredIssues.map(issue => issue.field).join(', ')}.` };
  return { source_row: sourceRow, outcome: 'imported', validation_issues: rowIssues.filter(issue => issue.code !== 'REQUIRED_FIELD_MISSING').map(issue => issue.code) };
}

function uniqueBatchId(db, at) {
  const base = `IMP-UP-${Date.parse(at) || Date.now()}`;
  let candidate = base; let n = 1;
  while (db.importBatches.some(b => b.id === candidate)) candidate = `${base}-${++n}`;
  return candidate;
}

// Reconcile everything, merge by condition, recompute capacity and run automation.
function processAll(db, { at, reason, origin, batch = null }) {
  const changes = mergeFindings(db, reconcile(db).filter(f => f.rule_code !== CAPACITY_RULE), { at, reason });
  const capacity = syncCapacityFindings(db, { at, reason });
  const automation = applyAutomation(db, { at, origin, batch, changes, capacity });
  return { changes, capacity, automation };
}

function commitImport(db, { parsed, mapping, batchInstitution, multiInstitution, filename, at = new Date().toISOString() }) {
  const batch = { id: uniqueBatchId(db, at), institution_code: batchInstitution, source_file: path.basename(String(filename)).replace(/[^a-zA-Z0-9._-]/g, '_'), rows_detected: parsed.rows.length, imported: 0, rejected: 0, skipped: 0, findings_created: 0, validation_findings_created: 0, row_outcomes: [], created_at: at, multi_institution: multiInstitution };
  const knownInstitutions = new Set(db.institutions.map(institution => institution.code));
  const newIds = [];
  parsed.rows.forEach((row, i) => {
    const rec = recordFromMapping(row, mapping);
    const sourceRow = parsed.row_numbers[i];
    const outcome = rowOutcome(rec, sourceRow, batch.institution_code, multiInstitution, knownInstitutions);
    batch.row_outcomes.push(outcome);
    if (outcome.outcome === 'skipped') { batch.skipped++; return; }
    if (outcome.outcome === 'rejected') {
      batch.rejected++;
      // A one-way hash of the row's values lets an identical resubmitted row be recognised
      // without storing the rejected values themselves.
      batch.rejected_row_signatures = { ...(batch.rejected_row_signatures || {}), [sourceRow]: crypto.createHash('sha256').update(`edutrace-row:${JSON.stringify(Object.values(row).map(v => String(v ?? '').trim().toLocaleLowerCase('en-IN')))}`).digest('hex').slice(0, 20) };
      return;
    }
    const recordId = `SRC-UP-${batch.id.slice(7)}-${i}`;
    db.sourceRecords.push({ id: recordId, source_file: batch.source_file, source_row: sourceRow, import_id: batch.id, imported_at: batch.created_at, ...rec });
    newIds.push(recordId); batch.imported++;
  });
  // Classify the new rows against earlier submissions (re-import, corrected version or candidate)
  // before reconciling, so superseded versions no longer take part.
  const lineage = assignLineage(db, db.sourceRecords.filter(r => newIds.includes(r.id)), { at });
  batch.lineage = { unchanged_copies: lineage.copies.length, corrections_applied: lineage.corrections.length, correction_candidates: lineage.candidates.length };
  const { changes, capacity, automation } = processAll(db, { at, reason: `after import ${batch.id}`, origin: 'import', batch });
  batch.findings_resolved_by_correction = changes.cleared.length;
  batch.findings_created = changes.created.length + capacity.created.length;
  batch.validation_findings_created = changes.created.filter(f => f.category === 'identifier').length;
  batch.findings_superseded = changes.superseded.length;
  batch.findings_evidence_updated = changes.extended.length;
  batch.capacity_findings_created = capacity.created.length;
  batch.capacity_findings_superseded = capacity.superseded.length;
  batch.capacity_findings_cleared = capacity.cleared.length;
  const mine = new Set(newIds);
  const status = s => db.sourceRecords.filter(r => mine.has(r.id) && r.processing?.status === s).length;
  batch.automation = {
    automatically_processed: status('automatically_processed'), automatically_normalised: status('automatically_normalised'), safely_matched: status('safely_matched'),
    needs_institution_correction: status('needs_institution_correction'), needs_investigation: status('needs_investigation'), verification_pending: status('verification_pending'),
    processing_failed: batch.rejected, automatically_resolved_findings: automation.auto_matched.length, notified: automation.notified, suppressed_repeats: automation.suppressed,
    notification_ids: automation.notifications.map(n => n.id)
  };
  db.importBatches.push(batch);
  return batch;
}

function revalidate(db, { at = new Date().toISOString(), origin = 'revalidation' } = {}) {
  const { changes, capacity, automation } = processAll(db, { at, reason: 'on revalidation', origin });
  return { created: changes.created.length + capacity.created.length, evidence_updated: changes.extended.length, superseded: changes.superseded.length + capacity.superseded.length, cleared: capacity.cleared.length, unchanged: changes.unchanged.length + capacity.unchanged.length, auto_matched: automation.auto_matched.length, withdrawn: automation.withdrawn.length, notified: automation.notified, suppressed_repeats: automation.suppressed };
}

module.exports = { FIELD_SHAPES, rejectSuggestion, suggestMapping, headerSimilaritySuggestion, recordFromMapping, rowOutcome, commitImport, revalidate, processAll };
