require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createApp, start } = require('../server');
const { StartupError } = require('../src/mode');
const { createSyntheticTestStore, syntheticTestAuthenticator, TEST_INSTITUTIONS } = require('../src/synthetic-test');
const { createDemoStore } = require('../src/demo-data');
const { createProvider } = require('../src/ai-provider');
const path = require('node:path');

const MAPPING = {
  apaar_id: 'apaar_id', student_name: 'student_name', date_of_birth: 'date_of_birth',
  institution_code: 'institution_code', institution_name: 'institution_name', programme: 'programme',
  academic_session: 'academic_session', enrolment_status: 'enrolment_status', source_reference: 'source_reference'
};
const csvFor = (code = 'TSTA', label = 'NEW-001') =>
  `apaar_id,student_name,date_of_birth,institution_code,institution_name,programme,academic_session,enrolment_status,source_reference\n` +
  `99999999${String([...`${code}-${label}`].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 10000).padStart(4, '0')},Synthetic Student ${label},,${code},Synthetic Institution ${code === 'TSTA' ? 'A' : 'B'},SYNTHETIC PROGRAMME,SYNTHETIC-2026,Active,SYNTH-REF-${code}-${label}`;

function caller(app, { method = 'GET', url, institution = 'TSTA', headers = {}, body, raw } = {}) {
  return new Promise(resolve => {
    const req = new Readable({ read() { if (raw) this.push(raw); else if (body !== undefined) this.push(JSON.stringify(body)); this.push(null); } });
    req.method = method; req.url = url; req.headers = { host: '127.0.0.1', ...(institution ? { 'x-edutrace-test-institution': institution } : {}), ...headers };
    const res = new EventEmitter(); let status = 200; let responseHeaders = {}; const chunks = [];
    res.writeHead = (code, values) => { status = code; responseHeaders = values; };
    res.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, headers: responseHeaders, text, json: responseHeaders['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    app.emit('request', req, res);
  });
}
const appFor = (store = createSyntheticTestStore()) => createApp({
  mode: 'synthetic-test', store, auth: syntheticTestAuthenticator(),
  getProvider: () => createProvider({ env: {}, disabled: 'Synthetic test mode disables model assistance.' })
});
const close = app => new Promise(resolve => app.close(() => resolve()));
const confirmation = (code = 'TSTA', label = 'NEW-001') => ({
  filename: `synthetic-${code.toLowerCase()}-import.csv`, csv: csvFor(code, label), mapping: MAPPING,
  institution_code: code, multi_institution: false
});

test('synthetic-test startup rejects persistent, account, provider, hosted and non-loopback configuration', () => {
  for (const env of [
    { EDUTRACE_DB_PATH: 'must-not-be-read.json' }, { EDUTRACE_STORE: 'json' },
    { EDUTRACE_USERS_PATH: 'must-not-be-read.json' }, { EDUTRACE_DATABASE_URL: 'postgres://not-used' },
    { EDUTRACE_AI_PROVIDER: 'anthropic' }, { ANTHROPIC_API_KEY: 'secret-placeholder' },
    { RENDER: 'true' }, { HOST: '0.0.0.0' }
  ]) assert.throws(() => start({ EDUTRACE_MODE: 'synthetic-test', PORT: '0', ...env }), StartupError);
  assert.throws(() => start({ EDUTRACE_MODE: 'synthetic-test', PORT: 'nope' }), /PORT must be an integer/);
  assert.equal(TEST_INSTITUTIONS.length, 2);
});

test('synthetic-test serves only on IPv4 loopback and reports an ephemeral in-memory environment', async () => {
  const log = console.log; console.log = () => {};
  const watched = ['readFileSync', 'writeFileSync', 'existsSync', 'renameSync', 'mkdirSync', 'openSync'];
  const originals = Object.fromEntries(watched.map(name => [name, fs[name]])); const persistentTouches = [];
  for (const name of watched) fs[name] = function (target, ...args) { const path = String(target); if (/demo-db\.json|users\.json|\.sqlite|\.db$/i.test(path)) persistentTouches.push(`${name} ${path}`); return originals[name].call(this, target, ...args); };
  const app = start({ EDUTRACE_MODE: 'synthetic-test', PORT: '0' });
  try {
    await new Promise(resolve => app.once('listening', resolve));
    assert.equal(app.address().address, '127.0.0.1');
    const runtime = await caller(app, { url: '/api/v1/runtime', institution: null });
    assert.equal(runtime.json.data.mode, 'synthetic-test');
    assert.equal(runtime.json.data.read_only, false);
    assert.equal(runtime.json.data.data_source, 'synthetic_test_in_memory');
    assert.equal(runtime.json.data.auth, 'synthetic_test');
    assert.match(runtime.json.data.note, /discarded on restart/);
    assert.equal((await caller(app, { url: '/api/v1/institutions', institution: null })).json.data.length, 2);
    assert.equal((await caller(app, { url: '/api/v1/records' })).json.total, 3);
  } finally { console.log = log; await close(app); Object.assign(fs, originals); }
  assert.deepEqual(persistentTouches, [], 'runtime and import-scope data use no JSON or database files');
});

test('synthetic partitions are generated independently and a new store restores the baseline', async () => {
  const store = createSyntheticTestStore(); const app = appFor(store);
  try {
    const a = await caller(app, { url: '/api/v1/records' });
    const b = await caller(app, { url: '/api/v1/records', institution: 'TSTB' });
    assert.equal(a.json.total, 3); assert.ok(a.json.data.every(record => record.institution_code === 'TSTA'));
    assert.equal(b.json.total, 3); assert.ok(b.json.data.every(record => record.institution_code === 'TSTB'));
    assert.ok(a.json.data.every(record => /^synthetic-/.test(record.source_file)));
    assert.equal((await caller(app, { url: '/api/v1/institutions' })).json.data.length, 2);
    const summaryA = (await caller(app, { url: '/api/v1/dashboard/summary' })).json.data;
    const summaryB = (await caller(app, { url: '/api/v1/dashboard/summary', institution: 'TSTB' })).json.data;
    assert.deepEqual([summaryA.institutions, summaryA.imported_records, summaryA.seeded_fixture_records, summaryA.session_imported_records], [1, 3, 3, 0]);
    assert.deepEqual([summaryB.institutions, summaryB.imported_records, summaryB.seeded_fixture_records, summaryB.session_imported_records], [1, 3, 3, 0]);
    assert.equal((await caller(app, { url: '/api/v1/records' })).status, 200);
  } finally { await close(app); }
  const reset = appFor(createSyntheticTestStore());
  try { assert.equal((await caller(reset, { url: '/api/v1/records' })).json.total, 3); }
  finally { await close(reset); }
});

test('CSV preview, validation and confirmation commit only the selected synthetic partition', async () => {
  const app = appFor();
  try {
    const input = { filename: 'synthetic-tsta-workflow.csv', csv: fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic-tsta-workflow.csv'), 'utf8'), institution_code: 'TSTA', multi_institution: false };
    const preview = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', body: input });
    assert.equal(preview.status, 200); assert.equal(preview.json.data.total_rows, 5);
    assert.deepEqual(preview.json.data.unmapped_required_fields, []);
    assert.equal(preview.json.data.mapping.student_name, 'student_name');
    assert.deepEqual([preview.json.data.dry_run.ready, preview.json.data.dry_run.with_warnings, preview.json.data.dry_run.rejected, preview.json.data.dry_run.skipped], [3, 1, 1, 0]);
    assert.equal(preview.json.data.dry_run.batch_institution, 'TSTA');
    const result = await caller(app, { method: 'POST', url: '/api/v1/imports/confirm', body: { ...input, mapping: preview.json.data.mapping }, headers: { 'idempotency-key': 'test-import-0001' } });
    assert.equal(result.status, 201); assert.equal(result.json.data.imported, 4);
    assert.equal(result.json.data.rejected, 1); assert.equal(result.json.data.skipped, 0);
    assert.deepEqual(result.json.data.row_outcomes.slice(0, 3).map(row => row.validation_issues), [[], [], []]);
    assert.ok(result.json.data.row_outcomes[3].validation_issues.includes('APAAR_MALFORMED'));
    assert.equal(result.json.data.row_outcomes[4].outcome, 'rejected');
    assert.equal((await caller(app, { url: '/api/v1/records' })).json.total, 7);
    const rows = await caller(app, { url: '/api/v1/records' });
    const importedRecord = rows.json.data.find(row => row.source_file === 'synthetic-tsta-workflow.csv');
    assert.ok(importedRecord?.record_id);
    const reconciled = await caller(app, { url: `/api/v1/records/${importedRecord.record_id}` });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.json.data.processing.identifier_check, 'locally_well_formed');
    const summary = await caller(app, { url: '/api/v1/dashboard/summary' });
    assert.deepEqual([summary.json.data.imported_records, summary.json.data.seeded_fixture_records, summary.json.data.session_imported_records], [7, 3, 4]);
    assert.equal(summary.json.data.active_enrolments, 7);
    const batches = await caller(app, { url: '/api/v1/imports' });
    const importedBatch = batches.json.data.find(batch => batch.id === result.json.data.id);
    assert.equal(importedBatch.seeded, false);
    assert.equal(batches.json.data.find(batch => batch.id === 'SYNTH-TSTA-BASELINE').seeded, true);
    assert.equal(batches.json.data.find(batch => batch.id === 'SYNTH-TSTA-BASELINE').imported, 3);
    const audit = await caller(app, { url: '/api/v1/audit' });
    assert.ok(audit.json.data.some(item => item.action === 'import_batch_committed' && item.institution_code === 'TSTA'));
  } finally { await close(app); }
});

test('custom CSV headers can be mapped without exposing unmapped row values', async () => {
  const app = appFor();
  const headers = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'];
  const custom = {
    filename: 'synthetic-custom.csv',
    csv: `${headers.join(',')}\nSYNTH-ID-TSTA-CUSTOM-1,Synthetic Student CUSTOM-1,SYNTH-DATE-2005-02-02,TSTA,Synthetic Institution A,SYNTHETIC PROGRAMME,SYNTHETIC-2026,Active,SYNTH-REF-TSTA-CUSTOM-1`,
    institution_code: 'TSTA'
  };
  try {
    const first = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', body: custom });
    assert.equal(first.status, 200); assert.equal(first.json.data.unmapped_required_fields.length, 5);
    assert.deepEqual(first.json.data.sample, []);
    assert.ok(Object.values(first.json.data.header_samples).every(value => /^Hidden/.test(value)));
    const mapping = Object.fromEntries(Object.keys(MAPPING).map((key, index) => [key, headers[index]]));
    const second = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', body: { ...custom, mapping } });
    assert.equal(second.status, 200); assert.equal(second.json.data.total_rows, 1);
  } finally { await close(app); }
});

test('invalid UTF-8, malformed, unsupported, oversized and non-synthetic CSV inputs are rejected', async () => {
  const app = appFor();
  try {
    const malformed = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', body: { ...confirmation(), csv: 'a,b\n"unclosed,x' } });
    assert.equal(malformed.status, 400); assert.match(malformed.json.error, /Malformed CSV/);
    const delimiter = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', body: { ...confirmation(), csv: 'a;b\n1;2' } });
    assert.equal(delimiter.status, 400); assert.match(delimiter.json.error, /comma-separated/);
    const nonSynthetic = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', body: { ...confirmation(), csv: csvFor().replace('Synthetic Student', 'Student') } });
    assert.equal(nonSynthetic.status, 400); assert.match(nonSynthetic.json.error, /generated synthetic name/);
    const huge = JSON.stringify({ ...confirmation(), csv: `${csvFor()}${'x'.repeat(2 * 1024 * 1024)}` });
    const oversized = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', raw: Buffer.from(huge) });
    assert.equal(oversized.status, 413); assert.equal(oversized.json.code, 'body_too_large');
    const tooManyRows = `${Object.keys(MAPPING).join(',')}\n${Array.from({ length: 5001 }, (_, i) => `SYNTH-ID-TSTA-R${i},Synthetic Student R${i},01/01/2005,TSTA,Synthetic Institution A,SYNTHETIC PROGRAMME,SYNTHETIC-2026,Active,SYNTH-REF-TSTA-R${i}`).join('\n')}`;
    const rowLimit = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', body: { ...confirmation(), csv: tooManyRows } });
    assert.equal(rowLimit.status, 400); assert.match(rowLimit.json.error, /5000-row prototype limit/);
    const invalidUtf8 = await caller(app, { method: 'POST', url: '/api/v1/imports/preview', headers: { 'content-type': 'application/json' }, raw: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]) });
    assert.equal(invalidUtf8.status, 400); assert.match(invalidUtf8.json.error, /UTF-8/);
    assert.equal((await caller(app, { url: '/api/v1/records' })).json.total, 3, 'rejected inputs do not mutate data');
  } finally { await close(app); }
});

