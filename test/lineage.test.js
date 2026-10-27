require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { commitImport } = require('../src/pipeline');
const { isCurrent } = require('../src/engine');
const { decideCorrection, lineageView, listCorrectionCandidates } = require('../src/lineage');
const { listMatches } = require('../src/matches');
const { server, setProvider } = require('../server');
const { createProvider } = require('../src/ai-provider');
const { saveDemo, loadDemo } = require('../src/seed');

setProvider(createProvider({ env: {} }));
const HEADERS = ['source_reference', 'apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
const REG = { role: 'regulator', name: 'Test reviewer' };
const NITM = { role: 'institution', institution_code: 'NITM', name: 'NITM reviewer' };
const emptyDb = () => ({ version: 1, institutions: [{ code: 'NITM', name: 'Northbridge' }, { code: 'RCA', name: 'Riverview' }, { code: 'SVU', name: 'Suryavardhan' }], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] });
let clock = Date.parse('2026-10-22T09:00:00.000Z');
function load(db, inst, rows, file) {
  const parsed = { headers: HEADERS, rows: rows.map(r => ({ source_reference: r.ref || '', apaar_id: r.id || '', student_name: r.name, date_of_birth: r.dob || '', institution_code: inst, programme: r.programme || 'BTECH CSE', academic_session: r.session || '2026-27', enrolment_status: r.status || 'Active' })), row_numbers: rows.map((r, i) => r.row || i + 2) };
  return commitImport(db, { parsed, mapping: Object.fromEntries(HEADERS.map(h => [h, h])), batchInstitution: inst, multiInstitution: false, filename: file, at: new Date(clock += 60000).toISOString() });
}
const current = db => db.findings.filter(isCurrent);
const dupConditions = db => { const k = current(db).map(f => f.condition_key).filter(Boolean); return k.length - new Set(k).size; };
const notes = db => (db.notifications || []).flatMap(n => n.items).length;
const FULL_ID = /(?<![\w-])\d{12}(?![\w-])/;

test('an unchanged re-import with the same reference is a copy: no new version, no new work', () => {
  const db = emptyDb();
  load(db, 'NITM', [{ ref: 'N-001', id: '940000000001', name: 'Asha Rao', dob: '01/01/2005' }, { ref: 'N-002', name: 'Ravi Iyer', dob: '02/02/2005' }], 'n1.csv');
  const open = () => current(db).filter(f => f.review_status !== 'resolved').length;
  const openBefore = open(); const findings = db.findings.length; const n = notes(db);
  const batch = load(db, 'NITM', [{ ref: 'N-002', name: 'Ravi Iyer', dob: '02/02/2005', row: 9 }, { ref: 'N-001', id: '940000000001', name: 'Asha Rao', dob: '01/01/2005', row: 7 }], 'n1-again.csv');
  assert.deepEqual(batch.lineage, { unchanged_copies: 2, corrections_applied: 0, correction_candidates: 0 });
  assert.ok(db.sourceRecords.every(r => !r.superseded_by), 'nothing superseded');
  assert.ok(db.sourceRecords.filter(r => r.import_id === batch.id).every(r => r.lineage.relation === 'unchanged_copy' && r.lineage.version === 1));
  assert.equal(open(), openBefore, 'no new open work');
  assert.ok(db.findings.slice(findings).every(f => f.review_status === 'resolved' && f.decision?.automated), 'a re-sent identifier is recorded as an automatically closed resubmission');
  assert.equal(notes(db), n, 'no new notifications'); assert.equal(dupConditions(db), 0);
  assert.ok(!db.identityLinks.some(l => ['candidate_for_review', 'needs_investigation'].includes(l.outcome)), 'a re-sent row never becomes review work');
});

