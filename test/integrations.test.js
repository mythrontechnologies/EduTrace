const { dir } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server');
const { saveDemo, loadDemo } = require('../src/seed');
const { buildDemoDataset } = require('../src/demo-data');
const { noneAdapter, mockAdapter, integrationsFromEnv, SIMULATED_LABEL } = require('../src/integrations');
const { StartupError } = require('../src/mode');

const req = (app, { method = 'GET', url, role = 'regulator', json }) => new Promise(resolve => {
  const r = Readable.from(json === undefined ? [] : [JSON.stringify(json)]); r.method = method; r.url = url; r.headers = { host: 'localhost', 'x-demo-role': role };
  const res = new EventEmitter(); const chunks = []; let status = 200; res.writeHead = c => { status = c; }; res.end = v => { if (v) chunks.push(v); resolve({ status, json: JSON.parse(chunks.join('')) }); };
  app.emit('request', r, res);
});
const get = (app, url, role) => req(app, { url, role });
// A spy around an adapter: records every identifier that would leave EduTrace.
const spy = adapter => { const calls = []; return { ...adapter, kind: adapter.kind, verify: r => { calls.push(r.id); return adapter.verify(r); }, calls }; };

test('by default no external service is connected, and a format check is never presented as verification', async () => {
  saveDemo(buildDemoDataset());
  const app = createApp();
  const status = (await get(app, '/api/v1/integrations')).json.data;
  assert.equal(status.adapter, 'none'); assert.deepEqual(status.services.map(s => s.service), ['apaar', 'abc', 'digilocker']);
  assert.ok(status.services.every(s => s.connected === false && s.simulated === false));
  const v = (await get(app, '/api/v1/records/SRC-3/verification')).json.data;
  assert.equal(v.verification_status, 'not_connected'); assert.equal(v.authoritative, false); assert.equal(v.format_status, 'well_formed');
  assert.match(v.detail, /not identity verification/); assert.match(v.identifier, /^•••• •••• \d{4}$/);
  assert.equal((await get(app, '/api/v1/records/SRC-121/verification', 'institution')).status, 404, 'scope applies');
});

test('the mock adapter is called only with consent, and its results are labelled simulated and never authoritative', async () => {
  saveDemo(buildDemoDataset());
  const adapter = spy(mockAdapter()); const app = createApp({ integrations: adapter });
  const status = (await get(app, '/api/v1/integrations')).json.data;
  assert.ok(status.services.every(s => s.simulated === true && s.connected === false && s.note === SIMULATED_LABEL));
  const none = (await get(app, '/api/v1/records/SRC-8/verification')).json.data; // the synthetic dataset records no consent for SRC-8
  assert.equal(none.consent_status, 'not_recorded'); assert.equal(none.verification_status, 'consent_required');
  assert.deepEqual(adapter.calls, [], 'no identifier was sent without consent');
  for (const id of ['SRC-8', 'SRC-9', 'SRC-7', 'SRC-2']) assert.equal((await req(app, { method: 'POST', url: `/api/v1/records/${id}/consent`, json: { status: 'granted', reference: 'Signed consent form, admission file' } })).status, 201);
  const results = [];
  for (const id of ['SRC-8', 'SRC-9', 'SRC-7']) {
    const v = (await get(app, `/api/v1/records/${id}/verification`)).json.data;
    assert.equal(v.simulated, true); assert.equal(v.authoritative, false); assert.equal(v.label, SIMULATED_LABEL); assert.match(v.verification_status, /^mock_(record_found|no_record)$/);
    results.push(v.verification_status);
  }
  assert.deepEqual(adapter.calls, ['SRC-8', 'SRC-9', 'SRC-7']);
  const malformed = (await get(app, '/api/v1/records/SRC-2/verification')).json.data;
  assert.equal(malformed.verification_status, 'not_checkable'); assert.equal(adapter.calls.length, 3, 'a malformed identifier is not sent');
  assert.equal((await req(app, { method: 'POST', url: '/api/v1/records/SRC-8/consent', json: { status: 'withdrawn', reference: 'Withdrawal letter 2026/14' } })).status, 201);
  assert.equal((await get(app, '/api/v1/records/SRC-8/verification')).json.data.verification_status, 'consent_required', 'withdrawal stops verification');
  assert.equal(adapter.calls.length, 3);
  const again = []; for (const id of ['SRC-9', 'SRC-7']) again.push((await get(app, `/api/v1/records/${id}/verification`)).json.data.verification_status);
  assert.deepEqual(again, results.slice(1), 'deterministic');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'history.js'), 'utf8');
  assert.match(ui, /SIMULATED<\/span>/); assert.match(ui, /Not connected \(APAAR, ABC, DigiLocker\)/);
});

