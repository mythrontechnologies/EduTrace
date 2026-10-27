require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { commitImport } = require('../src/pipeline');
const { identityHistory, listRecords, recordDetail } = require('../src/history');
const { listMatches, decideMatch } = require('../src/matches');
const { server, setProvider } = require('../server');
const { createProvider } = require('../src/ai-provider');
const { saveDemo } = require('../src/seed');

setProvider(createProvider({ env: {} }));
const HEADERS = ['source_reference', 'apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
const REG = { role: 'regulator', name: 'Test reviewer' };
const FULL_ID = /(?<![\w-])\d{12}(?![\w-])/;
const emptyDb = () => ({ version: 1, institutions: [{ code: 'NITM', name: 'Northbridge' }, { code: 'RCA', name: 'Riverview' }, { code: 'SVU', name: 'Suryavardhan' }], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] });
// Import times are set in the past so that reviewer decisions (recorded "now") come after them.
let clock = Date.parse('2026-01-05T09:00:00.000Z');
const day = 86400000;
function load(db, inst, rows, file) {
  const parsed = { headers: HEADERS, rows: rows.map(r => ({ source_reference: r.ref || '', apaar_id: r.id || '', student_name: r.name, date_of_birth: r.dob || '', institution_code: inst, programme: r.programme || 'BTECH CSE', academic_session: r.session || '2026-27', enrolment_status: r.status || 'Active' })), row_numbers: rows.map((_, i) => i + 2) };
  return commitImport(db, { parsed, mapping: Object.fromEntries(HEADERS.map(h => [h, h])), batchInstitution: inst, multiInstitution: false, filename: file, at: new Date(clock += 30 * day).toISOString() });
}
const rec = (db, batch) => db.sourceRecords.find(r => r.import_id === batch.id);

// A fictional student: NITM record (later corrected), RCA record linked automatically, and an
// SVU record with an abbreviated name and no identifier that only a reviewer can connect.
function arjun() {
  clock = Date.parse('2026-01-05T09:00:00.000Z');
  const db = emptyDb();
  const a1 = rec(db, load(db, 'NITM', [{ ref: 'N-1', id: '970000000001', name: 'Arjun Kumar', dob: '01/01/2005', session: '2025-26', status: 'Transferred', programme: 'BSC PHYSICS' }], 'nitm-2025.csv'));
  const b = rec(db, load(db, 'RCA', [{ ref: 'R-1', id: '970000000001', name: 'Arjun Kumar', dob: '01/01/2005' }], 'rca-2026.csv'));
  const a2 = rec(db, load(db, 'NITM', [{ ref: 'N-1', id: '970000000001', name: 'Arjun Kumar', dob: '01/01/2005', session: '2025-26', status: 'Transferred', programme: 'BSC MATHS' }], 'nitm-2025-corrected.csv'));
  const d = rec(db, load(db, 'SVU', [{ name: 'Arjun K.', dob: '01/01/2005' }], 'svu-2026.csv'));
  return { db, a1, a2, b, d };
}

test('a selected identity shows every associated record, including superseded versions, under the right institution', () => {
  const { db, a1, a2, b, d } = arjun();
  const h = identityHistory(db, REG, b.id);
  assert.deepEqual(h.records.map(r => r.record_id).sort(), [a1.id, a2.id, b.id].sort());
  assert.equal(h.records.find(r => r.record_id === a1.id).active, false, 'the superseded version stays visible');
  assert.deepEqual(Object.fromEntries(h.institutions.map(i => [i.code, i.records.sort()])), { NITM: [a1.id, a2.id].sort(), RCA: [b.id] });
  assert.ok(!h.records.some(r => r.record_id === d.id), 'an unconfirmed candidate never joins the identity');
  const candidate = h.relationships.find(r => r.records.some(x => x.record_id === d.id));
  assert.equal(candidate.resolution, 'POTENTIAL_MATCH'); assert.equal(candidate.within_identity, false);
  assert.doesNotMatch(JSON.stringify(h), FULL_ID);
  // The same history is reached from any member, including the superseded version.
  assert.deepEqual(identityHistory(db, REG, a1.id).records.map(r => r.record_id).sort(), h.records.map(r => r.record_id).sort());
});