test('a correction with the institution reference supersedes the earlier version, keeps it, and resolves only the fixed finding', () => {
  const db = emptyDb();
  load(db, 'NITM', [{ ref: 'N-010', name: 'Meera Nath', dob: '03/03/2004' }, { ref: 'N-011', id: '9400001', name: 'Kabir Das', dob: '04/04/2004' }], 'n1.csv');
  const missing = current(db).find(f => f.rule_code === 'APAAR_MISSING');
  const malformed = current(db).find(f => f.rule_code === 'APAAR_MALFORMED');
  const original = db.sourceRecords.find(r => r.source_reference === 'N-010');
  const snapshot = JSON.stringify({ ...original, processing: undefined, superseded_by: undefined, superseded_at: undefined });
  const n = notes(db);
  const batch = load(db, 'NITM', [{ ref: 'N-010', id: '940000000010', name: 'Meera Nath', dob: '03/03/2004' }], 'n1-corrected.csv');
  assert.equal(batch.lineage.corrections_applied, 1); assert.equal(batch.findings_resolved_by_correction, 1);
  const corrected = db.sourceRecords.find(r => r.import_id === batch.id);
  assert.equal(original.superseded_by, corrected.id);
  assert.equal(JSON.stringify({ ...original, processing: undefined, superseded_by: undefined, superseded_at: undefined }), snapshot, 'the earlier version keeps every value');
  assert.deepEqual({ version: corrected.lineage.version, relation: corrected.lineage.relation, supersedes: corrected.lineage.supersedes, basis: corrected.lineage.basis }, { version: 2, relation: 'correction', supersedes: original.id, basis: 'institution_reference' });
  assert.deepEqual(corrected.lineage.changes.map(c => [c.field, c.kind, c.from]), [['apaar_id', 'filled', null]]);
  assert.doesNotMatch(JSON.stringify(corrected.lineage), FULL_ID, 'identifier values in the change record are masked');
  assert.equal(missing.lifecycle_status, 'cleared'); assert.equal(missing.lifecycle_cause, 'correction');
  assert.ok(db.auditEvents.some(e => e.finding_id === missing.id && e.action === 'resolved_by_correction'));
  assert.ok(isCurrent(malformed), 'an unrelated finding is untouched');
  assert.equal(original.processing.status, 'superseded');
  assert.equal(notes(db), n, 'a resolution by correction is not notified as new work');
  assert.ok((db.lineageEvents || []).some(e => e.action === 'version_superseded' && e.earlier === original.id && e.later === corrected.id));
});

test('repeated corrections build a version chain without duplicate current findings', () => {
  const db = emptyDb();
  load(db, 'RCA', [{ ref: 'R-1', name: 'Tara Sen', dob: '01/05/2004', status: 'Active' }], 'r1.csv');
  load(db, 'RCA', [{ ref: 'R-1', id: '9401', name: 'Tara Sen', dob: '01/05/2004' }], 'r2.csv');
  load(db, 'RCA', [{ ref: 'R-1', id: '940000000777', name: 'Tara Sen', dob: '01/05/2004' }], 'r3.csv');
  load(db, 'RCA', [{ ref: 'R-1', id: '940000000777', name: 'Tara Sen', dob: '01/05/2004' }], 'r3-again.csv');
  const versions = db.sourceRecords.map(r => [r.lineage.version, r.lineage.relation, Boolean(r.superseded_by)]);
  assert.deepEqual(versions, [[1, 'original', true], [2, 'correction', true], [3, 'correction', false], [3, 'unchanged_copy', false]]);
  assert.equal(dupConditions(db), 0);
  assert.equal(current(db).filter(f => ['APAAR_MISSING', 'APAAR_MALFORMED'].includes(f.rule_code)).length, 0, 'both identifier findings resolved by the corrections');
  const view = lineageView(db, REG, db.sourceRecords[0].id);
  assert.equal(view.versions.length, 4); assert.equal(view.findings_resolved_by_correction.length, 2);
});

test('an uncertain correction becomes a candidate: never accepted automatically, and confirmed only by a reviewer', () => {
  const db = emptyDb();
  load(db, 'SVU', [{ ref: 'S-9', id: '940000000090', name: 'Neel Jain', dob: '01/01/2004' }], 's1.csv');
  const batch = load(db, 'SVU', [{ ref: 'S-9', id: '940000000090', name: 'Ira Vyas', dob: '09/09/2003' }], 's2.csv');
  assert.equal(batch.lineage.correction_candidates, 1); assert.equal(batch.lineage.corrections_applied, 0);
  assert.ok(db.sourceRecords.every(r => !r.superseded_by), 'both records stay active until a reviewer decides');
  const [candidate] = listCorrectionCandidates(db, REG);
  assert.match(candidate.reasons.join(' '), /name and date of birth changed/);
  assert.throws(() => decideCorrection(db, REG, candidate.id, { decision: 'confirm', note: 'ok' }), /explicit confirmation/);
  assert.throws(() => decideCorrection(db, REG, candidate.id, { decision: 'confirm', confirm: true }), /note is required/);
  decideCorrection(db, REG, candidate.id, { decision: 'reject', note: 'Two different students; the reference was reused.' });
  assert.ok(db.sourceRecords.every(r => !r.superseded_by), 'a rejected candidate supersedes nothing');
  assert.throws(() => decideCorrection(db, REG, candidate.id, { decision: 'confirm', confirm: true, note: 'x' }), /already rejected/);
  assert.ok(db.lineageEvents.some(e => e.action === 'correction_rejected'));
});