test('synthetic imports never enter the existing read-only demo dataset', async () => {
  const demoStore = createDemoStore(); const fingerprint = demoStore.fingerprint; const demoRecords = demoStore.load().sourceRecords.length;
  const demo = createApp({ mode: 'demo', store: demoStore }); const synthetic = appFor();
  try {
    const imported = await caller(synthetic, { method: 'POST', url: '/api/v1/imports/confirm', body: confirmation(), headers: { 'idempotency-key': 'leak-check-key-1' } });
    assert.equal(imported.status, 201);
    assert.equal((await caller(demo, { url: '/api/v1/records', institution: null, headers: { 'x-demo-role': 'regulator' } })).status, 200);
    const after = demoStore.load();
    assert.equal(after.sourceRecords.length, demoRecords);
    assert.equal(demoStore.fingerprint, fingerprint);
    assert.equal((await caller(demo, { method: 'POST', url: '/api/v1/imports/confirm', institution: null, body: { ...confirmation(), institution_code: 'NITM' }, headers: { 'x-demo-role': 'regulator' } })).status, 403);
    const principal = await caller(synthetic, { url: '/api/v1/dashboard/summary', headers: { 'x-demo-role': 'regulator' } });
    assert.equal(principal.json.principal.role, 'institution', 'the client role header cannot change the server principal');
  } finally { await close(demo); await close(synthetic); }
});

