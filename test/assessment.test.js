require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { commitImport } = require('../src/pipeline');
const { reconcile, isCurrent, isActiveRecord, sameEvidence, CAPACITY_RULE } = require('../src/engine');
const { assessFinding } = require('../src/assessment');
const { saveDemo } = require('../src/seed');
const { server } = require('../server');

const HEADERS = ['source_reference', 'apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
const emptyDb = () => ({ version: 1, institutions: [{ code: 'NITM', name: 'Northbridge' }, { code: 'RCA', name: 'Riverview' }, { code: 'SVU', name: 'Suryavardhan' }], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] });
let clock = Date.parse('2026-10-22T09:00:00.000Z');
function load(db, inst, rows, file) {
  const parsed = { headers: HEADERS, rows: rows.map(r => ({ source_reference: r.ref || '', apaar_id: r.id || '', student_name: r.name, date_of_birth: r.dob || '', institution_code: inst, programme: r.programme || 'BA', academic_session: '2026-27', enrolment_status: r.status || 'Active' })), row_numbers: rows.map((_, i) => i + 2) };
  return commitImport(db, { parsed, mapping: Object.fromEntries(HEADERS.map(h => [h, h])), batchInstitution: inst, multiInstitution: false, filename: file, at: new Date(clock += 60000).toISOString() });
}
const current = db => db.findings.filter(isCurrent);
const byRule = (db, rule, pred = () => true) => db.findings.filter(f => f.rule_code === rule && pred(f));
const recordId = (db, ref) => db.sourceRecords.find(r => r.source_reference === ref && isActiveRecord(r)).id;

// The oracle: what reconcile() would raise for this condition right now.
function freshExplanation(db, f) {
  const fresh = reconcile(db);
  const active = new Set(db.sourceRecords.filter(isActiveRecord).map(r => r.id));
  const match = f.rule_code === CAPACITY_RULE ? fresh.find(x => x.condition_key === f.condition_key)
    : fresh.find(x => x.rule_code === f.rule_code && sameEvidence(x.evidence, f.evidence.filter(id => active.has(id))));
  return match ? match.explanation : null;
}
// Every current finding: the assessment equals a freshly raised explanation, or says the condition is gone.
function assertAccurate(db, label) {
  for (const f of current(db)) {
    const a = assessFinding(db, f);
    const fresh = freshExplanation(db, f);
    if (a.condition_present) assert.equal(a.summary, fresh, `${label}: ${f.rule_code} assessment equals what reconcile() raises now`);
    else assert.equal(fresh, null, `${label}: ${f.rule_code} is assessed as gone, and reconcile() raises nothing for it`);
  }
}
// Explanations recorded when raised must never change.
function snapshot(db, seen) { for (const f of db.findings) { if (!seen.has(f.id)) seen.set(f.id, { explanation: f.explanation, original_evidence: JSON.stringify(f.original_evidence) }); } }
function assertPreserved(db, seen) { for (const [id, s] of seen) { const f = db.findings.find(x => x.id === id); assert.equal(f.explanation, s.explanation, `explanation of ${f.rule_code} ${id} unchanged`); assert.equal(JSON.stringify(f.original_evidence), s.original_evidence); } }

test('a missing identifier corrected: the finding is historical, the assessment says so, and the raised text is kept', () => {
  const db = emptyDb(); const seen = new Map();
  load(db, 'NITM', [{ ref: 'N-1', name: 'Asha Rao', dob: '01/01/2005' }], 'n1.csv');
  const missing = byRule(db, 'APAAR_MISSING')[0];
  const before = assessFinding(db, missing);
  assert.equal(before.status, 'current'); assert.equal(before.condition_present, true); assert.equal(before.stale_original, false);
  assert.equal(before.summary, missing.explanation); assert.deepEqual(before.raised.evidence, missing.evidence);
  snapshot(db, seen); assertAccurate(db, 'raised');
  load(db, 'NITM', [{ ref: 'N-1', id: '940000000001', name: 'Asha Rao', dob: '01/01/2005' }], 'n1-corrected.csv');
  const after = assessFinding(db, missing);
  assert.equal(after.status, 'cleared'); assert.equal(after.condition_present, false);
  assert.match(after.summary, /^Historical: the condition is no longer present because a corrected version/);
  assert.match(after.reason, /superseded by a corrected version/);
  assert.equal(after.raised.explanation, missing.explanation); assert.ok(after.raised.created_at);
  assert.ok(after.history.some(e => e.action === 'resolved_by_correction'));
  assertPreserved(db, seen); assertAccurate(db, 'corrected');
});

test('stored data newer than the findings: the assessment reports the condition gone before the next run', () => {
  const db = emptyDb();
  load(db, 'NITM', [{ ref: 'N-1', name: 'Asha Rao', dob: '01/01/2005' }], 'n1.csv');
  const missing = byRule(db, 'APAAR_MISSING')[0];
  const copy = structuredClone(db);
  Object.assign(copy.sourceRecords[0], { apaar_id: '940000000001' }); // as if the stored record changed without a reconciliation run
  const a = assessFinding(copy, copy.findings.find(f => f.id === missing.id));
  assert.equal(a.status, 'current'); assert.equal(a.condition_present, false); assert.equal(a.stale_original, true);
  assert.match(a.summary, /no longer has this problem/);
});

