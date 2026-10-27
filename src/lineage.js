// Source-record lineage: unchanged re-imports, corrected versions and correction candidates.
//
// Source records are never edited. When an institution re-sends a student record, the new row is
// stored as a new source record and classified against earlier rows from the same institution:
//   unchanged_copy  every canonical value is identical to an earlier record (a re-import). The copy
//                   shares the earlier record's lineage id and version; nothing new to review.
//   correction      the institution's stable reference (`source_reference`) matches an earlier
//                   record and at most one identity value was replaced by a different value. The new
//                   row becomes the next version and the earlier one is superseded: kept in full, but
//                   no longer used by reconciliation, identity linking or capacity counting.
//   candidate       evidence that this may be a correction is incomplete or contradictory (no stable
//                   reference, or a reference whose identity values changed too much). A reviewer
//                   confirms or rejects it; until then both records stay active and independent.
// Rules here never use name similarity and never link two students. Identity association remains
// the business of src/identity.js and policy auto-link-2. The CSV row number is never used.
const crypto = require('node:crypto');
const { mask, canAccess, isActiveRecord } = require('./engine');
const { nameKey } = require('./names');

const LINEAGE_FIELDS = ['apaar_id', 'student_name', 'date_of_birth', 'institution_name', 'programme', 'academic_session', 'admission_year', 'enrolment_status', 'seat_category'];
const IDENTITY_FIELDS = ['apaar_id', 'student_name', 'date_of_birth'];
const FIELD_LABELS = { apaar_id: 'APAAR identifier', student_name: 'Name', date_of_birth: 'Date of birth', institution_name: 'Institution name', programme: 'Programme', academic_session: 'Academic session', admission_year: 'Admission year', enrolment_status: 'Enrolment status', seat_category: 'Seat category' };

const lineageOf = r => r.lineage || { id: r.id, version: 1, relation: 'original' };
const usableId = r => (r.apaar_id && /^\d{12}$/.test(r.apaar_id) ? r.apaar_fingerprint : null);
// Values as compared: the stored canonical value, with identifiers masked in anything recorded.
const shown = (field, value) => (field === 'apaar_id' && value ? mask(value) : value || null);
const valueOf = (r, field) => (field === 'student_name' ? r.normalized_name : field === 'apaar_id' ? (r.apaar_fingerprint || '') : String(r[field] ?? ''));

// Field-level differences between an earlier and a later record. `filled` means a missing value was
// supplied; `replaced` means one value was changed to another; `removed` means a value disappeared.
function compareVersions(earlier, later) {
  return LINEAGE_FIELDS.flatMap(field => {
    const a = valueOf(earlier, field); const b = valueOf(later, field);
    if (a === b) return [];
    const kind = !a ? 'filled' : !b ? 'removed' : 'replaced';
    return [{ field, label: FIELD_LABELS[field], kind, from: shown(field, field === 'apaar_id' ? earlier.apaar_id : earlier[field]), to: shown(field, field === 'apaar_id' ? later.apaar_id : later[field]) }];
  });
}
const identityReplacements = changes => changes.filter(c => IDENTITY_FIELDS.includes(c.field) && c.kind !== 'filled');

function lineageEvent(db, event) {
  db.lineageEvents = db.lineageEvents || [];
  const entry = { id: `LIN-${crypto.randomUUID()}`, ...event };
  db.lineageEvents.push(entry);
  return entry;
}

// Make `later` the next version of `earlier`. The earlier record keeps every value.
function supersede(db, earlier, later, { basis, changes, actor, note, at }) {
  const prev = lineageOf(earlier);
  earlier.superseded_by = later.id;
  earlier.superseded_at = at;
  later.lineage = { id: prev.id, version: prev.version + 1, relation: 'correction', supersedes: earlier.id, basis, changes };
  return lineageEvent(db, { action: 'version_superseded', institution_code: later.institution_code, lineage_id: prev.id, earlier: earlier.id, later: later.id, basis, changes, actor, note, at });
}

function addCandidate(db, earlier, later, { basis, reasons, changes, at }) {
  db.correctionCandidates = db.correctionCandidates || [];
  const candidate = { id: `CORR-${crypto.createHash('sha256').update(`${earlier.id}|${later.id}`).digest('hex').slice(0, 12)}`, institution_code: later.institution_code, earlier: earlier.id, later: later.id, basis, reasons, changes, status: 'pending', created_at: at };
  if (!db.correctionCandidates.some(c => c.id === candidate.id)) db.correctionCandidates.push(candidate);
  lineageEvent(db, { action: 'correction_candidate_created', institution_code: later.institution_code, candidate_id: candidate.id, earlier: earlier.id, later: later.id, basis, changes, actor: 'EduTrace reconciliation engine (automated)', note: reasons.join(' '), at });
  return candidate;
}