test('idempotent retries return the original result, while conflicting reuse is refused', async () => {
  const app = appFor(); const input = confirmation(); const headers = { 'idempotency-key': 'retry-key-0001' };
  try {
    const first = await caller(app, { method: 'POST', url: '/api/v1/imports/confirm', body: input, headers });
    const retry = await caller(app, { method: 'POST', url: '/api/v1/imports/confirm', body: input, headers });
    assert.equal(retry.status, 201); assert.deepEqual(retry.json, first.json);
    assert.equal((await caller(app, { url: '/api/v1/records' })).json.total, 4);
    const conflict = await caller(app, { method: 'POST', url: '/api/v1/imports/confirm', body: confirmation('TSTA', 'NEW-002'), headers });
    assert.equal(conflict.status, 409); assert.equal(conflict.json.code, 'idempotency_conflict');
    assert.equal((await caller(app, { url: '/api/v1/imports' })).json.data.length, 2, 'baseline and one committed batch only');
  } finally { await close(app); }
});

test('failed commits roll back and concurrent identical confirmations commit once', async () => {
  let fail = true;
  const store = createSyntheticTestStore({ beforeCommit() { if (fail) { fail = false; throw new Error('synthetic injected transaction failure'); } } });
  const app = appFor(store); const input = confirmation(); const headers = { 'idempotency-key': 'atomic-key-0001' };
  const oldError = console.error; console.error = () => {};
  try {
    const failed = await caller(app, { method: 'POST', url: '/api/v1/imports/confirm', body: input, headers });
    assert.equal(failed.status, 500);
    assert.equal((await caller(app, { url: '/api/v1/records' })).json.total, 3);
    assert.equal((await caller(app, { url: '/api/v1/imports' })).json.data.length, 1);
    const concurrent = await Promise.all([1, 2].map(() => caller(app, { method: 'POST', url: '/api/v1/imports/confirm', body: input, headers })));
    assert.ok(concurrent.every(item => item.status === 201));
    assert.equal(concurrent[0].json.data.id, concurrent[1].json.data.id);
    assert.equal((await caller(app, { url: '/api/v1/records' })).json.total, 4);
    assert.equal((await caller(app, { url: '/api/v1/imports' })).json.data.length, 2);
  } finally { console.error = oldError; await close(app); }
});