test('a conflict introduced and then resolved: superseded findings point to their successor, current ones are accurate', () => {
  const db = emptyDb(); const seen = new Map();
  load(db, 'RCA', [{ ref: 'R-1', id: '911111111111', name: 'Kiran Bose', dob: '02/02/2002' }], 'r.csv');
  load(db, 'SVU', [{ ref: 'S-1', id: '911111111111', name: 'Kiran Bose', dob: '02/02/2002' }], 's.csv');
  const duplicate = byRule(db, 'DUPLICATE_IDENTIFIER', isCurrent)[0];
  assert.ok(duplicate); snapshot(db, seen); assertAccurate(db, 'duplicate');
  // Introduced: a third record shares the identifier with a different date of birth.
  load(db, 'NITM', [{ ref: 'N-9', id: '911111111111', name: 'Kiran Bose', dob: '03/03/2003' }], 'n.csv');
  const conflict = byRule(db, 'IDENTIFIER_ATTRIBUTE_CONFLICT', isCurrent)[0];
  const old = assessFinding(db, duplicate);
  assert.equal(old.status, 'superseded'); assert.equal(old.successor, conflict.id); assert.equal(old.raised.explanation, duplicate.explanation);
  const now = assessFinding(db, conflict);
  assert.equal(now.condition_present, true); assert.equal(now.facts.find(x => x.key === 'records_sharing_identifier').value, 3);
  snapshot(db, seen); assertAccurate(db, 'conflict introduced');
  // Without a reconciliation run, removing the conflicting record is reported as a reclassification.
  const copy = structuredClone(db); copy.sourceRecords.find(r => r.source_reference === 'N-9').superseded_by = 'elsewhere';
  const pending = assessFinding(copy, copy.findings.find(f => f.id === conflict.id));
  assert.equal(pending.condition_present, false); assert.equal(pending.reclassified_as, 'DUPLICATE_IDENTIFIER');
  assert.ok(pending.differences.some(d => /now classified as DUPLICATE_IDENTIFIER/.test(d)));
  // Resolved through the real pipeline: NITM corrects the date of birth with its reference.
  load(db, 'NITM', [{ ref: 'N-9', id: '911111111111', name: 'Kiran Bose', dob: '02/02/2002' }], 'n-corrected.csv');
  assert.notEqual(assessFinding(db, conflict).status, 'current');
  assert.equal(assessFinding(db, conflict).raised.explanation, conflict.explanation);
  assertPreserved(db, seen); assertAccurate(db, 'conflict resolved');
});

test('competing candidates added: a kept candidate finding no longer presents its raised text as current', () => {
  const db = emptyDb(); const seen = new Map();
  load(db, 'RCA', [{ ref: 'R-1', name: 'Asha Rao', dob: '01/01/2005' }], 'r.csv');
  load(db, 'SVU', [{ ref: 'S-1', name: 'Asha Rao', dob: '01/01/2005' }], 's.csv');
  const candidate = byRule(db, 'CANDIDATE_IDENTITY_MATCH', isCurrent)[0];
  assert.doesNotMatch(candidate.explanation, /equally plausible/); snapshot(db, seen);
  load(db, 'NITM', [{ ref: 'N-5', name: 'Asha Rao', dob: '01/01/2005' }], 'n.csv');
  assert.ok(isCurrent(candidate), 'the pipeline keeps the same finding for the same condition');
  assert.doesNotMatch(candidate.explanation, /equally plausible/, 'its stored text is unchanged');
  const a = assessFinding(db, candidate);
  assert.equal(a.condition_present, true); assert.equal(a.stale_original, true);
  assert.match(a.summary, /2 records are equally plausible candidates/);
  assert.ok(a.differences.includes('Competing candidates: 0 when raised, 2 now.'));
  assertPreserved(db, seen); assertAccurate(db, 'competing added');
});