test('the timeline is ordered, separates import, system and reviewer time, and shows corrections with before and after values', () => {
  const { db, b } = arjun();
  const t = identityHistory(db, REG, b.id).timeline;
  assert.deepEqual(t.map(e => e.at), [...t.map(e => e.at)].sort(), 'chronological');
  assert.ok(t.every(e => ['import', 'system', 'reviewer'].includes(e.time_kind)));
  const stored = t.filter(e => e.category === 'record');
  assert.ok(stored.every(e => e.time_kind === 'import' && e.reported && 'academic_session' in e.reported), 'institution-reported periods are kept apart from import times');
  assert.equal(stored.find(e => e.record_ids.length === 1 && e.reported.enrolment_status === 'transferred').reported.academic_session, '2025-26');
  const correction = t.find(e => e.type === 'version_superseded');
  assert.deepEqual(correction.changes.map(c => [c.field, c.from, c.to]), [['programme', 'BSC PHYSICS', 'BSC MATHS']]);
  assert.ok(t.some(e => e.type === 'automatically_matched' && e.category === 'identity'));
  assert.ok(!t.some(e => /admission_date|transfer_date|name_change/.test(JSON.stringify(e))), 'no inferred event dates');
});

test('name variations are recorded variations, corrections are labelled as such, and missing differs from conflicting', () => {
  const { db, b, d } = arjun();
  const pair = listMatches(db, REG).data.find(m => m.sources.some(s => s.record_id === d.id) && m.sources.some(s => s.record_id === b.id));
  decideMatch(db, REG, pair.id, { decision: 'same_person', note: 'SVU admission form lists the same school and parent.', confirm: true });
  const h = identityHistory(db, REG, b.id);
  assert.ok(h.records.some(r => r.record_id === d.id), 'a reviewer-confirmed pair joins the identity');
  const v = Object.fromEntries(h.variations.map(x => [x.field, x]));
  assert.equal(v.student_name.state, 'recorded_variation'); assert.match(v.student_name.note, /not an established name change/);
  assert.deepEqual(v.student_name.values.map(x => x.value).sort(), ['Arjun K.', 'Arjun Kumar']);
  assert.equal(v.programme.state, 'corrected'); assert.equal(v.programme.corrections[0].from, 'BSC PHYSICS');
  assert.equal(v.apaar_id.state, 'missing_in_some', 'a missing identifier is not a conflict');
  assert.equal(v.date_of_birth.state, 'consistent');
  assert.equal(v.institution_code.state, 'differs_by_source', 'different institutions are context, not an identity conflict');
  assert.equal(v.enrolment_status.state, 'differs_by_source');
  const kinds = identityHistory(db, REG, d.id).timeline.filter(e => e.type === 'finding_raised').map(e => e.evidence_kind);
  assert.ok(kinds.includes('missing'));
  assert.ok(!kinds.includes('contradiction'));
  assert.ok(h.timeline.some(e => e.time_kind === 'reviewer' && e.type === 'match_same_person'));
});

test('an as-of view shows only what was known then: no later records, links or decisions', () => {
  const { db, a1, a2, b, d } = arjun();
  const pair = listMatches(db, REG).data.find(m => m.sources.some(s => s.record_id === d.id) && m.sources.some(s => s.record_id === b.id));
  decideMatch(db, REG, pair.id, { decision: 'same_person', note: 'Confirmed from documents.', confirm: true });
  const firstImport = a1.imported_at.slice(0, 10);
  const early = identityHistory(db, REG, a1.id, { asOf: firstImport });
  assert.deepEqual(early.records.map(r => r.record_id), [a1.id], 'records stored later are not shown');
  assert.ok(early.timeline.every(e => e.at <= `${firstImport}T23:59:59.999Z`));
  const beforeDecision = identityHistory(db, REG, b.id, { asOf: d.imported_at.slice(0, 10) });
  assert.ok(!beforeDecision.records.some(r => r.record_id === d.id), 'the later reviewer decision is not applied early');
  const rel = beforeDecision.relationships.find(r => r.records.some(x => x.record_id === d.id));
  assert.ok(!rel || (rel.decision === null && rel.resolution === 'POTENTIAL_MATCH'));
  assert.ok(!beforeDecision.timeline.some(e => e.time_kind === 'reviewer'));
  assert.ok(identityHistory(db, REG, a2.id).records.some(r => r.record_id === d.id), 'the full view includes it');
});

test('an as-of view uses the audit trail for past automatic matches and shows versions as they were then', () => {
  const { db, a1, b } = arjun();
  const then = identityHistory(db, REG, b.id, { asOf: b.imported_at.slice(0, 10) });
  assert.deepEqual(then.records.map(r => r.record_id).sort(), [a1.id, b.id].sort(), 'the earlier version was linked automatically at the time');
  assert.equal(then.records.find(r => r.record_id === a1.id).active, true, 'a version superseded later is not shown as superseded early');
  assert.ok(then.relationships.some(r => r.label.includes('as recorded then')));
  assert.equal(identityHistory(db, REG, b.id, { asOf: '2026-01-01' }).not_yet_stored, true, 'before it was stored the record is reported as not yet stored');
});

