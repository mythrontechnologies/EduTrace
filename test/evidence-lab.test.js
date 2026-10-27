const { dbPath } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server, createApp, setProvider } = require('../server');
const { createProvider } = require('../src/ai-provider');
const { saveDemo, loadDemo, DEFAULT_DATA } = require('../src/seed');
const { buildDemoDataset } = require('../src/demo-data');
const { isCurrent, isActiveRecord } = require('../src/engine');
const { commitImport } = require('../src/pipeline');
const { decisionFor } = require('../src/matches');
const { AUTO_LINK_POLICY } = require('../src/identity');
const lab = require('../src/evidence-lab');
const receipts = require('../src/receipts');

setProvider(createProvider({ env: {} }));
const REAL_DB_BEFORE = fs.existsSync(DEFAULT_DATA) ? crypto.createHash('sha256').update(fs.readFileSync(DEFAULT_DATA)).digest('hex') : null;
const REG = { 'x-demo-role': 'regulator' }; const NITM = { 'x-demo-role': 'institution' };
const PRINCIPAL = { role: 'regulator', institution_code: null, name: 'Demo Regulator Reviewer' };
const EVIDENCE = { kind: 'institution_record', reference: 'Registrar letter REG/2026/114' };

function call({ method = 'GET', url, headers = REG, json, raw, app = server }) {
  return new Promise(resolve => {
    const request = Readable.from(raw !== undefined ? [raw] : json === undefined ? [] : [JSON.stringify(json)]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let responseHeaders = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; responseHeaders = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, text, json: responseHeaders['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    app.emit('request', request, response);
  });
}
const fileHash = () => crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
function reseed() { saveDemo(buildDemoDataset()); return loadDemo(); }
// Every authoritative collection, compared as a whole.
const AUTHORITATIVE = ['sourceRecords', 'importBatches', 'findings', 'identityLinks', 'identityLinkEvents', 'matchDecisions', 'correctionCandidates', 'lineageEvents', 'notifications', 'notificationRegistry', 'auditEvents', 'automationRuns', 'decisionReceipts', 'capacityRules'];
const authoritative = db => JSON.stringify(Object.fromEntries(AUTHORITATIVE.map(k => [k, db[k] ?? null])));
const candidateLink = db => db.identityLinks.find(l => l.outcome === 'candidate_for_review' && !decisionFor(db, l));
const simulate = (input, headers = REG) => call({ method: 'POST', url: '/api/v1/simulations/correction', json: input, headers });

// ── A. Non-mutation ──────────────────────────────────────────────────────────────
test('successful, unrecognised, invalid, failed and aborted simulations change no authoritative data', async () => {
  const db = reseed(); const link = candidateLink(db);
  const before = { hash: fileHash(), state: authoritative(loadDemo()) };
  const runs = [
    [{ record_id: link.records[0], field: 'apaar_id', value: '7000-0000-0991', evidence: EVIDENCE, context: { link_id: link.id } }, 200, 'reviewer_confirmed'],
    [{ record_id: 'SRC-281', field: 'date_of_birth', value: '02/02/2004', evidence: EVIDENCE }, 200, 'not_recognised'],
    [{ record_id: 'SRC-201', field: 'enrolment_status', value: 'transferred', evidence: EVIDENCE }, 200, 'reviewer_confirmed'],
    [{ record_id: 'SRC-3', field: 'date_of_birth', value: '31/02/2004', evidence: EVIDENCE }, 400],
    [{ record_id: 'SRC-3', field: 'date_of_birth', value: '2004-04-04' }, 400],
    [{ record_id: 'SRC-3', field: 'colour', value: 'blue', evidence: EVIDENCE }, 400],
    [{ record_id: 'SRC-404', field: 'apaar_id', value: '700000000991', evidence: EVIDENCE }, 404],
    [{ record_id: 'SRC-1', field: 'apaar_id', value: '700000000991', evidence: EVIDENCE }, 409]
  ];
  for (const [input, status, kind] of runs) {
    const res = await simulate(input);
    assert.equal(res.status, status, JSON.stringify(input));
    if (kind) assert.equal(res.json.data.correction_path.kind, kind);
    assert.equal(fileHash(), before.hash, `the database file is unchanged after ${JSON.stringify(input)}`);
  }
  // Aborted: an upload over the body limit is rejected while being read.
  const huge = await call({ method: 'POST', url: '/api/v1/simulations/correction', raw: `{"record_id":"SRC-3","pad":"${'x'.repeat(2 * 1024 * 1024 + 10)}"}` });
  assert.equal(huge.status, 400);
  assert.equal(fileHash(), before.hash);
  assert.equal(authoritative(loadDemo()), before.state);
});

test('a simulation that fails inside the pipeline leaves the caller\'s data untouched and saves nothing', async () => {
  const db = buildDemoDataset(); db.capacityRules = null; // reconcile() throws on this, mid-pipeline
  const snapshot = JSON.stringify(db);
  assert.throws(() => lab.simulateCorrection(db, PRINCIPAL, { record_id: 'SRC-3', field: 'date_of_birth', value: '2004-04-04', evidence: EVIDENCE }));
  assert.equal(JSON.stringify(db), snapshot, 'the input object is byte-identical');
  let saves = 0;
  const app = createApp({ mode: 'development', store: { kind: 'memory', load: () => JSON.parse(snapshot), save: () => { saves++; }, reset: () => { saves++; } } });
  const { error } = console; console.error = () => {};
  try { assert.equal((await call({ app, method: 'POST', url: '/api/v1/simulations/correction', json: { record_id: 'SRC-3', field: 'date_of_birth', value: '2004-04-04', evidence: EVIDENCE } })).status, 500); } finally { console.error = error; }
  assert.equal(saves, 0, 'no save was attempted');
});

test('an in-process simulation leaves the given object byte-identical and never creates a database file', () => {
  const missing = path.join(path.dirname(dbPath), 'never.json');
  const db = buildDemoDataset(); const snapshot = JSON.stringify(db);
  for (const [record_id, field, value] of [['SRC-121', 'apaar_id', '700000000991'], ['SRC-41', 'student_name', 'Student NITM 5'], ['SRC-41', 'date_of_birth', '2005-06-06'], ['SRC-201', 'academic_session', '2025-26'], ['SRC-7', 'programme', 'BSC DATA']]) {
    lab.simulateCorrection(db, PRINCIPAL, { record_id, field, value, evidence: EVIDENCE });
    assert.equal(JSON.stringify(db), snapshot, `${record_id} ${field}`);
  }
  assert.equal(fs.existsSync(missing), false);
});

// ── B. Determinism ───────────────────────────────────────────────────────────────
test('the same state and staged evidence give the same report, run after run', async () => {
  const db = reseed(); const link = candidateLink(db);
  const input = { record_id: link.records[1], field: 'apaar_id', value: '700000000992', evidence: EVIDENCE, context: { link_id: link.id } };
  const a = await simulate(input); const b = await simulate(input);
  assert.equal(a.status, 200);
  assert.equal(a.text, b.text, 'byte-identical reports from two requests, each loading the data afresh');
  assert.deepEqual(lab.simulateCorrection(buildDemoDataset(), PRINCIPAL, input), lab.simulateCorrection(buildDemoDataset(), PRINCIPAL, input));
  assert.ok(!a.json.data.findings.created.some(x => x.after.finding_id), 'findings that exist only in the simulation carry no id');
});

// ── C. Simulation correctness against the official workflow ──────────────────────
// An independent normalisation of the outcome: every current finding, identity link, decision and
// record status, with the corrected version mapped onto the record it replaces and no ids or times.
function normalise(state, canon) {
  const c = id => canon(id);
  const set = ids => [...new Set(ids.map(c))].sort().join(',');
  return {
    findings: state.findings.filter(isCurrent).map(f => `${f.rule_code}|${set(f.evidence)}|${f.review_status}|${f.severity}|${f.automation?.outcome}`).sort(),
    links: (state.identityLinks || []).map(l => `${set(l.records)}|${l.method}|${l.outcome}|${[...l.agreeing_fields].sort()}|${[...l.conflicting_fields].sort()}|${[...l.missing_fields].sort()}|${[...(l.disqualifiers || [])].sort()}|${l.competing_candidates || 0}|${Boolean(l.withdrawn)}|${decisionFor(state, l)?.decision || '-'}`).sort(),
    records: state.sourceRecords.filter(isActiveRecord).map(r => `${c(r.id)}|${r.processing?.status}|${r.lineage?.relation || 'original'}|${r.lineage?.version || 1}`).sort(),
    corrections: (state.correctionCandidates || []).map(x => `${c(x.earlier)}>${c(x.later)}|${x.status}`).sort()
  };
}
const CSV_FIELDS = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'institution_name', 'programme', 'academic_session', 'admission_year', 'enrolment_status', 'seat_category', 'source_reference'];
const cell = v => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
// The official workflow: the institution's corrected file, then a reviewer confirmation if lineage asks for one.
async function officialCorrection(record, field, value) {
  const csv = `${CSV_FIELDS.join(',')}\n${CSV_FIELDS.map(k => cell(k === field ? value : String(record[k] ?? ''))).join(',')}`;
  const imported = await call({ method: 'POST', url: '/api/v1/imports/confirm', json: { filename: 'official-correction.csv', csv, mapping: Object.fromEntries(CSV_FIELDS.map(k => [k, k])), institution_code: record.institution_code } });
  assert.equal(imported.status, 201, imported.text);
  let db = loadDemo();
  const version = db.sourceRecords.find(r => r.import_id === imported.json.data.id);
  const candidate = (db.correctionCandidates || []).find(x => x.status === 'pending' && x.earlier === record.id && x.later === version.id);
  if (candidate) {
    const decided = await call({ method: 'POST', url: `/api/v1/corrections/${candidate.id}/decision`, json: { decision: 'confirm', confirm: true, note: 'Institution confirmed the corrected value.' } });
    assert.equal(decided.status, 200, decided.text);
    db = loadDemo();
  }
  const supersedes = db.sourceRecords.find(r => r.id === record.id).superseded_by === version.id;
  return { db, canon: id => (supersedes && id === version.id ? record.id : id), path: version.lineage.relation === 'correction' && !candidate ? 'institution_reference' : candidate ? 'reviewer_confirmed' : 'not_recognised' };
}

test('the simulated outcome equals the outcome of the same correction made through the official workflow', async () => {
  const cases = [
    ['SRC-121', 'apaar_id', '700000000991'], // a missing identifier supplied: candidate, then confirmation
    ['SRC-41', 'student_name', 'Student NITM 5'], // a name in an identifier conflict
    ['SRC-201', 'enrolment_status', 'transferred'], // a concurrent enrolment
    ['SRC-281', 'date_of_birth', '2004-02-02'], // not recognised as a correction: stored as a separate record
    ['SRC-7', 'programme', 'BSC DATA'] // a context value with a usable identifier
  ];
  for (const [recordId, field, value] of cases) {
    const db = reseed(); const record = db.sourceRecords.find(r => r.id === recordId);
    const run = lab.runSimulation(db, PRINCIPAL, { record_id: recordId, field, value, evidence: EVIDENCE });
    const actual = await officialCorrection(record, field, value);
    assert.equal(run.report.correction_path.kind, actual.path, `${recordId} ${field}: same correction path`);
    const simCanon = run.report.correction_path.kind === 'not_recognised' ? id => (id === run.version.id ? 'NEW' : id) : run.canonOf;
    const actualCanon = actual.path === 'not_recognised' ? id => (actual.db.sourceRecords.find(r => r.id === id)?.import_id?.startsWith('IMP-UP-') && !db.sourceRecords.some(r => r.id === id) ? 'NEW' : id) : actual.canon;
    assert.deepEqual(normalise(run.simState, simCanon), normalise(actual.db, actualCanon), `${recordId} ${field}: predicted state = actual state`);
    // The report's claims hold in the actual state.
    const now = normalise(actual.db, actualCanon);
    for (const x of run.report.findings.resolved) assert.ok(!now.findings.some(f => f.startsWith(`${x.before.rule_code}|${x.before.evidence.map(e => e.record_id).sort().join(',')}|`) && !f.split('|')[2].startsWith('resolved')), `${recordId}: resolved ${x.before.rule_code} is not open in the actual state`);
    for (const x of run.report.findings.created) assert.ok(now.findings.some(f => f.startsWith(`${x.after.rule_code}|`)), `${recordId}: created ${x.after.rule_code} exists`);
    for (const x of run.report.evidence.records_affected.filter(r => r.record.record_id && !r.record.hypothetical)) assert.ok(now.records.some(r => r.startsWith(`${x.record.record_id}|${x.after}|`)), `${recordId}: ${x.record.record_id} status ${x.after}`);
  }
});

test('a correction sent with the institution reference is predicted as applied on import, as the official workflow applies it', async () => {
  reseed();
  // Setup through the official workflow: NITM sends a row with its own reference.
  const csv = `${CSV_FIELDS.join(',')}\n,Kavya Menon,2004-09-14,NITM,,BTECH CSE,2026-27,2026,Active,,NITM-STU-0042`;
  assert.equal((await call({ method: 'POST', url: '/api/v1/imports/confirm', json: { filename: 'with-reference.csv', csv, mapping: Object.fromEntries(CSV_FIELDS.map(k => [k, k])), institution_code: 'NITM' } })).status, 201);
  const state = loadDemo(); const record = state.sourceRecords.find(r => r.source_reference === 'NITM-STU-0042');
  const run = lab.runSimulation(state, PRINCIPAL, { record_id: record.id, field: 'date_of_birth', value: '2004-09-15', evidence: EVIDENCE });
  assert.equal(run.report.correction_path.kind, 'institution_reference');
  const actual = await officialCorrection(record, 'date_of_birth', '2004-09-15');
  assert.equal(actual.path, 'institution_reference');
  assert.deepEqual(normalise(run.simState, run.canonOf), normalise(actual.db, actual.canon));
});

// ── Report content ───────────────────────────────────────────────────────────────
test('the report is labelled a simulation, masks identifiers and never presents a committed decision', async () => {
  const db = reseed(); const link = candidateLink(db);
  const res = await simulate({ record_id: link.records[0], field: 'apaar_id', value: '700000000991', evidence: EVIDENCE, context: { link_id: link.id } });
  const r = res.json.data;
  assert.equal(r.label, 'SIMULATION ONLY — NO AUTHORITATIVE RECORD CHANGED'); assert.equal(r.simulation, true); assert.equal(r.committed, false);
  assert.doesNotMatch(res.text, /700000000991/, 'the staged identifier is masked everywhere');
  assert.equal(r.staged.after, '•••• •••• 0991');
  assert.doesNotMatch(res.text, /RCPT-|"receipt_id"|"receipt":/, 'no receipt in a simulation');
  assert.doesNotMatch(res.text, /confidence|probability|%/i, 'no invented confidence figure');
  assert.ok(r.explanation.caveats.some(c => /not a recommendation to link or merge/.test(c)));
  assert.ok(r.staged.evidence.reference && r.staged.provenance_note.includes('not seen or verified'));
  assert.deepEqual(r.diagnostics, { evaluated_as_of: r.diagnostics.evaluated_as_of, pipeline: r.diagnostics.pipeline, isolated_copies: 2, persisted: false, receipts_created: 0, audit_events_written_to_authoritative_history: 0, model_calls: 0 });
  // Supplying one identifier does not link a pair whose other record still has none.
  assert.ok(r.identity.unresolved_remaining.some(x => x.pair.outcome === 'candidate_for_review'));
  assert.ok(r.explanation.unresolved.some(u => /APAAR identifier: missing/.test(u)));
});

test('a staged value equal to the other record\'s value is flagged, and no change is reported as no change', async () => {
  const db = reseed();
  const conflict = db.findings.find(f => f.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT' && isCurrent(f) && f.review_status !== 'resolved');
  const [a, b] = conflict.evidence.map(id => db.sourceRecords.find(r => r.id === id));
  const r = (await simulate({ record_id: b.id, field: 'student_name', value: a.student_name, evidence: EVIDENCE, context: { finding_id: conflict.id } })).json.data;
  assert.ok(r.staged.warnings.some(w => /Agreement with another record is not evidence/.test(w)));
  assert.ok(r.explanation.unresolved.some(u => /Date of birth: conflicting/.test(u)), 'the remaining date-of-birth conflict still blocks');
  assert.ok(!r.identity.changed.some(x => x.after.outcome === 'auto_linked'), 'one agreeing field never produces a link');
  // A context value that no rule reads changes nothing, and the report says so.
  const quiet = (await simulate({ record_id: 'SRC-250', field: 'enrolment_status', value: 'completed', evidence: EVIDENCE })).json.data;
  assert.equal(quiet.explanation.no_change, true); assert.deepEqual(quiet.explanation.changed, []);
  assert.match(quiet.explanation.headline, /No outcome would change/);
});

test('rejections reveal nothing about records outside the principal\'s scope', async () => {
  reseed();
  const outside = await simulate({ record_id: 'SRC-121', field: 'apaar_id', value: '700000000991', evidence: EVIDENCE }, NITM);
  const nonexistent = await simulate({ record_id: 'SRC-99999', field: 'apaar_id', value: '700000000991', evidence: EVIDENCE }, NITM);
  assert.equal(outside.status, 404); assert.deepEqual(outside.json, nonexistent.json);
  const own = (await simulate({ record_id: 'SRC-6', field: 'enrolment_status', value: 'transferred', evidence: EVIDENCE }, NITM));
  assert.equal(own.status, 200);
  const otherInstitution = /"institution_code":"(RCA|SVU)"/;
  assert.doesNotMatch(JSON.stringify({ f: own.json.data.findings, i: own.json.data.identity, e: own.json.data.evidence }), otherInstitution, 'no RCA or SVU record appears in an NITM reviewer\'s report');
});

// ── D. Evidence checklist ────────────────────────────────────────────────────────
function scratchPairs() {
  const db = { version: 1, institutions: [{ code: 'NITM', name: 'N' }, { code: 'RCA', name: 'R' }, { code: 'SVU', name: 'S' }], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] };
  const headers = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
  const load = (inst, rows, at) => commitImport(db, { parsed: { headers, rows: rows.map(r => ({ institution_code: inst, programme: 'BA', academic_session: '2026-27', enrolment_status: 'Active', apaar_id: '', date_of_birth: '', ...r })), row_numbers: rows.map((_, i) => i + 2) }, mapping: Object.fromEntries(headers.map(h => [h, h])), batchInstitution: inst, multiInstitution: false, filename: `${inst}.csv`, at });
  load('RCA', [{ student_name: 'Asha Rao', date_of_birth: '2005-01-01' }, { student_name: 'Ravi Iyer', date_of_birth: '' }, { student_name: 'Meera Das', date_of_birth: '2003-03-03' }, { student_name: 'Kiran Bose', date_of_birth: '2002-02-02', apaar_id: '911111111111' }], '2026-10-21T09:00:00.000Z');
  load('SVU', [{ student_name: 'Asha Rao', date_of_birth: '2005-01-01' }, { student_name: 'Ravi Iyer', date_of_birth: '2004-04-04' }, { student_name: 'Meera Das', date_of_birth: '2003-04-04' }, { student_name: 'Kiran Bose', date_of_birth: '2002-02-03', apaar_id: '911111111111' }], '2026-10-21T10:00:00.000Z');
  return db;
}
const byName = (db, name) => db.identityLinks.find(l => l.records.every(id => db.sourceRecords.find(r => r.id === id).student_name === name));

test('checklist items come from real rule conditions, and missing evidence is never reported as a conflict', () => {
  const db = scratchPairs();
  const item = (name, field) => lab.evidenceChecklist(db, PRINCIPAL, { link_id: byName(db, name).id }).checklist.items.find(i => i.field === field);
  assert.equal(byName(db, 'Ravi Iyer').outcome, 'insufficient_evidence');
  assert.equal(item('Ravi Iyer', 'date_of_birth').state, 'missing', 'a missing date of birth is missing');
  assert.equal(byName(db, 'Meera Das').outcome, 'not_linked');
  assert.equal(item('Meera Das', 'date_of_birth').state, 'conflicting', 'different dates of birth are a conflict');
  assert.equal(byName(db, 'Kiran Bose').outcome, 'needs_investigation');
  assert.equal(item('Kiran Bose', 'date_of_birth').state, 'conflicting');
  assert.equal(item('Kiran Bose', 'apaar_id').state, 'supporting');
  assert.equal(item('Asha Rao', 'apaar_id').state, 'missing');
  assert.equal(item('Asha Rao', 'apaar_id').blocker, true);
  assert.equal(item('Asha Rao', 'date_of_birth').state, 'supporting');
  for (const name of ['Asha Rao', 'Ravi Iyer', 'Meera Das', 'Kiran Bose']) {
    for (const i of lab.evidenceChecklist(db, PRINCIPAL, { link_id: byName(db, name).id }).checklist.items) {
      assert.ok(['supporting', 'missing', 'conflicting', 'not_comparable'].includes(i.state));
      const m = i.rule.id.match(/^auto-link-2#(\d)$/);
      if (m) assert.equal(i.rule.text, AUTO_LINK_POLICY.conditions[Number(m[1]) - 1], 'the rule text is the policy\'s own condition');
      else assert.match(i.rule.id, /^(candidate-blocking|validate\/|reconcile\/)/);
    }
  }
});

test('checklists carry no student values, never copy values between records and never prescribe a value', async () => {
  const db = reseed();
  const contexts = [...db.identityLinks.filter(l => ['candidate_for_review', 'needs_investigation'].includes(l.outcome)).map(l => ({ link: l.id, ids: l.records })),
    ...db.findings.filter(isCurrent).map(f => ({ finding: f.id, ids: f.evidence }))];
  for (const c of contexts) {
    const res = await call({ url: `/api/v1/evidence/checklist?${c.link ? `link=${c.link}` : `finding=${c.finding}`}` });
    assert.equal(res.status, 200);
    const text = JSON.stringify(res.json.data.checklist);
    for (const r of c.ids.map(id => db.sourceRecords.find(x => x.id === id))) {
      for (const value of [r.student_name, r.date_of_birth, r.apaar_id].filter(v => v && v.length > 3)) assert.ok(!text.includes(value), `checklist for ${c.link || c.finding} does not contain ${value}`);
    }
    assert.doesNotMatch(text, /\b(change|set|update) (it|the value|the name|the date of birth) to\b|\bcopy\b|should be merged|merge the/i);
  }
  const capacity = db.findings.find(f => f.rule_code === 'DEMO_INTAKE_LIMIT_EXCEEDED' && isCurrent(f));
  const cap = (await call({ url: `/api/v1/evidence/checklist?finding=${capacity.id}` })).json.data.checklist;
  assert.deepEqual(cap.items, []); assert.match(cap.limitations[0], /cannot decide which records should count/, 'an unmapped dependency is labelled, not invented');
  assert.equal((await call({ url: '/api/v1/evidence/checklist?finding=nope' })).status, 404);
  assert.equal((await call({ url: '/api/v1/evidence/checklist' })).status, 400);
});

// ── E. Graph overlay ─────────────────────────────────────────────────────────────
test('the graph overlay is labelled and separate, and the authoritative graph is unchanged', async () => {
  reseed();
  const graphBefore = (await call({ url: '/api/v1/graph' })).text;
  const r = (await simulate({ record_id: 'SRC-201', field: 'enrolment_status', value: 'transferred', evidence: EVIDENCE })).json.data;
  const overlay = r.graph_overlay;
  assert.equal(overlay.label, 'SIMULATION ONLY — NO AUTHORITATIVE RECORD CHANGED');
  assert.equal(overlay.focus, 'record:SRC-201');
  assert.ok(overlay.edges.length > 0);
  const authoritativeIds = new Set(JSON.parse(graphBefore).data.edges.map(e => e.id));
  for (const e of overlay.edges) {
    assert.ok(['added', 'removed', 'affected'].includes(e.change)); assert.match(e.id, /^sim:/); assert.ok(!authoritativeIds.has(e.id), 'simulated edges never reuse an authoritative edge id');
    if (e.change !== 'added') assert.ok(authoritativeIds.has(e.authoritative_edge_id), 'removed or affected edges point at the real edge they annotate');
  }
  assert.ok(overlay.edges.some(e => e.change === 'removed' && e.relationship === 'exact'), 'the cleared concurrent-enrolment relationship is marked as removed');
  assert.equal((await call({ url: '/api/v1/graph' })).text, graphBefore, 'the authoritative graph response is byte-identical after the simulation');
});

test('the graph front end draws simulated edges in their own style and removes them on exit', () => {
  const graph = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(graph, /function gExitSimulation\(/); assert.match(graph, /gx\.sim = null/);
  assert.match(graph, /simulated:/, 'a legend and label entry for simulated relationships');
  assert.match(graph, /SIMULATION/);
  assert.match(css, /\.g-edge\.simulated\s*\{[^}]*stroke-dasharray/, 'simulated edges are dashed');
  assert.match(graph, /\['source', 'rejected', 'withdrawn', 'simulated'\]/, 'simulated edges never group records in the layout');
});

// ── F. Decision receipts ─────────────────────────────────────────────────────────
test('canonical serialisation is deterministic and the digest covers everything but the integrity block', () => {
  assert.equal(receipts.canonical({ b: 1, a: [{ d: 1, c: 'x' }], e: undefined }), receipts.canonical({ a: [{ c: 'x', d: 1 }], b: 1 }));
  assert.equal(receipts.canonical({ a: [{ c: 'x', d: 1 }], b: 1 }), '{"a":[{"c":"x","d":1}],"b":1}');
  assert.throws(() => receipts.canonical({ a: Infinity }));
  const r = { schema: 'edutrace.decision-receipt', schema_version: 1, x: 1, integrity: { digest: 'a' } };
  assert.equal(receipts.digestOf(r), receipts.digestOf({ ...r, integrity: { digest: 'b' } }));
  assert.equal(receipts.digestOf(r), receipts.digestOf(JSON.parse(JSON.stringify(r))));
});

test('a committed match decision gets a receipt tied to the real decision, source versions, policy and audit entry', async () => {
  const db = reseed(); const link = candidateLink(db);
  const res = await call({ method: 'POST', url: `/api/v1/matches/${link.id}/decision`, json: { decision: 'needs_more_evidence', note: 'Asked both institutions for admission records.' } });
  assert.equal(res.status, 200);
  const id = res.json.data.decision.receipt_id; assert.match(id, /^RCPT-[0-9a-f]{20}$/);
  const { receipt, verification, limitations } = (await call({ url: `/api/v1/receipts/${id}` })).json.data;
  const after = loadDemo();
  assert.equal(verification.status, 'verified'); assert.equal(verification.integrity, 'verified'); assert.equal(verification.audit.status, 'consistent');
  assert.equal(receipt.schema, 'edutrace.decision-receipt'); assert.equal(receipt.schema_version, 1); assert.equal(receipt.kind, 'identity_match_decision');
  assert.deepEqual(receipt.source_records.map(s => s.record_id), link.records);
  for (const s of receipt.source_records) assert.equal(s.content_sha256, receipts.recordContentHash(after.sourceRecords.find(r => r.id === s.record_id)));
  assert.equal(receipt.subject.link_id, link.id); assert.equal(receipt.policy.identity_policy, 'auto-link-2'); assert.equal(receipt.deterministic_outcome, 'candidate_for_review');
  assert.deepEqual(receipt.field_comparison.missing_fields, link.missing_fields);
  assert.equal(receipt.action.decision, 'needs_more_evidence'); assert.equal(receipt.actor.name, 'Demo Regulator Reviewer'); assert.match(receipt.actor.authentication, /none/);
  const event = after.auditEvents.find(e => e.id === receipt.audit.event_id);
  assert.equal(event.receipt_id, id); assert.equal(event.at, receipt.decided_at);
  assert.equal(receipt.integrity.digest, receipts.digestOf(receipt));
  assert.ok(limitations.some(l => /same writable/.test(l)));
  assert.doesNotMatch(JSON.stringify(limitations), /\bis immutable|tamper-proof|cryptographically signed/i, 'no claim the storage cannot back');
});

test('finding and correction decisions get verified receipts too', async () => {
  const db = reseed();
  const finding = db.findings.find(f => f.rule_code === 'APAAR_MALFORMED' && isCurrent(f) && f.review_status === 'pending');
  assert.equal((await call({ method: 'POST', url: `/api/v1/findings/${finding.id}/decision`, json: { outcome: 'awaiting_verification', note: 'Waiting for the corrected file.' } })).status, 200);
  const audit = (await call({ url: `/api/v1/findings/${finding.id}` })).json.audit.at(-1);
  const fr = (await call({ url: `/api/v1/receipts/${audit.receipt_id}` })).json.data;
  assert.equal(fr.verification.status, 'verified'); assert.equal(fr.receipt.previous_state, 'pending'); assert.equal(fr.receipt.resulting_state, 'awaiting_verification');
  const candidate = loadDemo().correctionCandidates.find(c => c.status === 'pending');
  const decided = await call({ method: 'POST', url: `/api/v1/corrections/${candidate.id}/decision`, json: { decision: 'reject', note: 'A different student; both rows stay.' } });
  const cr = (await call({ url: `/api/v1/receipts/${decided.json.data.candidate.receipt_id}` })).json.data;
  assert.equal(cr.verification.status, 'verified'); assert.equal(cr.receipt.kind, 'correction_decision'); assert.equal(cr.receipt.resulting_state, 'rejected');
  const raw = [candidate.earlier, candidate.later].map(id => loadDemo().sourceRecords.find(r => r.id === id).apaar_id).filter(Boolean);
  for (const value of raw) assert.ok(!JSON.stringify(cr.receipt).includes(value), 'identifiers in a correction receipt are masked');
  assert.ok(cr.receipt.field_comparison.changes.every(c => c.field !== 'apaar_id' || /^•••• •••• /.test(c.to)));
});

test('a modified receipt, a modified audit entry and a malformed receipt each fail verification', async () => {
  const db = reseed(); const link = candidateLink(db);
  const id = (await call({ method: 'POST', url: `/api/v1/matches/${link.id}/decision`, json: { decision: 'needs_more_evidence', note: 'Original note.' } })).json.data.decision.receipt_id;
  let state = loadDemo();
  state.decisionReceipts.find(r => r.receipt_id === id).action.note = 'Edited note.'; saveDemo(state);
  let v = (await call({ url: `/api/v1/receipts/${id}` })).json.data.verification;
  assert.equal(v.status, 'mismatch'); assert.equal(v.integrity, 'mismatch'); assert.notEqual(v.recomputed_digest, v.stored_digest);
  state = loadDemo(); state.decisionReceipts.find(r => r.receipt_id === id).action.note = 'Original note.';
  state.auditEvents.find(e => e.receipt_id === id).note = 'Rewritten audit note.'; saveDemo(state);
  v = (await call({ url: `/api/v1/receipts/${id}` })).json.data.verification;
  assert.equal(v.integrity, 'verified'); assert.equal(v.status, 'audit_mismatch');
  state = loadDemo(); state.decisionReceipts.find(r => r.receipt_id === id).schema_version = 99; saveDemo(state);
  assert.equal((await call({ url: `/api/v1/receipts/${id}` })).json.data.verification.status, 'invalid');
  assert.equal(receipts.verifyReceipt(state, null).status, 'missing');
  assert.equal((await call({ url: '/api/v1/receipts/RCPT-unknown' })).status, 404);
  assert.equal((await call({ url: `/api/v1/receipts/${id}`, headers: NITM })).status, 404, 'a receipt outside the scope is not found');
});

test('a simulation never creates a receipt, a decision or an audit event', async () => {
  const link = candidateLink(reseed());
  const before = loadDemo();
  await simulate({ record_id: link.records[0], field: 'apaar_id', value: '700000000991', evidence: EVIDENCE, context: { link_id: link.id } });
  await simulate({ record_id: 'SRC-201', field: 'enrolment_status', value: 'transferred', evidence: EVIDENCE });
  const after = loadDemo();
  assert.deepEqual(after.decisionReceipts || [], before.decisionReceipts || []);
  assert.deepEqual(after.auditEvents, before.auditEvents); assert.deepEqual(after.matchDecisions, before.matchDecisions); assert.deepEqual(after.lineageEvents, before.lineageEvents);
});

// ── G. Regression and isolation ──────────────────────────────────────────────────
test('a simulation never calls a model, even with a provider configured', async () => {
  reseed();
  let calls = 0;
  setProvider(createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test' }, transport: async () => { calls++; throw new Error('unexpected'); } }));
  const original = globalThis.fetch; let fetches = 0; globalThis.fetch = async () => { fetches++; throw new Error('network'); };
  try { assert.equal((await simulate({ record_id: 'SRC-121', field: 'apaar_id', value: '700000000991', evidence: EVIDENCE })).status, 200); }
  finally { globalThis.fetch = original; setProvider(createProvider({ env: {} })); }
  assert.equal(calls, 0); assert.equal(fetches, 0);
});

test('the policy, its version and the lineage rules are unchanged by this feature', () => {
  assert.equal(AUTO_LINK_POLICY.version, 'auto-link-2');
  assert.equal(AUTO_LINK_POLICY.conditions.length, 4);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'evidence-lab.js'), 'utf8');
  assert.doesNotMatch(source, /function (compareRecords|buildIdentityLinks|reconcile|mergeFindings|applyAutomation|assignLineage)\b/, 'the lab defines none of the rule functions; it calls them');
  assert.match(source, /commitImport\(simState/); assert.match(source, /decideCorrection\(simState/); assert.match(source, /processAll\(baseState/);
  assert.doesNotMatch(source, /saveDemo|writeFileSync|require\('\.\/ai-provider'\)|\bfetch\(/, 'no persistence or model access in the lab');
});

test('the working database is unchanged by this file', () => {
  const now = fs.existsSync(DEFAULT_DATA) ? crypto.createHash('sha256').update(fs.readFileSync(DEFAULT_DATA)).digest('hex') : null;
  assert.equal(now, REAL_DB_BEFORE);
});
