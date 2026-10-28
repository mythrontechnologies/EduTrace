const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const { loadDemo, saveDemo, resetDemo } = require('./src/seed'); const { FIELD_DEFINITIONS, REQUIRED, CAPACITY_RULE, mask, schemaSuggestion, validate, canAccess, transition, isCurrent, capacityState, sameEvidence, byId } = require('./src/engine'); const { suggestMapping, recordFromMapping, rowOutcome, commitImport, revalidate, processAll } = require('./src/pipeline'); const { automationSummary, OUTCOMES } = require('./src/automation'); const { createProvider } = require('./src/ai-provider'); const { assistFinding, deterministicAssist } = require('./src/assist'); const { listMatches, matchDetail, decideMatch, explainMatch, profile, MatchError } = require('./src/matches'); const { lineageView, listCorrectionCandidates, decideCorrection, LineageError } = require('./src/lineage'); const { identityHistory, listRecords, recordDetail } = require('./src/history'); const { decisionFor } = require('./src/matches'); const { resolveMode, assertProductionReady, StartupError } = require('./src/mode'); const { createDemoStore, ReadOnlyError } = require('./src/demo-data'); const { integrityGraph } = require('./src/graph'); const { assessFinding } = require('./src/assessment'); const { routeRule, AuthError, demoHeaderAuthenticator, authFromEnv } = require('./src/auth'); const { securityHeaders, createRateLimiter, rateBucket, DEFAULT_LIMITS } = require('./src/security'); const { noneAdapter, integrationsFromEnv } = require('./src/integrations'); const { StoreError, createPostgresStore } = require('./src/pg-store'); const { apaarStatus, consentFor, verifyIdentifier, recordConsent, ConsentError } = require('./src/apaar'); const { maskPII, revealsPII, maskName, maskValue } = require('./src/pii'); const { simulateCorrection, evidenceChecklist, LabError } = require('./src/evidence-lab'); const { matchDecisionReceipt, findingDecisionReceipt, correctionDecisionReceipt, verifyReceipt, LIMITATIONS: RECEIPT_LIMITATIONS } = require('./src/receipts'); const { allowedFinding } = require('./src/engine');
const { deterministic, isDemoStore } = require('./src/demo-data');
const { dataPath } = require('./src/seed');
const { CONFIRMATION: EMPTY_IMPORT_CONFIRMATION, InitializationError, createEmptyImportDataset } = require('./src/empty-import');
const { validateAccount } = require('./src/accounts');
const { createSyntheticTestStore, syntheticTestAuthenticator, validateSyntheticCsv, importFingerprint, TEST_INSTITUTIONS } = require('./src/synthetic-test');
let provider = createProvider();
function setProvider(next) { provider = next; }
const ROOT = __dirname; const MAX_BODY = 2 * 1024 * 1024; const MAX_ROWS = 5000;
const CANONICAL_FIELDS = new Set(FIELD_DEFINITIONS.map(field => field.key));
const STATIC_FILES = { '/': ['index.html', 'text/html; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/reconciliation.js': ['reconciliation.js', 'text/javascript; charset=utf-8'], '/import.js': ['import.js', 'text/javascript; charset=utf-8'], '/graph.js': ['graph.js', 'text/javascript; charset=utf-8'], '/matches.js': ['matches.js', 'text/javascript; charset=utf-8'], '/profile.js': ['profile.js', 'text/javascript; charset=utf-8'], '/history.js': ['history.js', 'text/javascript; charset=utf-8'], '/lab.js': ['lab.js', 'text/javascript; charset=utf-8'] };
function sendResponse(res, status, body, type = 'application/json', extra = {}) { res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...securityHeaders(type, body), ...extra }); res.end(type === 'application/json' ? JSON.stringify(body) : body); }
function csv(value) { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; }
function publicFinding(f, db, p) { const records = f.evidence.map(id => byId(db.sourceRecords, id)).filter(Boolean).filter(r => canAccess(p, r)); const linkIds = new Set(f.identity_link_ids || []); const links = (linkIds.size ? db.identityLinks || [] : []).filter(l => linkIds.has(l.id)).map(({ id, method, score, name_similarity, agreeing_fields, conflicting_fields, missing_fields, context, outcome, reason, policy_version, records: linkRecords }) => ({ id, method, score, name_similarity, agreeing_fields, conflicting_fields, missing_fields, context, outcome, reason, policy_version, records: linkRecords })); return { ...f, assessment: assessFinding(db, f, p), identity_links: links, records: records.map(r => ({ id: r.id, source_file: r.source_file, source_row: r.source_row, institution_code: r.institution_code, programme: r.programme, academic_session: r.academic_session, enrolment_status: r.enrolment_status, student_name: r.student_name, apaar_id: mask(r.apaar_id), date_of_birth: r.date_of_birth, transformations: r.transformations, source_reference: r.source_reference || null, superseded_by: r.superseded_by || null, lineage: r.lineage ? { version: r.lineage.version, relation: r.lineage.relation, supersedes: r.lineage.supersedes || null, copy_of: r.lineage.copy_of || null } : null, processing: r.processing ? { status: r.processing.status, normalisations: r.processing.normalisations, identifier_check: r.processing.identifier_check, authoritative_verification: r.processing.authoritative_verification } : null })) }; }
const HOSTED_DEMO_PRIVATE_FIELDS = new Set([
  'audit', 'auditevents', 'audittrail', 'history', 'matchhistory', 'timeline',
  'decision', 'decisions', 'decisionhistory', 'reviewer', 'reviewername', 'reviewerid', 'reviewedby',
  'actor', 'actorname', 'actorid', 'note', 'reviewernote', 'internalnote', 'comment', 'comments', 'internalcomment',
  'receipt', 'receiptid', 'receiptidentifier', 'ai', 'aistatus', 'assist', 'assistance', 'candidateassessment',
  'model', 'modelassessment', 'modelmetadata', 'provenance', 'cachekey', 'provider', 'health', 'datapolicy',
  'modelunavailablereason', 'sentfields', 'configured'
]);
// These fields describe a reviewer outcome (or the fact that one exists), even when their
// values are phrased as a label, action, or explanation rather than named "decision".
const HOSTED_DEMO_DECISION_FIELDS = new Set([
  'resolution', 'resolutionlabel', 'recommendedaction', 'recommendation', 'nextaction',
  'basis', 'findingreviewstatus', 'reviewstatus', 'currentstatus', 'decisionstatus'
]);
const HOSTED_DEMO_NEUTRAL_TEXT = 'Details are omitted in the hosted demo.';
const REVIEW_DECISION_TEXT = /\b(?:reviewer|reviewers|review)\b.{0,100}\b(?:decision|decided|recorded|confirmed|rejected|same person|different people|needs more evidence)\b|\b(?:decision|decided|recorded|confirmed|rejected)\b.{0,100}\b(?:reviewer|reviewers|same person|different people)\b|\b(?:same person|different people|needs more evidence)\s*\(reviewer\)/i;
function hostedDemoResponse(value) {
  if (Array.isArray(value)) return value.map(hostedDemoResponse);
  if (typeof value === 'string') return REVIEW_DECISION_TEXT.test(value) ? HOSTED_DEMO_NEUTRAL_TEXT : value;
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, item]) => {
      const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]/g, '');
      const decisionState = ['same_person', 'different_person', 'needs_more_evidence', 'needs_review', 'resolved', 'awaiting_verification'].includes(String(item));
      return !HOSTED_DEMO_PRIVATE_FIELDS.has(normalized) && !HOSTED_DEMO_DECISION_FIELDS.has(normalized) && !normalized.startsWith('decision') && !normalized.startsWith('audit')
        && !normalized.includes('reviewer') && !normalized.includes('actor') && !normalized.includes('receipt')
        && !normalized.includes('note') && !normalized.includes('comment') && !normalized.includes('history') && !normalized.includes('timeline')
        && !normalized.startsWith('model') && !normalized.startsWith('assist') && !normalized.startsWith('provenance')
        && !normalized.startsWith('cache') && !normalized.startsWith('provider') && !normalized.startsWith('ai')
        && !normalized.includes('health') && !(normalized === 'status' && decisionState);
    })
    .map(([key, item]) => [key, hostedDemoResponse(item)]));
}
function hostedDashboardSummary(data) {
  const { pending_decisions, open_findings, by_status, automation, metric_definitions, ...safe } = data;
  // `automatic_rate` is defined as records with no open finding, so it changes when
  // reviewer outcomes change even though it is presented as a processing metric.
  const { open_exceptions, automatic_rate, rate_definition, automatically_resolved, ...safeAutomation } = automation;
  const { pending_decisions: pendingDefinition, open_findings: openDefinition, ...safeDefinitions } = metric_definitions;
  return { ...safe, metric_definitions: safeDefinitions, automation: safeAutomation };
}
function hostedAutomationSummary(data) {
  const { open_exceptions, automatic_rate, rate_definition, automatically_resolved, ...safe } = data;
  return safe;
}
function hostedLineageView(data) {
  const { findings_resolved_by_correction, findings_open, identity_decisions, candidates, events, ...safe } = data;
  return safe;
}
// Reviewer decisions and correction confirmations alter relationships and active-record counts,
// even after their fields are removed from JSON. Hosted readers therefore query one cached,
// decision-independent read model derived from the synthetic source records. This model keeps all
// source rows visible, resets reviewer-controlled lineage and findings, then recomputes neutral
// processing and matching data through the normal pipeline. It is never used by other modes.
function hostedDecisionIndependentDataset(source) {
  const db = structuredClone(source);
  for (const record of db.sourceRecords || []) {
    delete record.superseded_by;
    delete record.superseded_at;
    delete record.processing;
    record.lineage = { id: record.id, version: 1, relation: 'original' };
  }
  db.findings = [];
  db.auditEvents = [];
  db.identityLinks = [];
  db.identityLinkEvents = [];
  db.matchDecisions = {};
  db.correctionCandidates = (db.correctionCandidates || []).map(candidate => {
    const { decided_by, decided_at, note, ...safe } = candidate;
    return { ...safe, status: 'pending' };
  });
  db.lineageEvents = [];
  db.notifications = [];
  db.notificationRegistry = {};
  db.automationRuns = [];
  db.decisionReceipts = [];
  deterministic(() => processAll(db, {
    at: '2026-10-20T09:00:00.000Z',
    reason: 'Hosted synthetic read model',
    origin: 'hosted_demo'
  }));
  return db;
}
function scopeFor(db, p) { return { record: r => canAccess(p, r), batch: b => (p.role === 'regulator' || p.scope === 'all') || b.institution_code === p.institution_code, finding: f => allowedFinding(f, db, p) }; }
function visibleNotifications(db, p) { const findings = new Map(db.findings.map(f => [f.id, f])); return (db.notifications || []).filter(n => (p.role === 'regulator' || p.scope === 'all') || n.institution_code === p.institution_code).map(n => { const items = n.items.filter(item => item.finding_id ? findings.has(item.finding_id) && allowedFinding(findings.get(item.finding_id), db, p) : (p.role === 'regulator' || p.scope === 'all') || item.institutions.every(code => code === p.institution_code)).map(item => { const f = item.finding_id && findings.get(item.finding_id); return { ...item, current: f ? { review_status: f.review_status, lifecycle_status: f.lifecycle_status || 'current', processing_status: f.automation?.outcome || null, superseded_by: f.superseded_by || null } : { review_status: null, lifecycle_status: null, processing_status: 'processing_failed', superseded_by: null } }; }); return { ...n, items }; }).filter(n => n.items.length).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); }
function searchText(value) { return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN'); }
function lifecycleScope(url) { const value = url.searchParams.get('lifecycle'); return ['historical', 'all'].includes(value) ? value : 'current'; }
function findingsQuery(db, p, url) { const visible = db.findings.filter(f => allowedFinding(f, db, p)); const lifecycle = lifecycleScope(url); const accessible = visible.filter(f => lifecycle === 'all' || (lifecycle === 'current') === isCurrent(f)); const recordsFor = finding => finding.evidence.map(id => byId(db.sourceRecords, id)).filter(Boolean).filter(r => canAccess(p, r)); const q = searchText(url.searchParams.get('q')).slice(0, 160); const requested = Object.fromEntries(['institution', 'category', 'severity', 'status', 'session', 'batch'].map(key => [key, searchText(url.searchParams.get(key))])); const matches = accessible.filter(f => { const records = recordsFor(f); if (requested.severity && searchText(f.severity) !== requested.severity) return false; if (requested.status && searchText(f.review_status) !== requested.status) return false; if (requested.category && !requested.category.split(',').some(c => c.trim() && (searchText(f.category) === c.trim() || searchText(f.rule_code) === c.trim()))) return false; if (requested.session && !records.some(r => searchText(r.academic_session) === requested.session)) return false; if (requested.batch && !records.some(r => searchText(r.import_id) === requested.batch || searchText(r.source_file) === requested.batch)) return false; if (requested.institution && !records.some(r => { const institution = db.institutions.find(i => i.code === r.institution_code); return searchText(r.institution_code) === requested.institution || searchText(institution?.name) === requested.institution; })) return false; if (!q) return true; const haystack = [f.id, f.title, f.rule_code, f.category, ...records.flatMap(r => { const institution = db.institutions.find(i => i.code === r.institution_code); return [r.student_name, r.institution_code, institution?.name, r.programme, String(r.source_row), r.academic_session, r.import_id, r.source_file, mask(r.apaar_id)]; })].map(searchText).join(' '); return haystack.includes(q); }); const severityCounts = items => ['high', 'medium', 'low'].map(severity => ({ severity, count: items.filter(f => f.severity === severity).length })); const scopedRecords = db.sourceRecords.filter(r => canAccess(p, r)); const accessibleBatches = new Set(scopedRecords.map(r => r.import_id).filter(Boolean)); const accessibleInstitutions = new Set(scopedRecords.map(r => r.institution_code)); const categories = [...new Set(accessible.flatMap(f => [f.category, f.rule_code]).filter(Boolean))].sort(); return { data: matches.map(f => publicFinding(f, db, p)), total: matches.length, accessible_total: accessible.length, lifecycle, lifecycle_counts: { current: visible.filter(isCurrent).length, historical: visible.filter(f => !isCurrent(f)).length }, by_severity: severityCounts(matches), accessible_by_severity: severityCounts(accessible), filter_options: { institutions: db.institutions.filter(i => accessibleInstitutions.has(i.code)).map(i => ({ code: i.code, name: i.name })), categories, severities: [...new Set(accessible.map(f => f.severity))].sort(), statuses: [...new Set(accessible.map(f => f.review_status))].sort(), sessions: [...new Set(scopedRecords.map(r => r.academic_session).filter(Boolean))].sort(), batches: [...accessibleBatches].sort(), source_files: [...new Set(scopedRecords.map(r => r.source_file).filter(Boolean))].sort(), lifecycles: ['current', 'historical', 'all'] } }; }
function summary(db, p) { const rows = db.sourceRecords.filter(r => canAccess(p, r)); const visible = db.findings.filter(f => allowedFinding(f, db, p)); const findings = visible.filter(isCurrent); const seededBatchIds = new Set(db.importBatches.filter(batch => batch.seeded === true).map(batch => batch.id)); const seeded_fixture_records = rows.filter(row => seededBatchIds.has(row.import_id)).length; const session_imported_records = rows.length - seeded_fixture_records; const count = code => findings.filter(f => f.rule_code === code).length; const bySeverity = ['high','medium','low'].map(severity => ({ severity, count: findings.filter(f => f.severity === severity).length })); return { institutions: (p.role === 'regulator' || p.scope === 'all') ? db.institutions.length : 1, imported_records: rows.length, seeded_fixture_records, session_imported_records, active_enrolments: rows.filter(r => r.enrolment_status === 'active').length, validation_issues: findings.filter(f => f.category === 'identifier').length, duplicate_groups: count('DUPLICATE_IDENTIFIER') + count('IDENTIFIER_ATTRIBUTE_CONFLICT'), identifier_issues: count('APAAR_MISSING') + count('APAAR_MALFORMED'), concurrent_findings: count('POTENTIAL_CONCURRENT_ENROLMENT'), capacity_alerts: count('DEMO_INTAKE_LIMIT_EXCEEDED'), pending_decisions: findings.filter(f => f.review_status === 'pending').length, open_findings: findings.filter(f => f.review_status !== 'resolved').length, accessible_findings: findings.length, by_severity: bySeverity, by_status: ['pending', 'awaiting_verification', 'resolved'].map(status => ({ status, count: findings.filter(f => f.review_status === status).length })), by_rule: [...new Set(findings.map(f => f.rule_code))].map(rule_code => ({ rule_code, category: findings.find(f => f.rule_code === rule_code).category, count: count(rule_code) })).sort((a, b) => b.count - a.count || a.rule_code.localeCompare(b.rule_code)), historical_findings: visible.length - findings.length, automation: automationSummary(db, scopeFor(db, p)), capacity: db.capacityRules.filter(rule => canAccess(p, rule)).map(rule => { const state = capacityState(db.sourceRecords, rule); return { ...rule, seat_category: state.seat_category, condition_key: state.key, observed_active: state.observed_active, exceeded: state.exceeded, current_finding_id: findings.find(f => f.rule_code === CAPACITY_RULE && f.condition_key === state.key)?.id || null }; }), severity_total: bySeverity.reduce((total, item) => total + item.count, 0), metric_definitions: { imported_records: 'Persisted source records accessible to the current principal.', seeded_fixture_records: 'Records from the generated synthetic baseline in the current institution.', session_imported_records: 'Records imported during this server session in the current institution.', validation_issues: 'Current identifier and required-field findings accessible to the current principal, regardless of review status.', pending_decisions: 'Current accessible findings with review status pending and no recorded reviewer outcome.', open_findings: 'Current accessible findings without a final outcome: pending review or awaiting verification. Resolved and historical findings are excluded.', severity_total: 'All current accessible findings grouped by severity; this total equals accessible findings.', accessible_findings: 'Current (actionable) findings. Superseded or cleared capacity findings are historical and counted separately.', capacity: 'Active enrolments counted once per student identity (protected identifier, name and date of birth; records without an identifier are never merged, but an identical resubmitted row is not counted twice) using the most recent source record, against a configured prototype limit.' } }; }
function auditFeed(db, p, url) { const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200); const events = db.auditEvents.map(event => ({ event, finding: byId(db.findings, event.finding_id) })).filter(({ event, finding }) => finding ? allowedFinding(finding, db, p) : event.action === 'empty_import_initialized' && p.capabilities?.includes('audit.read') || event.action === 'import_batch_committed' && ((p.role === 'regulator' || p.scope === 'all') || event.institution_code === p.institution_code)).sort((a, b) => String(b.event.at).localeCompare(String(a.event.at))); return { data: events.slice(0, limit).map(({ event, finding }) => { const records = finding ? finding.evidence.map(id => byId(db.sourceRecords, id)).filter(Boolean) : []; return { ...event, finding_title: finding?.title || null, rule_code: finding?.rule_code || null, severity: finding?.severity || null, review_status: finding?.review_status || null, records_count: records.length, record_context: records.slice(0, 2).map(r => ({ institution_code: r.institution_code, source_row: r.source_row, student_name: r.student_name, source_file: r.source_file })) }; }), total: events.length }; }
function importHistory(db, p) { const visible = db.importBatches.filter(batch => (p.role === 'regulator' || p.scope === 'all') || batch.institution_code === p.institution_code); return { data: visible.map(({ row_outcomes, ...batch }) => ({ ...batch, seeded: batch.seeded === true || !row_outcomes })).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || a.id.localeCompare(b.id)), institutions: db.institutions.filter(i => (p.role === 'regulator' || p.scope === 'all') || i.code === p.institution_code).map(i => ({ code: i.code, name: i.name })) }; }
function maskedSample(value) { const s = String(value ?? '').trim(); return /^[\d\s-]{8,}$/.test(s) ? mask(s.replace(/[\s-]/g, '')) : s.slice(0, 60); }
function parseCsv(text) { const input = String(text ?? '').replace(/^\uFEFF/, ''); if (!input.trim()) throw new Error('CSV must include a header row and at least one data row.'); const rows = [[]]; let field = ''; let quoted = false; let quoteClosed = false; for (let i = 0; i < input.length; i++) { const c = input[i]; if (quoted) { if (c === '"' && input[i + 1] === '"') { field += '"'; i++; } else if (c === '"') { quoted = false; quoteClosed = true; } else field += c; } else if (c === '"') { if (field || quoteClosed) throw new Error('Malformed CSV: quote must begin a field.'); quoted = true; } else if (c === ',') { rows.at(-1).push(field); field = ''; quoteClosed = false; } else if (c === '\n' || c === '\r') { if (c === '\r' && input[i + 1] === '\n') i++; rows.at(-1).push(field); field = ''; quoteClosed = false; rows.push([]); } else { if (quoteClosed) throw new Error('Malformed CSV: unexpected character after a quoted field.'); field += c; } } if (quoted) throw new Error('Malformed CSV: unclosed quoted field.'); if (field || rows.at(-1).length) rows.at(-1).push(field); if (!rows.at(-1).length) rows.pop(); if (rows.length < 2) throw new Error('CSV must include a header row and at least one data row.'); const headers = rows[0].map(h => h.trim()); if (headers.length === 1 && /[;\t]/.test(headers[0])) throw new Error("Malformed CSV: only comma-separated CSV is supported. Export the file with commas between columns."); if (headers.some(h => !h) || new Set(headers).size !== headers.length) throw new Error('CSV headers must be non-empty and unique.'); const bodyRows = rows.slice(1).map((row, index) => ({ row, row_number: index + 2 })).filter(x => x.row.some(v => v.trim())); if (!bodyRows.length) throw new Error('CSV must include a non-empty data row.'); if (bodyRows.length > MAX_ROWS) throw new Error(`CSV exceeds the ${MAX_ROWS}-row prototype limit.`); if (bodyRows.some(({ row }) => row.length > headers.length)) throw new Error('Malformed CSV: row contains more fields than the header.'); return { headers, rows: bodyRows.map(({ row }) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']))), row_numbers: bodyRows.map(x => x.row_number) }; }
function validMapping(mapping, headers) { if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Column mapping must be an object.'); const safe = {}; for (const [canonical, source] of Object.entries(mapping)) { if (!CANONICAL_FIELDS.has(canonical) || typeof source !== 'string' || !headers.includes(source)) throw new Error('Column mapping contains an unsupported field or unknown source header.'); safe[canonical] = source; } return safe; }
function requiredMappingIssues(mapping) { return REQUIRED.filter(field => !mapping[field]); }
function body(req, maxBytes = MAX_BODY, tooLargeMessage = 'Upload exceeds 2 MB prototype limit.') { return new Promise((resolve, reject) => { const chunks = []; let bytes = 0; let failed = false; req.on('data', c => { if (failed) return; const chunk = Buffer.isBuffer(c) ? c : Buffer.from(c); bytes += chunk.length; if (bytes > maxBytes) { failed = true; const error = new Error(tooLargeMessage); error.code = 'body_too_large'; reject(error); return; } chunks.push(chunk); }); req.on('end', () => { if (failed) return; try { const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); resolve(JSON.parse(text || '{}')); } catch { reject(new Error('Request body must be valid JSON encoded as UTF-8.')); } }); const abort = () => { if (failed) return; failed = true; reject(new Error('Request body could not be read: the upload was interrupted.')); }; req.on('error', abort); req.on('aborted', abort); }); }
function syntheticImportInput(input, principal, { allowIncomplete = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('CSV request must be a JSON object.');
  if (typeof input.filename !== 'string' || !/^synthetic[-_].+\.csv$/i.test(input.filename)) throw new Error('CSV filename must begin with “synthetic-” and end with .csv.');
  if (input.multi_institution === true || (input.institution_code && String(input.institution_code).toUpperCase() !== principal.institution_code)) {
    const error = new Error('CSV institution selection does not match the authenticated synthetic test institution.'); error.status = 403; throw error;
  }
  const parsed = parseCsv(String(input.csv || ''));
  const proposed = input.mapping && Object.keys(input.mapping).length ? input.mapping : schemaSuggestion(parsed.headers);
  const mapping = validMapping(proposed, parsed.headers);
  const missingMappings = requiredMappingIssues(mapping);
  if (missingMappings.length && !allowIncomplete) { const error = new Error(`Map all required columns before import: ${missingMappings.join(', ')}.`); error.status = 400; error.fields = missingMappings; throw error; }
  if (missingMappings.length) {
    const eachRowHasSyntheticName = parsed.rows.every(row => Object.values(row).some(value => /^Synthetic\s/.test(String(value || '').trim())));
    const eachRowHasScope = parsed.rows.every(row => Object.values(row).some(value => String(value || '').trim().toUpperCase() === principal.institution_code));
    if (!eachRowHasSyntheticName || !eachRowHasScope) throw new Error('CSV rows must contain a Synthetic student name and the selected synthetic institution code before column mapping.');
  } else validateSyntheticCsv(parsed, mapping, principal.institution_code);
  return { parsed, mapping, filename: input.filename, missingMappings };
}
function syntheticPreview(data, db, principal, provider) {
  const { parsed, mapping } = data;
  if (data.missingMappings.length) return { data: { headers: parsed.headers, header_samples: Object.fromEntries(parsed.headers.map(h => [h, 'Hidden until required synthetic columns are mapped'])), fields: FIELD_DEFINITIONS, mapping, mapped_fields: Object.keys(mapping), unmapped_required_fields: data.missingMappings, sample: [], total_rows: parsed.rows.length, mapping_sources: Object.fromEntries(Object.keys(mapping).map(k => [k, 'manual'])), mapping_ambiguous: [], model_assistance: { available: provider.status().tasks.schema_interpretation.available, used: false, note: 'Synthetic test mode does not send data to a model.' }, dry_run: null } };
  const canonical = parsed.rows.slice(0, 10).map(row => recordFromMapping(row, mapping));
  const known = new Set(db.institutions.map(item => item.code));
  const outcomes = parsed.rows.map((row, i) => rowOutcome(recordFromMapping(row, mapping), parsed.row_numbers[i], principal.institution_code, false, known));
  const dryRun = { batch_institution: principal.institution_code, multi_institution: false, ready: outcomes.filter(o => o.outcome === 'imported' && !o.validation_issues.length).length, with_warnings: outcomes.filter(o => o.outcome === 'imported' && o.validation_issues.length).length, rejected: outcomes.filter(o => o.outcome === 'rejected').length, skipped: outcomes.filter(o => o.outcome === 'skipped').length, attention: outcomes.filter(o => o.outcome !== 'imported' || o.validation_issues.length).slice(0, 100) };
  return { data: { headers: parsed.headers, header_samples: Object.fromEntries(parsed.headers.map(h => { const kind = mapping.student_name === h ? 'name' : mapping.date_of_birth === h ? 'dob' : mapping.apaar_id === h ? 'id' : null; const sample = maskedSample(parsed.rows.find(row => String(row[h] ?? '').trim())?.[h]); return [h, kind && sample ? maskValue(kind, sample, false) : sample]; })), fields: FIELD_DEFINITIONS, mapping, mapped_fields: Object.keys(mapping), unmapped_required_fields: [], sample: canonical.map((r, i) => ({ row: parsed.row_numbers[i], name: r.student_name ? maskName(r.student_name) : 'Unmapped student name', apaar: mask(r.apaar_id), institution_code: principal.institution_code, programme: r.programme, academic_session: r.academic_session, enrolment_status: r.enrolment_status, issues: validate(r), outcome: outcomes[i] })), total_rows: parsed.rows.length, mapping_sources: Object.fromEntries(Object.keys(mapping).map(k => [k, 'manual'])), mapping_ambiguous: [], model_assistance: { available: provider.status().tasks.schema_interpretation.available, used: false, note: 'Mapping supplied by the user.' }, dry_run: dryRun } };
}
function syntheticImportResult(batch) {
  const auto = batch.automation.automatically_processed + batch.automation.automatically_normalised + batch.automation.safely_matched;
  return { data: batch, message: `${batch.rows_detected} rows detected: ${batch.imported} imported, ${batch.rejected} rejected, ${batch.skipped} skipped; ${batch.findings_created} findings created (${batch.validation_findings_created} validation); ${auto} of ${batch.imported} imported rows processed automatically${batch.capacity_findings_superseded || batch.capacity_findings_cleared ? `; capacity findings: ${batch.capacity_findings_superseded} superseded, ${batch.capacity_findings_cleared} cleared` : ''}.` };
}
// The JSON file store: development, and the tests through EDUTRACE_DB_PATH.
const developmentStore = Object.freeze({ kind: 'json-file', readOnly: false, load: loadDemo, save: saveDemo, reset: resetDemo });
const READ_METHODS = new Set(['GET', 'HEAD']);
const READ_ONLY = Object.freeze({ error: 'This is a read-only demo. Changes are disabled on the server and nothing was saved.', code: 'read_only_demo', mode: 'demo' });
// One handler for every mode. The mode, the data store and the model provider are fixed when the app is created.
function createApp({ mode = 'development', store = developmentStore, getProvider = () => provider, auth = demoHeaderAuthenticator(), limits = DEFAULT_LIMITS, serializeWrites = true, integrations = noneAdapter() } = {}) {
if (auth.kind === 'hosted_demo' && (mode !== 'demo' || !isDemoStore(store))) {
  throw new StartupError('Hosted demo authentication requires demo mode and the recognized synthetic in-memory store.');
}
const readOnly = mode === 'demo';
const syntheticTest = mode === 'synthetic-test';
const limiter = createRateLimiter(limits);
const registrationLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, write: 5 });
const registrationEnabled = mode === 'demo' && store.kind === 'memory' && store.readOnly === true && auth.kind === 'local' && typeof auth.registerReviewer === 'function';
// Requests that may write run one at a time, so two overlapping writes cannot each save a stale copy (lost update).
let writes = Promise.resolve();
let hostedReadModel = null;
const server = http.createServer((req, res) => {
  if (!serializeWrites || READ_METHODS.has(req.method)) return handle(req, res);
  const run = writes.then(() => handle(req, res)); writes = run.catch(() => {}); return run;
});
server.limiter = limiter;
return server;
async function handle(req, res) {
  // Every JSON response is masked here (src/pii.js). Full names and dates of birth only on record-level views, for pii.read.
  let revealPII = false; let hostedViewer = false;
  const send = (res, status, body, type = 'application/json', extra = {}) => {
    const masked = type === 'application/json' ? maskPII(body, { reveal: revealPII }) : body;
    return sendResponse(res, status, type === 'application/json' && hostedViewer ? hostedDemoResponse(masked) : masked, type, extra);
  };
  try { const url = new URL(req.url, `http://${req.headers.host}`);
  // Liveness probe for hosting platforms: answered before the database is loaded, so it never reads, seeds or migrates data and reveals nothing about configuration.
  if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok' });
  // Demo dataset writes are rejected before the principal, body or data is touched. Only fixed,
  // non-data authentication requests are exempt: login/logout, plus opt-in local registration.
  if (url.pathname.startsWith('/api/')) {
    const bucket = rateBucket(req.method, url.pathname); const wait = limiter.take(req.socket?.remoteAddress || 'local', bucket);
    if (wait) return send(res, 429, { error: 'Too many requests. Try again shortly.', code: 'rate_limited', bucket }, 'application/json', { 'Retry-After': String(wait) });
  }
  const demoAuthWrite = req.method === 'POST' && (
    auth.kind === 'hosted_demo' && ['/api/v1/auth/login', '/api/v1/auth/logout'].includes(url.pathname) ||
    registrationEnabled && ['/api/v1/auth/login', '/api/v1/auth/logout', '/api/v1/auth/register'].includes(url.pathname)
  );
  if (readOnly && !READ_METHODS.has(req.method) && !demoAuthWrite) return send(res, 403, READ_ONLY);
  if (syntheticTest && !READ_METHODS.has(req.method) && !(req.method === 'POST' && ['/api/v1/imports/preview', '/api/v1/imports/confirm'].includes(url.pathname))) return send(res, 403, { error: 'Only CSV preview and import confirmation are enabled in the ephemeral synthetic test mode.', code: 'synthetic_test_write_rejected' });
  // Every API write takes JSON. Any other declared type is refused, which also stops cross-site form posts.
  const contentType = String(req.headers['content-type'] || '');
  if (contentType && req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(contentType)) return send(res, 415, { error: 'Send JSON with Content-Type: application/json.', code: 'unsupported_media_type' });
  // Institution sign-in (local accounts, src/accounts.js). Only the local authenticator has these.
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/login') {
    if (!auth.login) return send(res, 404, { error: 'Not found.' });
    if (auth.kind === 'hosted_demo') {
      const origin = req.headers.origin;
      if (origin) { try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Sign-in must be submitted from this site.', code: 'cross_origin' }); } catch { return send(res, 403, { error: 'Sign-in must be submitted from this site.', code: 'cross_origin' }); } }
      if (!/^application\/json\s*(;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Send JSON with Content-Type: application/json.', code: 'unsupported_media_type' });
    }
    const out = await auth.login(req, await body(req));
    const headers = { 'Cache-Control': 'no-store', ...(out.setCookie ? { 'Set-Cookie': out.setCookie } : {}), ...(out.retryAfter ? { 'Retry-After': String(out.retryAfter) } : {}) };
    return send(res, out.status, out.body, 'application/json', headers);
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/auth/session') { const s = auth.session ? auth.session(req) : null; return send(res, 200, { data: s ? { authenticated: true, method: auth.kind, ...s } : { authenticated: false, method: auth.kind } }, 'application/json', { 'Cache-Control': 'no-store' }); }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/register') {
    if (!registrationEnabled) return send(res, 404, { error: 'Not found.' });
    const wait = registrationLimiter.take(req.socket?.remoteAddress || 'local', 'write');
    if (wait) return send(res, 429, { error: 'Too many registration attempts. Try again later.', code: 'rate_limited' }, 'application/json', { 'Retry-After': String(wait) });
    const origin = req.headers.origin;
    if (origin) {
      try { if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Registration must be submitted from this site.', code: 'cross_origin' }); }
      catch { return send(res, 403, { error: 'Registration must be submitted from this site.', code: 'cross_origin' }); }
    }
    let input;
    try { input = await body(req, 16 * 1024, 'Registration request exceeds the 16 KB limit.'); }
    catch (error) { if (error.code === 'body_too_large') return send(res, 413, { error: error.message, code: error.code }); throw error; }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, { error: 'Registration details must be a JSON object.' });
    const fields = new Set(['institution', 'full_name', 'username', 'password', 'confirm_password']);
    if (Object.keys(input).some(key => !fields.has(key))) return send(res, 400, { error: 'Registration request contains unsupported fields.' });
    const institutionCode = typeof input.institution === 'string' ? input.institution.trim().toUpperCase() : '';
    if (!institutionCode) return send(res, 400, { error: 'Choose an institution from the list.' });
    const displayName = typeof input.full_name === 'string' ? input.full_name.trim() : '';
    if (!displayName || displayName.length > 120) return send(res, 400, { error: 'Enter a full name up to 120 characters.' });
    const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
    const db = await store.load({ shared: true });
    const institution = db.institutions.find(item => item.code === institutionCode);
    if (!institution) return send(res, 400, { error: 'Choose an institution from the list.' });
    try { validateAccount({ username, display_name: displayName, role: 'reviewer', institution_code: institution.code }); }
    catch (error) { return send(res, 400, { error: error.message }); }
    if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 256) return send(res, 400, { error: 'A password must be 12 to 256 characters.' });
    if (typeof input.confirm_password !== 'string' || input.confirm_password !== input.password) return send(res, 400, { error: 'Password confirmation must match exactly.' });
    try { await auth.registerReviewer({ username, display_name: displayName, institution_code: institution.code, password: input.password }); }
    catch (error) {
      if (error.message === 'That username already exists.' || error.code === '23505') return send(res, 400, { error: 'Registration could not be completed. Check your details or try another username.', code: 'registration_failed' });
      throw error;
    }
    return send(res, 201, { data: { registered: true, username } });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/runtime') {
    if (auth.kind === 'hosted_demo') return send(res, 200, { data: { mode: 'demo', read_only: true, registration_enabled: false, data_source: 'synthetic_in_memory', auth: 'hosted_demo', ai_enabled: false } }, 'application/json', { 'Cache-Control': 'no-store' });
    return send(res, 200, { data: { mode, read_only: readOnly, registration_enabled: registrationEnabled, data_source: { memory: 'synthetic_in_memory', postgres: 'postgresql', synthetic_test_memory: 'synthetic_test_in_memory' }[store.kind] || 'json_file', auth: auth.kind, dataset_fingerprint: store.fingerprint ? store.fingerprint.slice(0, 16) : null, ai_enabled: getProvider().status().configured, note: readOnly ? 'Read-only demo: synthetic records built in memory at startup. Data changes and model calls are rejected by the server.' : syntheticTest ? 'Ephemeral synthetic test environment: generated records and CSV imports exist only in localhost memory and are discarded on restart.' : null } });
  }
  const provider = getProvider();
  // Authentication, then the route's capability, before the body is read or any data is loaded.
  const rule = routeRule(req.method, url.pathname, { hostedDemo: auth.kind === 'hosted_demo' }); let p = null;
  if (!rule.public) {
    try { p = auth.authenticate(req); } catch (error) { if (!(error instanceof AuthError)) throw error; return send(res, error.status, { error: error.message, code: error.code }, 'application/json', error.status === 401 ? { 'WWW-Authenticate': `Bearer realm="edutrace", error="${error.code}"` } : {}); }
    if (!p) return send(res, 401, { error: 'Authentication required.', code: 'unauthenticated' }, 'application/json', { 'WWW-Authenticate': 'Bearer realm="edutrace"' });
    if (rule.capability && !p.capabilities.includes(rule.capability)) return send(res, 403, { error: 'Your role does not allow this action.', code: 'forbidden', capability: rule.capability });
    hostedViewer = auth.kind === 'hosted_demo' && p.role === 'hosted_demo_viewer';
    if (req.method === 'POST' && ['/api/v1/imports/preview', '/api/v1/imports/confirm'].includes(url.pathname)
      && p.scope === 'all' && !p.capabilities.includes('imports.multi_institution')) {
      return send(res, 403, { error: 'An unscoped principal needs the multi-institution import capability.', code: 'forbidden', capability: 'imports.multi_institution' });
    }
    revealPII = revealsPII(p, url.pathname);
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/institutions') {
    if (syntheticTest) return send(res, 200, { data: TEST_INSTITUTIONS.map(({ code, name }) => ({ code, name })) });
    if (!registrationEnabled) return send(res, 404, { error: 'Not found.' });
    const db = await store.load({ shared: true });
    return send(res, 200, { data: db.institutions.map(({ code, name }) => ({ code, name })) });
  }
  const saveDemo = (db, options = {}) => store.save(db, { principal: p, ...options });
  // Routes that use no stored data answer before the data is loaded (docs/PERFORMANCE_RESULTS.md).
  if (req.method === 'GET' && STATIC_FILES[url.pathname]) { const [file, type] = STATIC_FILES[url.pathname]; return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file), 'utf8'), type); }
  if (req.method === 'GET' && url.pathname === '/api/v1/ai/status') return send(res, 200, { data: provider.status() });
  if (req.method === 'POST' && url.pathname === '/api/v1/ai/check') { if (!p.capabilities?.includes('ai.check')) return send(res, 403, { error: 'Only the demo regulator can run the model health check.' }); return send(res, 200, { data: await provider.check() }); }
  if (req.method === 'POST' && url.pathname === '/api/v1/auth/logout') return send(res, 200, { data: { signed_out: true } }, 'application/json', { 'Cache-Control': 'no-store', ...(auth.logout ? { 'Set-Cookie': auth.logout(req) } : {}) });
  if (req.method === 'GET' && url.pathname === '/api/v1/integrations') return send(res, 200, { data: { adapter: integrations.kind, services: integrations.status() } });
  if (req.method === 'POST' && url.pathname === '/api/v1/admin/initialize-empty-import') {
    if (mode !== 'development' || store.kind !== 'json-file') return send(res, 409, { error: 'Empty-import initialization is supported only for the development JSON store.', code: 'unsupported_store' });
    if (!p.roles?.includes('platform_admin')) return send(res, 403, { error: 'Only a platform administrator can initialize an empty import dataset.', code: 'forbidden' });
    const input = await body(req);
    if (input.confirmation !== EMPTY_IMPORT_CONFIRMATION) return send(res, 400, { error: `Explicit confirmation is required: ${EMPTY_IMPORT_CONFIRMATION}.`, code: 'confirmation_required' });
    try {
      const result = createEmptyImportDataset({ sourcePath: dataPath(), actor: p.subject || p.name });
      return send(res, 201, { data: { database_file: path.basename(result.path), source_database_sha256: result.source_sha256, counts: result.counts, message: 'Created a new empty import dataset. The source database was retained unchanged.' } });
    } catch (error) {
      if (error instanceof InitializationError) return send(res, error.status, { error: error.message, code: error.code });
      throw error;
    }
  }
  // Reads share the store's current snapshot (a read route never changes it: test/read-routes.test.js); a request that
  // may write gets its own copy. Only the PostgreSQL store shares; the JSON and demo stores return a fresh copy either way.
  let db = await store.load({ shared: READ_METHODS.has(req.method), principal: p });
  if (hostedViewer) {
    if (!hostedReadModel) hostedReadModel = hostedDecisionIndependentDataset(db);
    db = structuredClone(hostedReadModel);
  }
  if (syntheticTest && req.method === 'POST' && url.pathname === '/api/v1/imports/preview') {
    const input = await body(req);
    const imported = syntheticImportInput(input, p, { allowIncomplete: true });
    return send(res, 200, syntheticPreview(imported, db, p, provider));
  }
  if (syntheticTest && req.method === 'POST' && url.pathname === '/api/v1/imports/confirm') {
    const input = await body(req);
    const imported = syntheticImportInput(input, p);
    const key = String(req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) return send(res, 400, { error: 'Import confirmation requires an Idempotency-Key of 8 to 128 safe characters.', code: 'idempotency_key_required' });
    const fingerprint = importFingerprint({ institution_code: p.institution_code, filename: imported.filename, csv: String(input.csv || ''), mapping: imported.mapping });
    const previous = store.lookupImport({ key, fingerprint, principal: p });
    if (previous?.conflict) return send(res, 409, { error: 'This Idempotency-Key was already used for different import content.', code: 'idempotency_conflict' });
    if (previous) return send(res, previous.status, previous.result);
    const batch = commitImport(db, { parsed: imported.parsed, mapping: imported.mapping, batchInstitution: p.institution_code, multiInstitution: false, filename: imported.filename });
    db.auditEvents.push({ id: `AUD-IMP-${batch.id}`, action: 'import_batch_committed', actor: p.subject, institution_code: p.institution_code, batch_id: batch.id, note: `${batch.imported} imported, ${batch.rejected} rejected, ${batch.skipped} skipped.`, at: batch.created_at });
    const result = syntheticImportResult(batch);
    await saveDemo(db, { idempotencyEntry: { key, institution_code: p.institution_code, fingerprint, status: 201, result } });
    return send(res, 201, result);
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/dashboard/summary') { const data = summary(db, p); return send(res, 200, { data: hostedViewer ? hostedDashboardSummary(data) : data, principal: p }); }
  if (req.method === 'GET' && url.pathname === '/api/v1/audit') return send(res, 200, auditFeed(db, p, url));
  if (req.method === 'GET' && url.pathname === '/api/v1/imports') return send(res, 200, importHistory(db, p));
  if (req.method === 'GET' && url.pathname === '/api/v1/automation') {
    const current = db.findings.filter(f => isCurrent(f) && allowedFinding(f, db, p));
    const data = { ...automationSummary(db, scopeFor(db, p)) };
    if (hostedViewer) return send(res, 200, { data: hostedAutomationSummary(data) });
    if (!hostedViewer) {
      data.ai = provider.status();
      data.assistance = {
        rule_findings: current.length,
        model_explanations: current.filter(f => f.assist?.explanation?.provenance).length,
        model_candidate_assessments: current.filter(f => f.assist?.candidate_assessment?.provenance).length,
        note: 'Every finding is raised by a deterministic rule. Model explanations exist only where a reviewer requested one and a model answered; they are stored with their model and generation time.'
      };
    }
    return send(res, 200, { data });
  }
  if (req.method === 'GET' && url.pathname === '/api/v1/matches') {
    const params = new URLSearchParams(url.searchParams);
    if (hostedViewer) params.delete('status');
    const data = listMatches(db, p, params);
    if (hostedViewer) {
      delete data.counts;
      delete data.filter_options.statuses;
      data.data.sort((a, b) => String(a.method).localeCompare(String(b.method)) || String(a.id).localeCompare(String(b.id)));
    }
    return send(res, 200, data);
  }
  const matchDecision = url.pathname.match(/^\/api\/v1\/matches\/([^/]+)\/decision$/); if (req.method === 'POST' && matchDecision) { const input = await body(req); let decided; try { decided = decideMatch(db, p, matchDecision[1], input); } catch (error) { if (error instanceof MatchError) return send(res, error.status, { error: error.message }); throw error; } matchDecisionReceipt(db, p, decided); await saveDemo(db); return send(res, 200, { data: matchDetail(db, p, matchDecision[1], provider) }); }
  const matchExplain = url.pathname.match(/^\/api\/v1\/matches\/([^/]+)\/explain$/); if (req.method === 'POST' && matchExplain) { let out; try { out = await explainMatch(db, p, matchExplain[1], provider); } catch (error) { if (error instanceof MatchError) return send(res, error.status, { error: error.message }); throw error; } if (out.changed) await saveDemo(db); return send(res, 200, { data: out.result, ai: { provider: provider.status().provider_label, model: provider.status().model, health: provider.status().health } }); }
  const matchView = url.pathname.match(/^\/api\/v1\/matches\/([^/]+)$/); if (req.method === 'GET' && matchView) { const data = matchDetail(db, p, matchView[1], provider); return data ? send(res, 200, { data }) : send(res, 404, { error: 'Potential match not found.' }); }
  if (req.method === 'GET' && url.pathname === '/api/v1/records') { const list = listRecords(db, p, url.searchParams); const byId = new Map(db.sourceRecords.map(r => [r.id, r])); list.data.forEach(row => { const r = byId.get(row.record_id || row.id); if (r) row.apaar_status = apaarStatus(db, r); }); return send(res, 200, list); }
  const history = url.pathname.match(/^\/api\/v1\/identities\/([^/]+)\/history$/); if (req.method === 'GET' && history) { const data = identityHistory(db, p, history[1], { asOf: url.searchParams.get('as_of') }); return data ? send(res, 200, { data }) : send(res, 404, { error: 'Source record not found.' }); }
  // External verification goes through one adapter; nothing is connected (src/integrations.js).
  const verification = url.pathname.match(/^\/api\/v1\/records\/([^/]+)\/verification$/); if (req.method === 'GET' && verification) { const r = db.sourceRecords.find(x => x.id === verification[1]); if (!r || !canAccess(p, r)) return send(res, 404, { error: 'Source record not found.' }); return send(res, 200, { data: verifyIdentifier(db, r, integrations) }); }
  // Basic consent: an append-only status per student lineage; verification is refused without it (src/apaar.js).
  const consent = url.pathname.match(/^\/api\/v1\/records\/([^/]+)\/consent$/); if (req.method === 'POST' && consent) { const r = db.sourceRecords.find(x => x.id === consent[1]); const input = await body(req); let entry; try { entry = recordConsent(db, p, r, input); } catch (error) { if (error instanceof ConsentError) return send(res, error.status, { error: error.message }); throw error; } await saveDemo(db); return send(res, 201, { data: { entry, consent: consentFor(db, r), apaar: apaarStatus(db, r) } }); }
  const lineage = url.pathname.match(/^\/api\/v1\/records\/([^/]+)\/lineage$/); if (req.method === 'GET' && lineage) { const data = lineageView(db, p, lineage[1]); return data ? send(res, 200, { data: hostedViewer ? hostedLineageView(data) : data }) : send(res, 404, { error: 'Source record not found.' }); }
  if (req.method === 'GET' && url.pathname === '/api/v1/corrections') {
    const status = url.searchParams.get('status');
    const list = listCorrectionCandidates(db, p, hostedViewer ? null : status === 'all' ? null : status || 'pending');
    if (hostedViewer) {
      const data = list.map(({ status: candidateStatus, decided_by, decided_at, note, ...candidate }) => candidate);
      return send(res, 200, { data });
    }
    return send(res, 200, { data: list, pending: listCorrectionCandidates(db, p, 'pending').length });
  }
  const correction = url.pathname.match(/^\/api\/v1\/corrections\/([^/]+)\/decision$/); if (req.method === 'POST' && correction) { const input = await body(req); let decided; try { decided = decideCorrection(db, p, correction[1], input); } catch (error) { if (error instanceof LineageError) return send(res, error.status, { error: error.message }); throw error; } const at = new Date().toISOString(); const run = decided.status === 'confirmed' ? processAll(db, { at, reason: 'after a confirmed correction', origin: 'correction' }) : null; correctionDecisionReceipt(db, p, decided); await saveDemo(db); return send(res, 200, { data: { candidate: decided, findings_resolved_by_correction: run ? run.changes.cleared.length : 0, findings_created: run ? run.changes.created.length : 0, lineage: lineageView(db, p, decided.later) } }); }
  const recordView = url.pathname.match(/^\/api\/v1\/records\/([^/]+)$/); if (req.method === 'GET' && recordView) { const data = recordDetail(db, p, recordView[1]); if (data) { const r = db.sourceRecords.find(x => x.id === recordView[1]); data.apaar = apaarStatus(db, r); data.consent = consentFor(db, r); if (hostedViewer && data.lineage) data.lineage = hostedLineageView(data.lineage); } return data ? send(res, 200, { data }) : send(res, 404, { error: 'Source record not found.' }); }
  const profileView = url.pathname.match(/^\/api\/v1\/profiles\/([^/]+)$/); if (req.method === 'GET' && profileView) { const data = profile(db, p, profileView[1]); return data ? send(res, 200, { data }) : send(res, 404, { error: 'Source record not found.' }); }
  if (req.method === 'GET' && url.pathname === '/api/v1/notifications') { const list = visibleNotifications(db, p); return send(res, 200, { data: list, unacknowledged: list.filter(n => !n.acknowledged).length, total: list.length }); }
  const ack = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/acknowledge$/); if (req.method === 'POST' && ack) { const n = (db.notifications || []).find(x => x.id === ack[1]); if (!n || !visibleNotifications(db, p).some(x => x.id === n.id)) return send(res, 404, { error: 'Notification not found.' }); if (!n.acknowledged) { n.acknowledged = { by: p.name, at: new Date().toISOString() }; await saveDemo(db); } return send(res, 200, { data: { id: n.id, acknowledged: n.acknowledged } }); }
  if (req.method === 'POST' && url.pathname === '/api/v1/automation/revalidate') { if (!p.capabilities?.includes('automation.revalidate')) return send(res, 403, { error: 'Only the demo regulator can re-run reconciliation for all institutions.' }); const result = revalidate(db); await saveDemo(db); return send(res, 200, { data: result }); }
  const explanation = url.pathname.match(/^\/api\/v1\/findings\/([^/]+)\/explanation$/); if (req.method === 'GET' && explanation) { const f = db.findings.find(x => x.id === explanation[1]); if (!f || !allowedFinding(f, db, p)) return send(res, 404, { error: 'Finding not found.' }); return send(res, 200, { data: deterministicAssist(db, f, provider) }); }
  const assist = url.pathname.match(/^\/api\/v1\/findings\/([^/]+)\/assist$/); if (req.method === 'POST' && assist) { const f = db.findings.find(x => x.id === assist[1]); if (!f || !allowedFinding(f, db, p)) return send(res, 404, { error: 'Finding not found.' }); const { result, changed } = await assistFinding(db, f, provider); if (changed) await saveDemo(db); return send(res, 200, { data: result }); }
  if (req.method === 'GET' && url.pathname === '/api/v1/graph') {
    const params = new URLSearchParams(url.searchParams);
    if (hostedViewer) params.delete('status');
    const data = integrityGraph(db, p, params);
    if (hostedViewer) {
      data.edges = data.edges.filter(edge => !['confirmed', 'rejected'].includes(edge.type));
      delete data.filters.statuses;
    }
    return send(res, 200, { data });
  }
  // Evidence Impact Lab. The checklist is read-only; a simulation runs the real pipeline on isolated copies and is never saved.
  if (req.method === 'GET' && url.pathname === '/api/v1/evidence/checklist') { try { return send(res, 200, { data: evidenceChecklist(db, p, { finding_id: url.searchParams.get('finding') || undefined, link_id: url.searchParams.get('link') || undefined }) }); } catch (error) { if (error instanceof LabError) return send(res, error.status, { error: error.message, code: error.code }); throw error; } }
  if (req.method === 'POST' && url.pathname === '/api/v1/simulations/correction') { const input = await body(req); try { return send(res, 200, { data: simulateCorrection(db, p, input) }); } catch (error) { if (error instanceof LabError) return send(res, error.status, { error: error.message, code: error.code }); throw error; } }
  const receiptView = url.pathname.match(/^\/api\/v1\/receipts\/([^/]+)$/); if (req.method === 'GET' && receiptView) { const receipt = (db.decisionReceipts || []).find(r => r.receipt_id === receiptView[1]); const records = new Map(db.sourceRecords.map(r => [r.id, r])); if (!receipt || !(receipt.source_records || []).every(s => records.get(s.record_id) && canAccess(p, records.get(s.record_id)))) return send(res, 404, { error: 'Receipt not found.' }); return send(res, 200, { data: { receipt, verification: verifyReceipt(db, receipt), limitations: RECEIPT_LIMITATIONS } }); }
  if (req.method === 'GET' && url.pathname === '/api/v1/findings') { const query = hostedViewer ? new URL(url) : url; if (hostedViewer) query.searchParams.delete('status'); const result = findingsQuery(db, p, query); result.data.forEach(finding => { delete finding.decision; }); if (hostedViewer) delete result.filter_options.statuses; return send(res, 200, result); }
  const detail = url.pathname.match(/^\/api\/v1\/findings\/([^/]+)$/); if (req.method === 'GET' && detail) { const f = db.findings.find(x => x.id === detail[1]); return !f || !allowedFinding(f, db, p) ? send(res, 404, { error: 'Finding not found.' }) : send(res, 200, { data: publicFinding(f, db, p), audit: db.auditEvents.filter(a => a.finding_id === f.id) }); }
  const decision = url.pathname.match(/^\/api\/v1\/findings\/([^/]+)\/decision$/); if (req.method === 'POST' && decision) { const f = db.findings.find(x => x.id === decision[1]); if (!f || !allowedFinding(f, db, p)) return send(res, 404, { error: 'Finding not found.' }); const input = await body(req); if (!isCurrent(f)) return send(res, 409, { error: `This finding is historical (${f.lifecycle_status === 'superseded' ? 'superseded by a current finding' : 'its condition is no longer present'}). Its review history is preserved; record decisions on the current finding instead.`, lifecycle_status: f.lifecycle_status, superseded_by: f.superseded_by || null }); if (!String(input.note || '').trim()) return send(res, 400, { error: 'A decision note is required.' }); const previousStatus = f.review_status; f.review_status = transition(f.review_status, input.outcome); f.decision = { outcome: input.outcome, note: String(input.note).slice(0, 1000), reviewer: p.name, at: new Date().toISOString() }; db.auditEvents.push({ id: `AUD-${Date.now()}`, finding_id: f.id, action: input.outcome, actor: p.name, note: f.decision.note, at: f.decision.at }); findingDecisionReceipt(db, p, f, db.auditEvents.at(-1), previousStatus); await saveDemo(db); return send(res, 200, { data: publicFinding(f, db, p) }); }
  if (req.method === 'POST' && url.pathname === '/api/v1/imports/preview') { const input = await body(req); if (typeof input.filename !== 'string' || !/\.csv$/i.test(input.filename)) return send(res, 415, { error: 'A .csv filename is required. This prototype does not parse XLSX.' }); const parsed = parseCsv(String(input.csv || '')); const manual = input.mapping && Object.keys(input.mapping).length; const suggestion = manual ? null : await suggestMapping(parsed, provider); const mapping = validMapping(manual ? input.mapping : suggestion.mapping, parsed.headers); const canonical = parsed.rows.slice(0, 10).map(row => recordFromMapping(row, mapping)); const unmappedRequired = requiredMappingIssues(mapping); const multiInstitution = input.multi_institution === true && p.capabilities.includes('imports.multi_institution'); const batchInstitution = multiInstitution ? 'MULTI' : p.scope === 'institution' ? p.institution_code : String(input.institution_code || '').toUpperCase(); const knownInstitutions = new Set(db.institutions.map(institution => institution.code)); const outcomes = unmappedRequired.length ? null : parsed.rows.map((row, i) => rowOutcome(recordFromMapping(row, mapping), parsed.row_numbers[i], batchInstitution, multiInstitution, knownInstitutions)); const dryRun = outcomes && { batch_institution: batchInstitution, multi_institution: multiInstitution, ready: outcomes.filter(o => o.outcome === 'imported' && !o.validation_issues.length).length, with_warnings: outcomes.filter(o => o.outcome === 'imported' && o.validation_issues.length).length, rejected: outcomes.filter(o => o.outcome === 'rejected').length, skipped: outcomes.filter(o => o.outcome === 'skipped').length, attention: outcomes.filter(o => o.outcome !== 'imported' || o.validation_issues.length).slice(0, 100) }; return send(res, 200, { data: { headers: parsed.headers, header_samples: Object.fromEntries(parsed.headers.map(h => { const kind = mapping.student_name === h ? 'name' : mapping.date_of_birth === h ? 'dob' : mapping.apaar_id === h ? 'id' : null; const sample = maskedSample(parsed.rows.find(row => String(row[h] ?? '').trim())?.[h]); return [h, kind && sample ? maskValue(kind, sample, false) : sample]; })), fields: FIELD_DEFINITIONS, mapping, mapped_fields: Object.keys(mapping), unmapped_required_fields: unmappedRequired, sample: canonical.map((r, i) => ({ row: parsed.row_numbers[i], name: r.student_name ? maskName(r.student_name) : 'Unmapped student name', apaar: mask(r.apaar_id), institution_code: r.institution_code, programme: r.programme, academic_session: r.academic_session, enrolment_status: r.enrolment_status, issues: validate(r), outcome: outcomes?.[i] || null })), total_rows: parsed.rows.length, mapping_sources: suggestion ? suggestion.sources : Object.fromEntries(Object.keys(mapping).map(k => [k, 'manual'])), mapping_ambiguous: suggestion ? suggestion.ambiguous : [], model_assistance: suggestion ? suggestion.model : { available: provider.status().tasks.schema_interpretation.available, used: false, note: 'Mapping supplied by the user.' }, dry_run: dryRun } }); }
  if (req.method === 'POST' && url.pathname === '/api/v1/imports/confirm') { const input = await body(req); if (typeof input.filename !== 'string' || !/\.csv$/i.test(input.filename)) return send(res, 415, { error: 'A .csv filename is required. This prototype does not parse XLSX.' }); const parsed = parseCsv(String(input.csv || '')); const proposed = input.mapping && Object.keys(input.mapping).length ? input.mapping : schemaSuggestion(parsed.headers); const mapping = validMapping(proposed, parsed.headers); const missingMappings = requiredMappingIssues(mapping); if (missingMappings.length) return send(res, 400, { error: `Map all required columns before import: ${missingMappings.join(', ')}.`, fields: missingMappings }); const multiInstitution = input.multi_institution === true; if (multiInstitution && !p.capabilities.includes('imports.multi_institution')) return send(res, 403, { error: 'Multi-institution import requires the explicit capability.', code: 'forbidden' }); const batchInstitution = multiInstitution ? 'MULTI' : String(input.institution_code || p.institution_code).toUpperCase(); if (p.scope === 'institution' && batchInstitution !== p.institution_code) return send(res, 403, { error: 'Institution users may only import their own records.' }); const batch = commitImport(db, { parsed, mapping, batchInstitution, multiInstitution, filename: input.filename }); db.auditEvents.push({ id: `AUD-IMP-${batch.id}`, action: 'import_batch_committed', actor: p.subject || p.name, institution_code: batch.institution_code, batch_id: batch.id, note: `${batch.imported} imported, ${batch.rejected} rejected, ${batch.skipped} skipped.`, at: batch.created_at }); await saveDemo(db); return send(res, 201, { data: batch, message: `${batch.rows_detected} rows detected: ${batch.imported} imported, ${batch.rejected} rejected, ${batch.skipped} skipped; ${batch.findings_created} findings created (${batch.validation_findings_created} validation); ${batch.automation.automatically_processed + batch.automation.automatically_normalised + batch.automation.safely_matched} of ${batch.imported} imported rows processed automatically${batch.capacity_findings_superseded || batch.capacity_findings_cleared ? `; capacity findings: ${batch.capacity_findings_superseded} superseded, ${batch.capacity_findings_cleared} cleared` : ''}.` }); }
  if (req.method === 'GET' && url.pathname === '/api/v1/reports/findings.csv') { const list = findingsQuery(db, p, url).data; const out = ['finding_id,rule_code,severity,status,processing_outcome,title,source_records,lifecycle_status,superseded_by'].concat(list.map(f => [f.id, f.rule_code, f.severity, f.review_status, f.automation?.outcome || '', f.title, f.evidence.join('|'), f.lifecycle_status || 'current', f.superseded_by || ''].map(csv).join(','))).join('\n'); return send(res, 200, out, 'text/csv; charset=utf-8'); }
  if (req.method === 'POST' && url.pathname === '/api/v1/demo/reset') { if (!p.capabilities?.includes('data.reset')) return send(res, 403, { error: 'Only the demo regulator can reset synthetic data.' }); return send(res, 200, { data: summary(await store.reset(), p) }); }
  return send(res, 404, { error: 'Not found.' });
 } catch (error) { if (error instanceof ReadOnlyError) return send(res, 403, READ_ONLY); if (error instanceof StoreError && error.status < 500) return send(res, error.status, { error: error.message, code: error.code }); if (error.code === 'body_too_large') return send(res, syntheticTest ? 413 : 400, { error: error.message, code: error.code }); if (error.status >= 400 && error.status < 500) return send(res, error.status, { error: error.message, ...(error.fields ? { fields: error.fields } : {}) }); const clientError = /CSV|Upload|Request body|Column mapping|Unsupported review|Resolved findings|decision note|required/i.test(error.message || '');
  // Server errors are logged here (method and path only, never the query or body) and never returned: messages can carry file paths.
  if (!clientError) { console.error(`[${mode}] ${req.method} ${String(req.url).split('?')[0]} failed:`, error); return send(res, 500, { error: 'Unexpected server error.' }); }
  return send(res, 400, { error: error.message }); }
}
}
// The development app. The tests drive it directly; `node server.js` goes through start().
const server = createApp();
// Resolves the mode and builds its app before listening. Throws StartupError, having touched no data and opened no port, when the configuration is invalid.
function start(env = process.env) {
  const { mode, explicit, hosted } = resolveMode(env);
  if (mode === 'production') assertProductionReady(env);
  if (mode === 'synthetic-test') {
    const persistent = Object.keys(env).filter(key => key.startsWith('EDUTRACE_') && key !== 'EDUTRACE_MODE' && env[key] !== undefined && env[key] !== '');
    const providers = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'EDUTRACE_OLLAMA_URL'].filter(key => env[key] !== undefined && env[key] !== '');
    if (persistent.length || providers.length) throw new StartupError('synthetic-test mode refuses persistent-store, account-store, authentication, and provider configuration.', [...persistent, ...providers].map(key => `${key} is not allowed in synthetic-test mode; values are not displayed.`));
    if (env.HOST && !['127.0.0.1', 'localhost'].includes(String(env.HOST).toLowerCase())) throw new StartupError('synthetic-test mode only binds to 127.0.0.1.', ['Remove the non-loopback HOST setting.']);
    const port = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new StartupError('PORT must be an integer from 0 to 65535 in synthetic-test mode.');
    const testProvider = createProvider({ env: {}, disabled: 'Model and external integrations are disabled in the ephemeral synthetic test environment.' });
    const app = createApp({ mode, store: createSyntheticTestStore(), auth: syntheticTestAuthenticator(), getProvider: () => testProvider, integrations: noneAdapter() });
    app.listen(port, '127.0.0.1', () => {
      const address = app.address();
      if (!address || address.address !== '127.0.0.1') {
        console.error('EduTrace did not start: synthetic-test listener verification failed.');
        return app.close(() => { process.exitCode = 1; });
      }
      console.log(`EduTrace AI (synthetic-test mode, ephemeral synthetic data; fixed test institution selector) running at http://127.0.0.1:${address.port}`);
    });
    return app;
  }
  const hostedDemo = mode === 'demo' && hosted.length > 0;
  if (hostedDemo) {
    if (env.EDUTRACE_AUTH !== 'hosted_demo') throw new StartupError('Hosted Demo requires EDUTRACE_AUTH=hosted_demo and refuses simulated-role or local-account authentication.');
    const incompatible = Object.keys(env).filter(key => env[key] !== undefined && env[key] !== '' && (
      key.startsWith('EDUTRACE_AI_') ||
      ['EDUTRACE_OLLAMA_URL', 'ANTHROPIC_API_KEY', 'EDUTRACE_STORE', 'EDUTRACE_DATABASE_URL', 'EDUTRACE_DB_PATH', 'EDUTRACE_USERS_PATH'].includes(key) ||
      key === 'EDUTRACE_INTEGRATIONS' && env[key] !== 'none'
    ));
    if (incompatible.length) throw new StartupError(`Hosted Demo refuses database, account, model or external-integration settings (${incompatible.join(', ')}).`);
  }
  const integrations = hostedDemo ? noneAdapter() : integrationsFromEnv(env, mode);
  // EDUTRACE_STORE selects the development store: the JSON file (default) or PostgreSQL. Never a silent fallback.
  const storeKind = env.EDUTRACE_STORE === undefined ? 'json' : env.EDUTRACE_STORE;
  if (!['json', 'postgres'].includes(storeKind)) throw new StartupError(`EDUTRACE_STORE="${String(storeKind).slice(0, 20)}" is not recognised.`, ['Supported values: json, postgres.']);
  if (storeKind === 'postgres' && mode !== 'development') throw new StartupError('EDUTRACE_STORE=postgres is wired for development mode only in this build; production stays blocked and the demo stays in memory.');
  if (storeKind === 'postgres' && !env.EDUTRACE_DATABASE_URL) throw new StartupError('EDUTRACE_STORE=postgres needs EDUTRACE_DATABASE_URL.');
  const pgStore = storeKind === 'postgres' ? createPostgresStore({ url: env.EDUTRACE_DATABASE_URL }) : null;
  // Accounts come from the same backend as the data: the app_users table with PostgreSQL, a users file otherwise.
  let auth;
  if (hostedDemo) {
    auth = authFromEnv(env, mode);
  } else auth = authFromEnv(env, mode, { pool: pgStore?.pool, usersPath: env.EDUTRACE_USERS_PATH || path.join(ROOT, 'data', 'users.json') });
  let app = mode === 'demo' ? null : mode === 'development' && !pgStore && auth.kind === 'demo_header' && integrations.kind === 'none' ? server : createApp({ mode: 'development', auth, integrations, ...(pgStore ? { store: pgStore } : {}) });
  if (mode === 'demo') {
    const ignored = Object.keys(env).filter(key => key.startsWith('EDUTRACE_AI_') || ['EDUTRACE_OLLAMA_URL', 'ANTHROPIC_API_KEY', 'EDUTRACE_DB_PATH'].includes(key));
    const demoProvider = createProvider({ env: {}, disabled: 'Model assistance is off in the read-only demo. Every explanation shown is deterministic rule text.' });
    app = createApp({ mode, store: createDemoStore(), getProvider: () => demoProvider, auth, integrations });
    if (ignored.length) console.warn(`Demo mode ignores ${ignored.join(', ')}: no database file is used and no model is called.`);
  }
  const announce = () => {
    const address = app.address();
    const displayHost = address?.address === '0.0.0.0' ? '0.0.0.0' : 'localhost';
    console.log(`EduTrace AI (${mode} mode${explicit ? '' : ', the local default'}${mode === 'demo' ? ': read-only, synthetic in-memory data, AI off' : ''}; ${auth.kind === 'oidc' ? 'OIDC bearer tokens' : auth.kind === 'local' ? 'institution sign-in with local accounts' : auth.kind === 'hosted_demo' ? 'fixed public synthetic viewer' : 'simulated x-demo-role principal over read-only synthetic data'}) running at http://${displayHost}:${address.port}${pgStore ? ' (PostgreSQL store)' : ''}`);
  };
  const demoPort = env.PORT === undefined || env.PORT === '' ? 3000 : Number(env.PORT);
  if (mode === 'demo' && (!Number.isInteger(demoPort) || demoPort < 0 || demoPort > 65535)) throw new StartupError('PORT must be an integer from 0 to 65535 in demo mode.');
  const listen = () => mode === 'demo'
    ? app.listen(demoPort, hosted.length ? '0.0.0.0' : '127.0.0.1', announce)
    : app.listen(Number(env.PORT || 3000), announce);
  // The PostgreSQL store is verified (connection, schema version) before the server listens; on failure nothing listens.
  if (pgStore) pgStore.verify().then(listen, error => { console.error(new StartupError(error.message).report()); process.exit(1); });
  else listen();
  return app;
}
if (require.main === module) { try { start(); } catch (error) { if (!(error instanceof StartupError)) throw error; console.error(error.report()); process.exit(1); } }
module.exports = { server, createApp, start, setProvider, parseCsv, summary, validMapping, requiredMappingIssues, hostedDemoResponse, READ_ONLY };