test('without a reference, a row that fills missing values is a candidate, not a name-based match; confirming re-evaluates', async () => {
  const db = emptyDb();
  load(db, 'NITM', [{ name: 'Diya Kulkarni', dob: '05/05/2005' }], 'n1.csv');
  load(db, 'NITM', [{ name: 'Diya  KULKARNI', id: '940000000055', dob: '05/05/2005' }], 'n2.csv');
  load(db, 'NITM', [{ name: 'Diya Kulkarnee', dob: '05/05/2005' }], 'n3.csv');
  const pending = listCorrectionCandidates(db, REG);
  assert.equal(pending.length, 1, 'a similar but different name is never treated as a correction');
  assert.equal(pending[0].basis, 'heuristic');
  assert.ok(db.sourceRecords.every(r => !r.superseded_by));
  assert.throws(() => decideCorrection(db, { role: 'institution', institution_code: 'RCA', name: 'RCA reviewer' }, pending[0].id, { decision: 'reject', note: 'x' }), /not found/);
  decideCorrection(db, NITM, pending[0].id, { decision: 'confirm', confirm: true, note: 'The institution confirmed the identifier was added.' });
  require('../src/pipeline').processAll(db, { at: new Date(clock += 60000).toISOString(), reason: 'after a confirmed correction', origin: 'correction' });
  const earlier = db.sourceRecords[0];
  assert.equal(earlier.superseded_by, db.sourceRecords[1].id);
  assert.equal(db.sourceRecords[1].lineage.basis, 'reviewer_confirmed');
  assert.ok(db.findings.some(f => f.rule_code === 'APAAR_MISSING' && f.evidence.includes(earlier.id) && f.lifecycle_cause === 'correction'));
});

test('a different source row number with the same reference is the same source record, not an identity change', () => {
  const db = emptyDb();
  load(db, 'RCA', [{ ref: 'R-77', id: '940000000077', name: 'Zoya Ghosh', dob: '07/07/2004', row: 2 }], 'a.csv');
  const batch = load(db, 'RCA', [{ ref: 'R-77', id: '940000000077', name: 'Zoya Ghosh', dob: '07/07/2004', row: 40 }], 'b.csv');
  assert.equal(batch.lineage.unchanged_copies, 1);
  const link = db.identityLinks.find(l => l.records.length === 2);
  assert.equal(link.outcome, 'same_source_record', 'a re-sent row is not weighed as identity evidence');
});