test('withdrawn relationships stay visible and auditable in the identity history', () => {
  clock = Date.parse('2026-01-05T09:00:00.000Z');
  const db = emptyDb();
  const x = rec(db, load(db, 'NITM', [{ ref: 'N-9', id: '970000000009', name: 'Farah Khan', dob: '03/03/2003' }], 'n.csv'));
  rec(db, load(db, 'RCA', [{ ref: 'R-9', id: '970000000009', name: 'Farah Khan', dob: '03/03/2003' }], 'r.csv'));
  load(db, 'SVU', [{ id: '970000000009', name: 'Ira Vyas', dob: '09/09/2004' }], 's.csv');
  const h = identityHistory(db, REG, x.id);
  assert.equal(h.records.length, 1, 'the withdrawn automatic link no longer groups the records');
  const withdrawn = h.relationships.find(r => r.resolution === 'MATCH_WITHDRAWN');
  assert.ok(withdrawn && withdrawn.withdrawn && withdrawn.withdrawn.at, 'the withdrawal is shown with its time');
  assert.ok(h.timeline.some(e => e.type === 'automatically_matched'), 'the earlier automatic match stays in the history');
  assert.ok(h.timeline.some(e => e.type === 'finding_raised' && e.evidence_kind === 'contradiction'));
});

test('every record is discoverable through search, including historical versions, within scope', () => {
  const { db, a1 } = arjun();
  const all = listRecords(db, REG, new URLSearchParams('versions=all'));
  assert.equal(all.total, db.sourceRecords.length);
  assert.equal(listRecords(db, REG, new URLSearchParams()).total, db.sourceRecords.filter(r => !r.superseded_by).length);
  assert.deepEqual(listRecords(db, REG, new URLSearchParams('institution=NITM&versions=all')).data.map(r => r.institution_code), ['NITM', 'NITM']);
  assert.ok(listRecords(db, REG, new URLSearchParams('q=arjun&versions=all')).data.some(r => r.record_id === a1.id));
  assert.equal(listRecords(db, { role: 'institution', institution_code: 'RCA', name: 'RCA' }, new URLSearchParams('versions=all')).data.every(r => r.institution_code === 'RCA'), true);
  const detail = recordDetail(db, REG, a1.id);
  assert.equal(detail.original.student_name, 'Arjun Kumar'); assert.equal(detail.original.date_of_birth, '01/01/2005', 'the original value is kept exactly as recorded');
  assert.equal(detail.comparison.date_of_birth, '2005-01-01', 'normalised values are separate');
  assert.equal(detail.active, false); assert.equal(detail.lineage.versions.length, 2);
  assert.doesNotMatch(JSON.stringify(detail), FULL_ID);
  const d = recordDetail(db, REG, db.sourceRecords.find(r => r.institution_code === 'SVU').id);
  assert.match(d.source_reference_note, /did not supply a record reference/);
});

function call({ url, headers = {} }) {
  return new Promise(resolve => {
    const request = Readable.from([]); request.method = 'GET'; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let h = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; h = values; };
    response.end = value => { if (value) chunks.push(value); resolve({ status, json: h['Content-Type']?.includes('json') ? JSON.parse(chunks.join('')) : undefined }); };
    server.emit('request', request, response);
  });
}

test('API: history, records and record detail respect scope; the graph shows confirmed relationships as their own type', async () => {
  const { db, b, d } = arjun();
  const pair = listMatches(db, REG).data.find(m => m.sources.some(s => s.record_id === d.id) && m.sources.some(s => s.record_id === b.id));
  decideMatch(db, REG, pair.id, { decision: 'same_person', note: 'Confirmed.', confirm: true });
  saveDemo(db);
  assert.equal((await call({ url: `/api/v1/identities/${b.id}/history` })).status, 200);
  assert.equal((await call({ url: `/api/v1/identities/${b.id}/history`, headers: { 'x-demo-role': 'institution' } })).status, 404, 'an RCA record is outside the NITM scope');
  assert.equal((await call({ url: `/api/v1/records/${d.id}`, headers: { 'x-demo-role': 'institution' } })).status, 404);
  const nitm = (await call({ url: '/api/v1/records?versions=all', headers: { 'x-demo-role': 'institution' } })).json;
  assert.ok(nitm.data.every(r => r.institution_code === 'NITM'));
  const graph = (await call({ url: '/api/v1/graph' })).json.data;
  const confirmed = graph.edges.filter(e => e.type === 'confirmed');
  assert.ok(confirmed.length >= 1 && confirmed.every(e => e.evidence.decision.decision === 'same_person'), 'only a recorded reviewer decision produces a confirmed edge');
});