test('consent is an append-only history per student, recorded only within scope and with a reference', async () => {
  saveDemo(buildDemoDataset());
  const app = createApp();
  const bad = [[{ status: 'maybe', reference: 'Form' }, 400], [{ status: 'granted', reference: 'x' }, 400], [{ status: 'granted', reference: 'APAAR 700000000123 form' }, 400]];
  for (const [json, status] of bad) assert.equal((await req(app, { method: 'POST', url: '/api/v1/records/SRC-3/consent', json })).status, status);
  assert.equal((await req(app, { method: 'POST', url: '/api/v1/records/SRC-121/consent', role: 'institution', json: { status: 'granted', reference: 'Signed form' } })).status, 404, 'NITM cannot record consent for an RCA student');
  const before = loadDemo().consentRecords.length;
  await req(app, { method: 'POST', url: '/api/v1/records/SRC-8/consent', json: { status: 'granted', reference: 'Signed consent form' } });
  await req(app, { method: 'POST', url: '/api/v1/records/SRC-8/consent', json: { status: 'withdrawn', reference: 'Withdrawal letter' } });
  const detail = (await get(app, '/api/v1/records/SRC-8')).json.data;
  assert.equal(detail.consent.status, 'withdrawn'); assert.deepEqual(detail.consent.history.map(h => h.status), ['granted', 'withdrawn']);
  assert.equal(detail.apaar.consent_status, 'withdrawn'); assert.equal(detail.apaar.authoritative, false);
  assert.equal(loadDemo().consentRecords.length, before + 2, 'both entries are added and none removed');
  const list = (await get(app, '/api/v1/records?limit=5')).json.data;
  assert.ok(list.every(r => r.apaar_status && ['missing', 'malformed', 'well_formed'].includes(r.apaar_status.format_status)));
  const conflict = (await get(app, '/api/v1/records/SRC-41')).json.data.apaar;
  assert.equal(conflict.conflict_status, 'identifier_conflict'); assert.ok(conflict.open_conditions.includes('IDENTIFIER_ATTRIBUTE_CONFLICT'));
});

test('the adapter choice is validated, and the mock is refused in production', () => {
  assert.equal(integrationsFromEnv({}, 'development').kind, 'none');
  assert.equal(integrationsFromEnv({ EDUTRACE_INTEGRATIONS: 'mock' }, 'demo').kind, 'mock');
  assert.throws(() => integrationsFromEnv({ EDUTRACE_INTEGRATIONS: 'apaar-live' }, 'development'), StartupError);
  assert.throws(() => integrationsFromEnv({ EDUTRACE_INTEGRATIONS: 'mock' }, 'production'), /refused in production/);
  assert.equal(noneAdapter().verify({ apaar_id: 'ABC92' }).format_check, 'malformed');
  const env = { ...process.env, EDUTRACE_INTEGRATIONS: 'live', PORT: '0', EDUTRACE_DB_PATH: path.join(dir, 'never.json') }; delete env.NODE_TEST_CONTEXT; delete env.EDUTRACE_MODE;
  const run = spawnSync(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 1); assert.match(run.stderr, /EDUTRACE_INTEGRATIONS="live" is not recognised/);
});