// Classify newly imported records. `fresh` are the records added by one import batch.
function assignLineage(db, fresh, { at, actor = 'EduTrace reconciliation engine (automated)' } = {}) {
  const freshIds = new Set(fresh.map(r => r.id));
  const result = { copies: [], corrections: [], candidates: [] };
  for (const r of fresh) {
    r.lineage = r.lineage || { id: r.id, version: 1, relation: 'original' };
    const earlier = db.sourceRecords.filter(e => !freshIds.has(e.id) && isActiveRecord(e) && e.institution_code === r.institution_code && e.import_id !== r.import_id);
    if (r.source_reference) {
      const prev = earlier.filter(e => e.source_reference === r.source_reference).sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)) || lineageOf(b).version - lineageOf(a).version)[0];
      if (!prev) continue;
      const changes = compareVersions(prev, r);
      if (!changes.length) { r.lineage = { ...lineageOf(prev), relation: 'unchanged_copy', copy_of: prev.id }; result.copies.push(r); continue; }
      const replaced = identityReplacements(changes);
      if (replaced.length <= 1) {
        supersede(db, prev, r, { basis: 'institution_reference', changes, actor, note: `The institution re-sent reference ${r.source_reference} with ${changes.length === 1 ? 'one changed value' : `${changes.length} changed values`}; the new row supersedes the earlier version.`, at });
        result.corrections.push(r);
      } else {
        result.candidates.push(addCandidate(db, prev, r, { basis: 'institution_reference', changes, at, reasons: [`Reference ${r.source_reference} was re-sent, but ${replaced.map(c => c.label.toLowerCase()).join(' and ')} changed to different values.`, 'This may be a correction or a reused reference for another student; a reviewer must decide.'] }));
      }
      continue;
    }
    // No stable reference: an identical earlier row is a re-import; a row that only fills missing
    // identity values for the same name, programme and session, or shares the usable identifier
    // with changed details in the same session, may be a correction and needs confirmation.
    const same = earlier.find(e => !e.source_reference && compareVersions(e, r).length === 0);
    if (same) { r.lineage = { ...lineageOf(same), relation: 'unchanged_copy', copy_of: same.id }; result.copies.push(r); continue; }
    const possible = earlier.find(e => !e.source_reference && e.programme === r.programme && e.academic_session === r.academic_session && (
      (usableId(e) && usableId(e) === usableId(r)) ||
      // A malformed identifier was never usable evidence, so replacing it counts as supplying it.
      (nameKey(e.normalized_name) === nameKey(r.normalized_name) && (!e.date_of_birth || e.date_of_birth === r.date_of_birth) && compareVersions(e, r).every(c => c.kind === 'filled' || (c.field === 'apaar_id' && !usableId(e))))
    ));
    if (possible) {
      const changes = compareVersions(possible, r);
      const reasons = usableId(possible) && usableId(possible) === usableId(r)
        ? ['A later file from the same institution has the same identifier for the same programme and session with different values.', 'Without the institution\'s own record reference it is not certain that this row replaces the earlier one.']
        : ['A later file from the same institution supplies values that were missing for the same name, programme and session.', 'Without the institution\'s own record reference it is not certain that this row replaces the earlier one.'];
      result.candidates.push(addCandidate(db, possible, r, { basis: 'heuristic', changes, at, reasons }));
    }
  }
  return result;
}

class LineageError extends Error { constructor(status, message) { super(message); this.status = status; } }

// A reviewer confirms or rejects a correction candidate. Confirming supersedes the earlier record;
// the caller then re-runs reconciliation so findings and identity links use the corrected values.
function decideCorrection(db, p, candidateId, input = {}) {
  const c = (db.correctionCandidates || []).find(x => x.id === candidateId);
  const records = new Map(db.sourceRecords.map(r => [r.id, r]));
  const earlier = c && records.get(c.earlier); const later = c && records.get(c.later);
  if (!c || !earlier || !later || !canAccess(p, earlier) || !canAccess(p, later)) throw new LineageError(404, 'Correction candidate not found.');
  if (c.status !== 'pending') throw new LineageError(409, `This candidate was already ${c.status}.`);
  const decision = String(input.decision || '');
  const note = String(input.note || '').trim();
  if (!['confirm', 'reject'].includes(decision)) throw new LineageError(400, 'Use decision "confirm" or "reject".');
  if (!note) throw new LineageError(400, 'A decision note is required.');
  if (decision === 'confirm' && input.confirm !== true) throw new LineageError(400, 'Confirming a correction supersedes the earlier record and requires explicit confirmation (confirm: true).');
  const at = new Date().toISOString();
  if (decision === 'confirm') {
    if (!isActiveRecord(earlier) || !isActiveRecord(later)) throw new LineageError(409, 'One of these records has already been superseded by another version.');
    supersede(db, earlier, later, { basis: 'reviewer_confirmed', changes: c.changes, actor: p.name, note: note.slice(0, 1000), at });
  }
  Object.assign(c, { status: decision === 'confirm' ? 'confirmed' : 'rejected', decided_by: p.name, decided_at: at, note: note.slice(0, 1000) });
  lineageEvent(db, { action: decision === 'confirm' ? 'correction_confirmed' : 'correction_rejected', institution_code: later.institution_code, candidate_id: c.id, earlier: earlier.id, later: later.id, actor: p.name, note: c.note, at });
  return c;
}