test('competing candidates removed: text raised under competition is replaced by an accurate assessment', () => {
  const db = emptyDb(); const seen = new Map();
  load(db, 'RCA', [{ ref: 'R-1', name: 'Asha Rao', dob: '01/01/2005' }], 'r.csv');
  load(db, 'NITM', [{ ref: 'N-5', name: 'Asha Rao', dob: '01/01/2005' }], 'n.csv');
  load(db, 'SVU', [{ ref: 'S-1', name: 'Asha Rao', dob: '01/01/2005' }], 's.csv');
  const pair = id => byRule(db, 'CANDIDATE_IDENTITY_MATCH', f => isCurrent(f) && sameEvidence(f.evidence, id))[0];
  const rcaSvu = byRule(db, 'CANDIDATE_IDENTITY_MATCH', f => isCurrent(f) && f.evidence.includes(recordId(db, 'R-1')) && f.evidence.includes(recordId(db, 'S-1')))[0];
  const rcaNitm = pair([recordId(db, 'R-1'), recordId(db, 'N-5')]);
  snapshot(db, seen);
  // NITM corrects its date of birth: it is no longer a candidate for either record.
  load(db, 'NITM', [{ ref: 'N-5', name: 'Asha Rao', dob: '05/05/2005' }], 'n-corrected.csv');
  assert.ok(isCurrent(rcaSvu)); assert.match(rcaSvu.explanation, /2 records are equally plausible/, 'the raised text still mentions the competition');
  const a = assessFinding(db, rcaSvu);
  assert.equal(a.condition_present, true); assert.equal(a.stale_original, true);
  assert.doesNotMatch(a.summary, /equally plausible/, 'the current assessment does not');
  assert.ok(a.differences.includes('Competing candidates: 2 when raised, 0 now.'));
  assert.equal(a.raised.explanation, rcaSvu.explanation);
  const gone = assessFinding(db, rcaNitm);
  assert.notEqual(gone.status, 'current'); assert.equal(gone.condition_present, false);
  assertPreserved(db, seen); assertAccurate(db, 'competing removed');
});

test('a resolved finding keeps its assessment and decision; evidence added later is reported against the raised evidence', () => {
  const db = emptyDb();
  load(db, 'RCA', [{ ref: 'R-1', name: 'Meera Das', dob: '03/03/2003' }], 'r.csv');
  const missing = byRule(db, 'APAAR_MISSING')[0];
  Object.assign(missing, { review_status: 'resolved', decision: { outcome: 'legitimate_exception', note: 'n', reviewer: 'r', at: new Date(clock).toISOString() } });
  load(db, 'RCA', [{ name: 'Meera Das', dob: '03/03/2003' }], 'r-again.csv'); // an unchanged resubmission without reference
  const a = assessFinding(db, missing);
  assert.equal(a.review.decided, true); assert.equal(a.review.status, 'resolved');
  if (missing.evidence.length !== missing.original_evidence.length) assert.ok(a.differences.some(d => /when raised/.test(d)));
});

test('the API, the graph and the lab show the current assessment and label the raised text', async () => {
  const db = emptyDb();
  load(db, 'RCA', [{ ref: 'R-1', name: 'Asha Rao', dob: '01/01/2005' }], 'r.csv');
  load(db, 'NITM', [{ ref: 'N-5', name: 'Asha Rao', dob: '01/01/2005' }], 'n.csv');
  load(db, 'SVU', [{ ref: 'S-1', name: 'Asha Rao', dob: '01/01/2005' }], 's.csv');
  load(db, 'NITM', [{ ref: 'N-5', name: 'Asha Rao', dob: '05/05/2005' }], 'n-corrected.csv');
  saveDemo(db);
  const call = url => new Promise(resolve => {
    const req = Readable.from([]); req.method = 'GET'; req.url = url; req.headers = { host: 'localhost', 'x-demo-role': 'regulator' };
    const res = new EventEmitter(); const chunks = []; res.writeHead = () => {}; res.end = v => { if (v) chunks.push(v); resolve(JSON.parse(chunks.join(''))); };
    server.emit('request', req, res);
  });
  const stale = db.findings.find(f => isCurrent(f) && /equally plausible/.test(f.explanation));
  const detail = (await call(`/api/v1/findings/${stale.id}`)).data;
  assert.equal(detail.explanation, stale.explanation, 'the stored text is still returned, as the raised text');
  assert.equal(detail.assessment.stale_original, true); assert.doesNotMatch(detail.assessment.summary, /equally plausible/);
  const graph = (await call('/api/v1/graph')).data;
  const card = graph.nodes.flatMap(n => n.detail?.findings || []).find(f => f.id === stale.id);
  assert.equal(card.current_assessment.summary, detail.assessment.summary);
  const checklist = (await call(`/api/v1/evidence/checklist?finding=${stale.id}`)).data;
  assert.equal(checklist.current.explanation, detail.assessment.summary); assert.equal(checklist.current.explanation_as_raised, stale.explanation);
  const assist = (await call(`/api/v1/findings/${stale.id}/explanation`)).data;
  assert.equal(assist.explanation.summary, detail.assessment.summary, 'the deterministic explanation is the current assessment');
});

test('the finding drawer and graph present the current assessment first and the raised text as history', () => {
  const recon = fs.readFileSync(path.join(__dirname, '..', 'public', 'reconciliation.js'), 'utf8');
  const graph = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.js'), 'utf8');
  assert.match(recon, /Current assessment/); assert.match(recon, /As raised on/);
  assert.match(recon, /\$\{rxAssessmentHtml\(f\)\}/); assert.match(recon, /const a = f\.assessment;/);
  assert.doesNotMatch(recon, /<p class="d-lede">\$\{esc\(f\.explanation\)\}<\/p>/, 'the stored text is no longer the lede');
  assert.match(graph, /current_assessment/);
});