test('a correction that contradicts an automatic identity link withdraws it, audits it and reopens review', () => {
  const db = emptyDb();
  load(db, 'NITM', [{ ref: 'N-5', id: '940000000500', name: 'Farah Khan', dob: '03/03/2003' }], 'n1.csv');
  load(db, 'RCA', [{ ref: 'R-5', id: '940000000500', name: 'Farah Khan', dob: '03/03/2003' }], 'r1.csv');
  assert.equal(db.identityLinks.filter(l => l.outcome === 'auto_linked').length, 1);
  const duplicate = current(db).find(f => f.rule_code === 'DUPLICATE_IDENTIFIER');
  assert.equal(duplicate.review_status, 'resolved');
  load(db, 'NITM', [{ ref: 'N-5', id: '940000000500', name: 'Farah Khan', dob: '09/03/2003' }], 'n1-corrected.csv');
  assert.equal(db.identityLinks.filter(l => l.outcome === 'auto_linked').length, 0, 'no unsupported automatic link remains');
  const link = db.identityLinks.find(l => l.outcome === 'needs_investigation');
  assert.ok(link.withdrawn, 'the automatic link is marked withdrawn across versions');
  const conflict = current(db).find(f => f.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  assert.equal(conflict.review_status, 'pending');
  assert.ok(db.auditEvents.some(e => e.finding_id === duplicate.id && ['superseded', 'resolved_by_correction'].includes(e.action)));
  assert.equal(listMatches(db, REG).data[0].resolution, 'MATCH_WITHDRAWN');
  assert.equal(dupConditions(db), 0);
});

test('a corrected record replaces a stale candidate pair; no stale pair stays in the queue', () => {
  const db = emptyDb();
  load(db, 'NITM', [{ ref: 'N-8', id: '940000000800', name: 'Kiran Rao', dob: '08/08/2004' }], 'n.csv');
  load(db, 'SVU', [{ ref: 'S-8', name: 'Kiran Rao', dob: '08/08/2004' }], 's.csv');
  assert.equal(listMatches(db, REG).total, 1);
  const candidateFinding = current(db).find(f => f.rule_code === 'CANDIDATE_IDENTITY_MATCH');
  load(db, 'SVU', [{ ref: 'S-8', id: '940000000800', name: 'Kiran Rao', dob: '08/08/2004' }], 's-corrected.csv');
  assert.equal(listMatches(db, REG).total, 0, 'the pair based on the superseded record is gone');
  assert.equal(db.identityLinks.filter(l => l.outcome === 'auto_linked').length, 1, 'corrected evidence is evaluated under auto-link-2');
  assert.equal(candidateFinding.lifecycle_status, 'cleared'); assert.equal(candidateFinding.lifecycle_cause, 'correction');
});

function call({ method = 'GET', url, headers = {}, json }) {
  return new Promise(resolve => {
    const request = Readable.from(json === undefined ? [] : [JSON.stringify(json)]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let h = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; h = values; };
    response.end = value => { if (value) chunks.push(value); resolve({ status, json: h['Content-Type']?.includes('json') ? JSON.parse(chunks.join('')) : undefined }); };
    server.emit('request', request, response);
  });
}

test('API: lineage view and corrections respect scope, mask identifiers and audit decisions', async () => {
  const db = emptyDb();
  load(db, 'SVU', [{ ref: 'S-1', id: '940000000101', name: 'Dev Rao', dob: '01/01/2004' }], 's1.csv');
  load(db, 'SVU', [{ ref: 'S-1', id: '940000000101', name: 'Isha Menon', dob: '02/02/2002' }], 's2.csv');
  load(db, 'NITM', [{ ref: 'N-1', name: 'Arun Pillai', dob: '01/01/2004' }], 'n1.csv');
  load(db, 'NITM', [{ ref: 'N-1', id: '940000000102', name: 'Arun Pillai', dob: '01/01/2004' }], 'n2.csv');
  saveDemo(db);
  const svu = loadDemo().sourceRecords.find(r => r.institution_code === 'SVU');
  const nitm = loadDemo().sourceRecords.find(r => r.institution_code === 'NITM');
  const view = (await call({ url: `/api/v1/records/${nitm.id}/lineage` })).json.data;
  assert.equal(view.versions.length, 2); assert.equal(view.findings_resolved_by_correction.length, 1);
  assert.doesNotMatch(JSON.stringify(view), FULL_ID);
  assert.equal((await call({ url: `/api/v1/records/${svu.id}/lineage`, headers: { 'x-demo-role': 'institution' } })).status, 404, 'another institution\'s lineage is not visible');
  const list = (await call({ url: '/api/v1/corrections' })).json;
  assert.equal(list.pending, 1);
  assert.equal((await call({ url: '/api/v1/corrections', headers: { 'x-demo-role': 'institution' } })).json.pending, 0, 'scoped to the principal');
  const id = list.data[0].id;
  assert.equal((await call({ method: 'POST', url: `/api/v1/corrections/${id}/decision`, headers: { 'x-demo-role': 'institution' }, json: { decision: 'reject', note: 'x' } })).status, 404);
  const confirmed = await call({ method: 'POST', url: `/api/v1/corrections/${id}/decision`, json: { decision: 'confirm', confirm: true, note: 'SVU confirmed the corrected name and date of birth.' } });
  assert.equal(confirmed.status, 200); assert.equal(confirmed.json.data.candidate.status, 'confirmed');
  assert.equal(loadDemo().sourceRecords.find(r => r.id === svu.id).superseded_by, confirmed.json.data.candidate.later);
  assert.ok(loadDemo().lineageEvents.some(e => e.action === 'correction_confirmed' && e.actor === 'Demo Regulator Reviewer'));
  const profile = (await call({ url: `/api/v1/findings` })).json.data.flatMap(f => f.records).find(r => r.id === svu.id);
  assert.ok(!profile || profile.superseded_by, 'finding records expose that a version was superseded');
});