// Everything a reviewer needs to follow one source record's lineage. Scope: the principal must
// be able to see the record; versions of one lineage always belong to one institution.
function lineageView(db, p, recordId) {
  const records = new Map(db.sourceRecords.map(r => [r.id, r]));
  const root = records.get(recordId);
  if (!root || !canAccess(p, root)) return null;
  const lineageId = lineageOf(root).id;
  const members = db.sourceRecords.filter(r => lineageOf(r).id === lineageId && canAccess(p, r)).sort((a, b) => lineageOf(a).version - lineageOf(b).version || String(a.imported_at).localeCompare(String(b.imported_at)));
  const ids = new Set(members.map(r => r.id));
  const ref = r => ({ record_id: r.id, version: lineageOf(r).version, relation: lineageOf(r).relation, basis: lineageOf(r).basis || null, supersedes: lineageOf(r).supersedes || null, copy_of: lineageOf(r).copy_of || null, superseded_by: r.superseded_by || null, superseded_at: r.superseded_at || null, active: isActiveRecord(r), institution_code: r.institution_code, source_file: r.source_file, source_row: r.source_row, import_id: r.import_id || null, imported_at: r.imported_at || null, source_reference: r.source_reference || null, changes: lineageOf(r).changes || [] });
  const touching = f => f.evidence.some(id => ids.has(id));
  const visible = f => f.evidence.every(id => records.get(id) && canAccess(p, records.get(id)));
  const findings = db.findings.filter(f => touching(f) && visible(f));
  const brief = f => ({ id: f.id, rule_code: f.rule_code, title: f.title, review_status: f.review_status, lifecycle_status: f.lifecycle_status || 'current', lifecycle_reason: f.lifecycle_reason || null });
  return {
    lineage_id: lineageId, current_record_id: (members.find(r => isActiveRecord(r) && lineageOf(r).relation !== 'unchanged_copy') || members.find(isActiveRecord) || root).id,
    versions: members.map(ref),
    findings_resolved_by_correction: findings.filter(f => f.lifecycle_status === 'cleared' && f.lifecycle_cause === 'correction').map(brief),
    findings_open: findings.filter(f => (!f.lifecycle_status || f.lifecycle_status === 'current') && f.review_status !== 'resolved').map(brief),
    identity_decisions: Object.values(db.matchDecisions || {}).filter(d => d.records.some(id => ids.has(id))).map(d => ({ decision: d.decision, reviewer: d.reviewer, at: d.at, note: d.note, records: d.records, applies_to_current_evidence: d.records.every(id => records.get(id) && isActiveRecord(records.get(id))) })),
    candidates: (db.correctionCandidates || []).filter(c => ids.has(c.earlier) || ids.has(c.later)).filter(c => [c.earlier, c.later].every(id => records.get(id) && canAccess(p, records.get(id)))).map(c => ({ ...c })),
    events: (db.lineageEvents || []).filter(e => [e.earlier, e.later].some(id => ids.has(id))).sort((a, b) => String(b.at).localeCompare(String(a.at)))
  };
}

function listCorrectionCandidates(db, p, status = 'pending') {
  const records = new Map(db.sourceRecords.map(r => [r.id, r]));
  const brief = r => ({ record_id: r.id, institution_code: r.institution_code, source_file: r.source_file, source_row: r.source_row, import_id: r.import_id || null, imported_at: r.imported_at || null, active: isActiveRecord(r) });
  return (db.correctionCandidates || [])
    .filter(c => (!status || c.status === status) && [c.earlier, c.later].every(id => records.get(id) && canAccess(p, records.get(id))))
    .map(c => ({ ...c, earlier_record: brief(records.get(c.earlier)), later_record: brief(records.get(c.later)) }));
}

module.exports = { LINEAGE_FIELDS, lineageOf, compareVersions, assignLineage, decideCorrection, lineageView, listCorrectionCandidates, LineageError };