test('institution scopes cannot read or alter each other, and every non-import write stays rejected', async () => {
  const app = appFor();
  const writes = [
    '/api/v1/matches/fake/decision', '/api/v1/matches/fake/explain', '/api/v1/corrections/fake/decision',
    '/api/v1/notifications/fake/acknowledge', '/api/v1/automation/revalidate', '/api/v1/findings/fake/assist',
    '/api/v1/findings/fake/decision', '/api/v1/demo/reset', '/api/v1/admin/initialize-empty-import',
    '/api/v1/ai/check', '/api/v1/auth/register', '/api/v1/auth/login', '/api/v1/auth/logout',
    '/api/v1/records/fake/consent', '/api/v1/simulations/correction'
  ];
  try {
    const b = await caller(app, { method: 'POST', url: '/api/v1/imports/confirm', institution: 'TSTB', body: confirmation('TSTB', 'OTHER-001'), headers: { 'idempotency-key': 'tenant-b-key-0001' } });
    assert.equal(b.status, 201);
    const bRows = (await caller(app, { url: '/api/v1/records', institution: 'TSTB' })).json.data;
    const bRow = bRows.find(row => row.source_file === 'synthetic-tstb-import.csv');
    const bId = bRow.record_id || bRow.id;
    assert.ok(bId);
    const aRows = (await caller(app, { url: '/api/v1/records', institution: 'TSTA' })).json.data;
    assert.ok(aRows.every(row => row.institution_code === 'TSTA'));
    assert.equal((await caller(app, { url: `/api/v1/records/${bId}`, institution: 'TSTA' })).status, 404);
    for (const url of ['/api/v1/findings?lifecycle=all', '/api/v1/matches', '/api/v1/automation']) {
      assert.doesNotMatch((await caller(app, { url, institution: 'TSTA' })).text, new RegExp(bId), `${url} excludes Institution B source IDs`);
    }
    const aAudit = (await caller(app, { url: '/api/v1/audit', institution: 'TSTA' })).json.data;
    assert.ok(aAudit.every(item => item.institution_code !== 'TSTB'));
    const before = (await caller(app, { url: '/api/v1/records', institution: 'TSTB' })).json.total;
    const spoof = await caller(app, { method: 'POST', url: '/api/v1/imports/confirm', institution: 'TSTA', body: confirmation('TSTB', 'SPOOF-001'), headers: { 'idempotency-key': 'spoof-key-00001' } });
    assert.equal(spoof.status, 403);
    assert.equal((await caller(app, { url: '/api/v1/records', institution: 'TSTB' })).json.total, before);
    for (const url of writes) assert.equal((await caller(app, { method: 'POST', url, body: {} })).status, 403, url);
    assert.equal((await caller(app, { url: '/api/v1/records', institution: 'UNKNOWN' })).status, 401);
    assert.equal((await caller(app, { url: '/api/v1/records', institution: null })).status, 401);
  } finally { await close(app); }
});

test('test-mode UI is explicitly labeled and the read-only demo remains unchanged', () => {
  const appJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const importJs = fs.readFileSync(require.resolve('../public/import.js'), 'utf8');
  const demoJs = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  assert.match(appJs, /Ephemeral synthetic test environment/);
  assert.match(appJs, /x-edutrace-test-institution/);
  assert.match(appJs, /Institutions available for testing · current records scope/);
  assert.match(appJs, /Records in current institution/);
  assert.match(appJs, /seeded fixtures · \$\{d\.session_imported_records\} imported this session/);
  assert.match(appJs, /await refreshPrincipal\(\);\s*renderRoute\(\{ force: true \}\)/);
  assert.match(importJs, /Use filenames beginning with “synthetic-”/);
  assert.match(importJs, /batch stays in this ephemeral synthetic test session/);
  assert.match(demoJs, /Read-only demo\.<\/strong> Synthetic records only, held in memory/);
  assert.match(importJs, /Uploads are disabled in this demo/);
});
