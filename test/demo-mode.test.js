const { dir, dbPath } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { createApp, start, setProvider, READ_ONLY } = require('../server');
const { createDemoStore, buildDemoDataset, ReadOnlyError } = require('../src/demo-data');
const { hostedDemoAuthenticator } = require('../src/auth');
const { createProvider } = require('../src/ai-provider');
const { DEFAULT_DATA } = require('../src/seed');
const { HOSTING_MARKERS } = require('../src/mode');
const { hashPassword } = require('../src/accounts');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => (fs.existsSync(file) ? sha(fs.readFileSync(file)) : null);
const REAL_DB_BEFORE = fileHash(DEFAULT_DATA);
const HOSTED_TEST_PASSWORD = 'test-only-hosted-viewer-password-2026';
const HOSTED_TEST_PASSWORD_HASH = hashPassword(HOSTED_TEST_PASSWORD);

// Drives an app in-process, like the other API tests. `onBodyRead` fires if the handler reads the request body.
function call(app, { method = 'GET', url, headers = {}, json, onBodyRead }) {
  return new Promise(resolve => {
    const payload = json === undefined ? null : JSON.stringify(json);
    let sent = false;
    const request = new Readable({ read() { if (onBodyRead) onBodyRead(); if (!sent && payload) { sent = true; this.push(payload); } this.push(null); } });
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let responseHeaders = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; responseHeaders = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, headers: responseHeaders, text, json: responseHeaders['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    app.emit('request', request, response);
  });
}
const AS = { regulator: { 'x-demo-role': 'regulator' }, institution: { 'x-demo-role': 'institution' } };
// Headers a visitor might try in order to look privileged or to change the mode.
const SPOOF = { 'x-demo-role': 'regulator', 'x-demo-institution': 'RCA', 'x-edutrace-mode': 'development', 'x-http-method-override': 'GET', 'x-forwarded-for': '127.0.0.1', authorization: 'Bearer admin', cookie: 'role=regulator; mode=development' };

// Records every filesystem call that names a path outside public/ (static assets are the only files demo mode may read).
function watchFs() {
  const names = ['readFileSync', 'writeFileSync', 'renameSync', 'existsSync', 'mkdirSync', 'statSync', 'openSync', 'readFile', 'writeFile', 'rename', 'mkdir', 'rmSync', 'unlinkSync', 'copyFileSync', 'appendFileSync'];
  const original = Object.fromEntries(names.map(name => [name, fs[name]]));
  const touched = [];
  for (const name of names) fs[name] = function (target, ...rest) { const file = typeof target === 'string' ? path.resolve(target) : String(target); if (!file.startsWith(PUBLIC + path.sep)) touched.push(`${name} ${file}`); return original[name].call(this, target, ...rest); };
  return { touched, restore: () => Object.assign(fs, original) };
}
// Replaces fetch (the only way the provider reaches a model) with a recorder that fails loudly.
function watchFetch() {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (...args) => { calls.push(String(args[0])); throw new Error('network call attempted'); };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// The same environment a configured developer machine would have: a local and a remote provider, a database path.
const PROVIDER_ENV = { EDUTRACE_AI_PROVIDER: 'ollama', EDUTRACE_OLLAMA_URL: 'http://127.0.0.1:11434', EDUTRACE_AI_LOCAL_NAMES: 'true', ANTHROPIC_API_KEY: 'sk-ant-test-not-a-real-key' };
function startDemo(extra = {}) {
  const log = { warn: [], info: [] }; const { warn, log: info } = console;
  console.warn = (...a) => log.warn.push(a.join(' ')); console.log = (...a) => log.info.push(a.join(' '));
  try { const app = start({ EDUTRACE_MODE: 'demo', PORT: '0', EDUTRACE_DB_PATH: dbPath, ...PROVIDER_ENV, ...extra }); return { app, log }; } finally { console.warn = warn; console.log = info; }
}
const closeApp = app => new Promise(resolve => app.close(() => resolve()));

let fixture;
function ids() {
  if (fixture) return fixture;
  const db = buildDemoDataset();
  const reviewable = db.identityLinks.find(l => l.outcome === 'candidate_for_review');
  fixture = {
    link: reviewable.id,
    pendingCorrection: db.correctionCandidates.find(c => c.status === 'pending').id,
    notification: db.notifications.find(n => !n.acknowledged).id,
    finding: db.findings.find(f => f.lifecycle_status === 'current' && f.review_status === 'pending').id,
    candidateFinding: db.findings.find(f => f.rule_code === 'CANDIDATE_IDENTITY_MATCH' && f.lifecycle_status === 'current').id,
    record: 'SRC-1', corrected: db.correctionCandidates.find(c => c.status === 'confirmed').later
  };
  return fixture;
}
const csv = 'apaar_id,student_name,date_of_birth,institution_code,programme,academic_session,enrolment_status\n799999999999,Visitor Upload,01/01/2005,NITM,BTECH CSE,2026-27,Active';
const mapping = { apaar_id: 'apaar_id', student_name: 'student_name', date_of_birth: 'date_of_birth', institution_code: 'institution_code', programme: 'programme', academic_session: 'academic_session', enrolment_status: 'enrolment_status' };
// Every state-changing route registered in server.js, with a body that would succeed in development.
function mutations() {
  const x = ids();
  return [
    ['POST', `/api/v1/matches/${x.link}/decision`, { decision: 'same_person', confirm: true, note: 'visitor' }],
    ['POST', `/api/v1/matches/${x.link}/explain`, {}],
    ['POST', `/api/v1/corrections/${x.pendingCorrection}/decision`, { decision: 'confirm', confirm: true, note: 'visitor' }],
    ['POST', `/api/v1/notifications/${x.notification}/acknowledge`, {}],
    ['POST', '/api/v1/automation/revalidate', {}],
    ['POST', `/api/v1/findings/${x.finding}/assist`, {}],
    ['POST', `/api/v1/findings/${x.finding}/decision`, { outcome: 'dismissed', note: 'visitor' }],
    ['POST', '/api/v1/imports/preview', { filename: 'upload.csv', csv }],
    ['POST', '/api/v1/imports/confirm', { filename: 'upload.csv', csv, mapping, institution_code: 'NITM' }],
    ['POST', '/api/v1/demo/reset', {}],
    ['POST', '/api/v1/admin/initialize-empty-import', { confirmation: 'INITIALIZE_EMPTY_IMPORT' }],
    ['POST', '/api/v1/ai/check', {}],
    ['POST', '/api/v1/auth/register', { institution: 'NITM', full_name: 'Synthetic Visitor', username: 'visitor.test', password: 'synthetic-password-123', confirm_password: 'synthetic-password-123' }],
    ['POST', '/api/v1/auth/login', { username: 'visitor', password: 'a-long-password-123' }],
    ['POST', '/api/v1/auth/logout', {}],
    ['POST', `/api/v1/records/${x.record}/consent`, { status: 'granted', reference: 'Signed consent form' }],
    ['POST', '/api/v1/simulations/correction', { record_id: x.record, field: 'apaar_id', value: '700000000991', evidence: { kind: 'institution_record', reference: 'Registrar letter' } }]
  ];
}
// Other methods and paths a client could try.
const OTHER_WRITES = [['PUT', '/api/v1/findings/x'], ['PATCH', '/api/v1/records/SRC-1'], ['DELETE', '/api/v1/audit'], ['OPTIONS', '/api/v1/findings'], ['POST', '/api/v1/unknown'], ['POST', '/healthz'], ['POST', '/'], ['TRACE', '/api/v1/dashboard/summary']];
// Every registered GET route, with real ids, so no read path is missed.
function reads() {
  const x = ids();
  return ['/', '/styles.css', '/app.js', '/reconciliation.js', '/import.js', '/graph.js', '/matches.js', '/profile.js', '/history.js', '/healthz', '/api/v1/runtime',
    '/api/v1/dashboard/summary', '/api/v1/audit?limit=200', '/api/v1/imports', '/api/v1/ai/status', '/api/v1/automation', '/api/v1/matches', `/api/v1/matches/${x.link}`,
    '/api/v1/records', '/api/v1/records?q=student', `/api/v1/records/${x.record}`, `/api/v1/records/${x.corrected}/lineage`, `/api/v1/identities/${x.corrected}/history`, `/api/v1/identities/${x.corrected}/history?as_of=2026-10-21`,
    `/api/v1/profiles/${x.corrected}`, '/api/v1/corrections?status=all', '/api/v1/corrections', '/api/v1/notifications', '/api/v1/graph', '/api/v1/graph?institution=NITM&relationship=candidate',
    '/api/v1/findings', '/api/v1/findings?lifecycle=all&q=nitm', `/api/v1/findings/${x.finding}`, `/api/v1/findings/${x.candidateFinding}/explanation`, '/api/v1/reports/findings.csv',
    `/api/v1/evidence/checklist?finding=${x.candidateFinding}`, `/api/v1/evidence/checklist?link=${x.link}`, '/api/v1/receipts/RCPT-none'];
}
// What a visitor can observe: every collection the read routes expose, for both demo roles.
async function observable(app) {
  const out = {};
  for (const role of ['regulator', 'institution']) for (const url of ['/api/v1/dashboard/summary', '/api/v1/findings?lifecycle=all', '/api/v1/matches', '/api/v1/corrections?status=all', '/api/v1/notifications', '/api/v1/audit?limit=200', '/api/v1/imports', '/api/v1/records', '/api/v1/graph', `/api/v1/records/${ids().corrected}/lineage`, `/api/v1/identities/${ids().corrected}/history`]) {
    const res = await call(app, { url, headers: AS[role] }); assert.equal(res.status, 200, url); out[`${role} ${url}`] = res.text;
  }
  return out;
}

test('the demo dataset is synthetic, deterministic and complete enough for the walkthrough', () => {
  const a = buildDemoDataset(); const b = buildDemoDataset();
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'byte-identical on every build');
  assert.equal(createDemoStore().fingerprint, createDemoStore().fingerprint);
  assert.ok(a.sourceRecords.length >= 360);
  assert.ok(a.sourceRecords.every(r => /^(Student (NITM|RCA|SVU) \d+|Different Synthetic Name|Ambiguous Nair)$/.test(r.student_name.trim())), 'only synthetic names');
  assert.ok(a.sourceRecords.every(r => !r.apaar_id || /^7000000009?\d{2,3}$|^ABC-?92$/.test(r.apaar_id)), 'only synthetic identifiers');
  assert.deepEqual(a.institutions.map(i => i.code), ['NITM', 'RCA', 'SVU']);
  assert.equal(a.importBatches.length, 4, 'seed batches plus one follow-up file');
  assert.deepEqual(a.correctionCandidates.map(c => c.status).sort(), ['confirmed', 'pending']);
  assert.ok(a.sourceRecords.some(r => r.lineage?.relation === 'unchanged_copy') && a.sourceRecords.some(r => r.superseded_by), 'lineage: an unchanged copy and a superseded version');
  assert.deepEqual(Object.values(a.matchDecisions).map(d => d.decision).sort(), ['different_person', 'needs_more_evidence']);
  assert.ok(a.auditEvents.some(e => e.action === 'resolved_by_correction') && a.auditEvents.some(e => e.action.startsWith('match_')));
  assert.ok(a.findings.some(f => f.rule_code === 'CANDIDATE_IDENTITY_MATCH') && a.findings.some(f => f.rule_code === 'DEMO_INTAKE_LIMIT_EXCEEDED') && a.findings.some(f => f.lifecycle_status !== 'current'));
  assert.ok(a.notifications.length && a.automationRuns.length);
  assert.ok(!a.findings.some(f => f.assist), 'no model output in the dataset');
  assert.notEqual(typeof Date.now(), 'undefined'); assert.equal(Date.name, 'Date', 'the real clock is restored after the build');
  assert.notEqual(crypto.randomUUID(), crypto.randomUUID(), 'real random ids are restored after the build');
});

test('the demo store hands out private copies and can never save or reset', () => {
  const store = createDemoStore();
  const first = store.load(); first.findings.length = 0; first.sourceRecords[0].student_name = 'Changed';
  const second = store.load();
  assert.ok(second.findings.length > 0); assert.notEqual(second.sourceRecords[0].student_name, 'Changed');
  assert.throws(() => store.save(second), ReadOnlyError); assert.throws(() => store.reset(), ReadOnlyError);
  assert.ok(store.verify()); assert.ok(Object.isFrozen(store));
});

test('demo startup and requests never read, write or create a database file, even when one is configured', async () => {
  assert.equal(fs.existsSync(dbPath), false);
  const watch = watchFs();
  let app;
  try {
    ({ app } = startDemo());
    for (const url of reads()) await call(app, { url, headers: AS.regulator });
    for (const [method, url, json] of mutations()) await call(app, { method, url, json, headers: SPOOF });
  } finally { watch.restore(); if (app) await closeApp(app); }
  assert.deepEqual(watch.touched, [], 'only files under public/ were accessed');
  assert.equal(fs.existsSync(dbPath), false, 'EDUTRACE_DB_PATH was ignored and not created');
});

test('every mutation route returns 403 before reading the body or loading data, whatever the headers claim', async () => {
  const loads = []; const store = createDemoStore();
  const spyStore = { ...store, load: () => { loads.push(1); return store.load(); } };
  const app = createApp({ mode: 'demo', store: spyStore, getProvider: () => createProvider({ env: {}, disabled: 'off' }) });
  const routes = [...mutations(), ...OTHER_WRITES.map(([method, url]) => [method, url, { any: 'thing' }])];
  for (const [method, url, json] of routes) for (const headers of [SPOOF, AS.institution, {}]) {
    let bodyRead = false;
    const res = await call(app, { method, url, json, headers, onBodyRead: () => { bodyRead = true; } });
    assert.equal(res.status, 403, `${method} ${url}`);
    assert.deepEqual(res.json, READ_ONLY, `${method} ${url} gives the structured read-only error`);
    assert.equal(bodyRead, false, `${method} ${url}: the body was never read`);
  }
  assert.equal(loads.length, 0, 'no rejected request loaded any data');
  assert.equal(READ_ONLY.code, 'read_only_demo'); assert.match(READ_ONLY.error, /read-only demo/);
});

test('the mutation list covers every write route registered in server.js', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const methods = new Set([...source.matchAll(/req\.method === '(\w+)'/g)].map(m => m[1]));
  assert.deepEqual([...methods].sort(), ['GET', 'POST'], 'routes use only GET and POST');
  // Mode-specific dispatch can share a public endpoint with the general handler; count distinct routes.
  const posts = [...new Set([...source.matchAll(/req\.method === 'POST' && (?:url\.pathname === '([^']+)'|(\w+))/g)].map(m => m[1] || m[2]))];
  const named = { consent: '/consent', matchDecision: '/decision', matchExplain: '/explain', correction: '/corrections/', ack: '/acknowledge', assist: '/assist', decision: '/findings/' };
  assert.equal(posts.length, 17, `POST routes found: ${posts.join(', ')}`);
  for (const route of posts) {
    const fragment = route.startsWith('/') ? route : named[route];
    assert.ok(fragment, `unmapped POST route ${route}`);
    assert.ok(mutations().some(([, url]) => url.includes(fragment)), `POST route ${route} is in the mutation list`);
  }
});

test('hosted Demo rejects all registered writes before body reads or data loads', async () => {
  let loads = 0;
  const store = createDemoStore(undefined, { onLoad() { loads++; } });
  const app = createApp({ mode: 'demo', store, auth: hostedDemoAuthenticator({ passwordHash: HOSTED_TEST_PASSWORD_HASH, secureCookies: false }) });
  for (const [method, url, json] of [...mutations(), ...OTHER_WRITES.map(([m, u]) => [m, u, {}])]) {
    let bodyRead = false;
    const requestJson = url === '/api/v1/auth/login' ? { password: 'invalid test password' } : json;
    const response = await call(app, { method, url, json: requestJson, headers: { ...SPOOF, ...(url === '/api/v1/auth/login' ? { 'content-type': 'application/json' } : {}) }, onBodyRead: () => { bodyRead = true; } });
    if (url === '/api/v1/auth/login') {
      assert.equal(response.status, 401, 'login is an authentication endpoint, not a data mutation');
      assert.equal(bodyRead, true, 'login alone reads its bounded credential request');
      continue;
    }
    if (url === '/api/v1/auth/logout') {
      assert.equal(response.status, 401, 'logout requires an authenticated session');
      assert.equal(bodyRead, false, 'unauthenticated logout does not read its request body');
      continue;
    }
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.deepEqual(response.json, READ_ONLY, `${method} ${url} uses the read-only contract`);
    assert.equal(bodyRead, false, `${method} ${url} body was not read`);
  }
  assert.equal(loads, 0, 'rejected hosted writes never load the data store');
});

test('rejected writes leave records, versions, findings, links, decisions, notifications and audit history unchanged', async () => {
  const { app } = startDemo();
  try {
    const before = await observable(app);
    const fingerprint = (await call(app, { url: '/api/v1/runtime' })).json.data.dataset_fingerprint;
    for (const [method, url, json] of mutations()) for (const headers of [SPOOF, AS.institution]) assert.equal((await call(app, { method, url, json, headers })).status, 403);
    assert.deepEqual(await observable(app), before);
    assert.equal((await call(app, { url: '/api/v1/runtime' })).json.data.dataset_fingerprint, fingerprint);
  } finally { await closeApp(app); }
});

test('no GET route changes state: the loaded data is identical after every read, in demo and development', async () => {
  for (const mode of ['demo', 'development']) {
    const base = createDemoStore(); let loaded = null; let saves = 0;
    const store = { kind: 'memory', readOnly: mode === 'demo', load: () => (loaded = base.load()), save: () => { saves++; }, reset: () => { saves++; } };
    const app = createApp({ mode, store, getProvider: () => createProvider({ env: {} }) });
    const pristine = JSON.stringify(base.load());
    for (const role of ['regulator', 'institution']) for (const url of reads()) {
      loaded = null;
      const res = await call(app, { url, headers: AS[role] });
      assert.ok([200, 404].includes(res.status), `${mode} ${role} ${url} -> ${res.status}`);
      if (loaded) assert.equal(JSON.stringify(loaded), pristine, `${mode} ${role} GET ${url} mutated the data it loaded`);
    }
    assert.equal(saves, 0, `${mode}: no GET saved`);
  }
});

test('the demo boundary does not depend on the role: the institution lens still scopes reads', async () => {
  const { app } = startDemo();
  try {
    const regulator = (await call(app, { url: '/api/v1/records', headers: AS.regulator })).json;
    const nitm = (await call(app, { url: '/api/v1/records', headers: AS.institution })).json;
    assert.ok(nitm.total < regulator.total);
    assert.equal((await call(app, { method: 'POST', url: '/api/v1/demo/reset', headers: AS.regulator })).status, 403);
  } finally { await closeApp(app); }
});

test('demo mode never calls a model, whatever provider is configured, and explanations stay deterministic', async () => {
  // A development provider that would answer if it were ever used.
  let devCalls = 0;
  setProvider(createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test' }, transport: async () => { devCalls++; throw new Error('unexpected'); } }));
  const net = watchFetch();
  const { app, log } = startDemo();
  try {
    assert.ok(log.warn.some(line => /Demo mode ignores .*EDUTRACE_AI_PROVIDER.*ANTHROPIC_API_KEY/.test(line)), 'the ignored settings are named');
    assert.ok(log.warn.every(line => !line.includes('sk-ant-test')), 'no secret is logged');
    const ai = (await call(app, { url: '/api/v1/ai/status' })).json.data;
    assert.equal(ai.configured, false); assert.equal(ai.provider, 'none'); assert.equal(ai.health.state, 'disabled');
    assert.match(ai.reason, /off in the read-only demo/);
    assert.ok(Object.values(ai.tasks).every(t => !t.available));
    assert.equal((await call(app, { url: '/api/v1/runtime' })).json.data.ai_enabled, false);
    assert.equal((await call(app, { url: '/api/v1/automation' })).json.data.ai.configured, false);
    const x = ids();
    const finding = (await call(app, { url: `/api/v1/findings/${x.candidateFinding}` })).json.data;
    const explained = (await call(app, { url: `/api/v1/findings/${x.candidateFinding}/explanation` })).json.data;
    assert.equal(explained.explanation.source, 'deterministic');
    assert.equal(explained.explanation.summary, finding.explanation);
    assert.equal(explained.candidate_assessment.source, 'unavailable');
    const match = (await call(app, { url: `/api/v1/matches/${x.link}` })).json.data;
    assert.ok(match.explanation.why && match.explanation.recommendation, 'the deterministic match explanation is present');
    for (const url of [`/api/v1/findings/${x.finding}/assist`, `/api/v1/matches/${x.link}/explain`, '/api/v1/ai/check', '/api/v1/imports/preview']) assert.equal((await call(app, { method: 'POST', url, json: { filename: 'a.csv', csv }, headers: SPOOF })).status, 403);
  } finally { net.restore(); await closeApp(app); setProvider(createProvider({ env: {} })); }
  assert.deepEqual(net.calls, [], 'no network request to any provider');
  assert.equal(devCalls, 0, 'the development provider was never used');
});

test('a server error in demo mode returns a generic message without internal details', async () => {
  const store = { ...createDemoStore(), load: () => { throw new Error(`ENOENT: no such file, open '${path.join(os.tmpdir(), 'secret-path', 'demo-db.json')}'`); } };
  const app = createApp({ mode: 'demo', store, getProvider: () => createProvider({ env: {}, disabled: 'off' }) });
  const { error } = console; const logged = []; console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    const res = await call(app, { url: '/api/v1/dashboard/summary' });
    assert.equal(res.status, 500); assert.deepEqual(res.json, { error: 'Unexpected server error.' });
    assert.doesNotMatch(res.text, /secret-path|ENOENT|demo-db/);
  } finally { console.error = error; }
  assert.ok(logged.some(line => /secret-path/.test(line)), 'the detail stays in the server log');
  assert.equal((await call(app, { url: '/healthz' })).status, 200, 'health never loads data');
});

// Runs the real entry point from a copy of the project that has no data/ folder at all.
function copyProject() {
  const target = fs.mkdtempSync(path.join(dir, 'project-'));
  for (const item of ['server.js', 'package.json', 'src', 'public']) fs.cpSync(path.join(ROOT, item), path.join(target, item), { recursive: true });
  return target;
}
function launch(cwd, env) {
  return new Promise((resolve, reject) => {
    const clean = { ...process.env }; for (const key of Object.keys(clean)) if (key.startsWith('EDUTRACE_') || key === 'ANTHROPIC_API_KEY' || key === 'NODE_ENV' || key === 'NODE_TEST_CONTEXT' || HOSTING_MARKERS.includes(key)) delete clean[key];
    const child = spawn(process.execPath, ['server.js'], { cwd, env: { ...clean, PORT: '0', ...env } });
    let out = ''; let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`no listening line:\n${out}\n${err}`)); }, 30000);
    child.stderr.on('data', c => { err += c; });
    child.stdout.on('data', c => { out += c; const m = out.match(/running at http:\/\/localhost:(\d+)/); if (m) { clearTimeout(timer); resolve({ child, port: Number(m[1]), out, err: () => err }); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`exited ${code}:\n${out}\n${err}`)); });
  });
}
const stop = child => new Promise(resolve => { child.removeAllListeners('exit'); child.on('exit', () => resolve()); child.kill(); });
// The simulated principal the UI sends; without it the API answers 401.
async function http(port, pathName, init = {}) { const res = await fetch(`http://127.0.0.1:${port}${pathName}`, { ...init, headers: { 'x-demo-role': 'regulator', ...(init.headers || {}) } }); return { status: res.status, body: await res.json() }; }

test('the demo runs from a project copy with no data folder, writes nothing, and restarts with the same dataset', async () => {
  const project = copyProject();
  const fingerprints = [];
  for (let run = 0; run < 2; run++) {
    const { child, port, out } = await launch(project, { EDUTRACE_MODE: 'demo' });
    try {
      assert.match(out, /demo mode: read-only/);
      const runtime = (await http(port, '/api/v1/runtime')).body.data;
      assert.equal(runtime.mode, 'demo'); assert.equal(runtime.read_only, true); assert.equal(runtime.data_source, 'synthetic_in_memory'); assert.equal(runtime.ai_enabled, false);
      fingerprints.push(runtime.dataset_fingerprint);
      assert.equal((await http(port, '/api/v1/dashboard/summary')).body.data.imported_records, 363);
      const reset = await http(port, '/api/v1/demo/reset', { method: 'POST', headers: { 'x-demo-role': 'regulator', 'content-type': 'application/json' }, body: '{}' });
      assert.equal(reset.status, 403); assert.equal(reset.body.code, 'read_only_demo');
      assert.equal((await http(port, '/healthz')).body.status, 'ok');
    } finally { await stop(child); }
  }
  assert.equal(fs.existsSync(path.join(project, 'data')), false, 'no data folder or database file was created');
  assert.equal(fingerprints[0], fingerprints[1], 'a restart rebuilds the identical dataset');
  assert.equal(fingerprints[0], createDemoStore().fingerprint.slice(0, 16), 'the same dataset as in this process');
});

test('local judging demo backend binds only to IPv4 loopback', async () => {
  const log = console.log; console.log = () => {};
  const app = start({ EDUTRACE_MODE: 'demo', EDUTRACE_AUTH: 'demo_header', PORT: '0' });
  try {
    await new Promise(resolve => app.once('listening', resolve));
    assert.equal(app.address().address, '127.0.0.1');
    assert.equal((await call(app, { url: '/api/v1/runtime' })).json.data.mode, 'demo');
  } finally { console.log = log; await new Promise(resolve => app.close(resolve)); }
});

test('hosted demo binds externally on PORT and keeps health and mutation safeguards active', async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selected));
    });
  });
  const originalLog = console.log; let startupLog = ''; console.log = (...args) => { startupLog += `${args.join(' ')}\n`; };
  let app;
  try {
    const hostedEnv = { EDUTRACE_MODE: 'demo', EDUTRACE_AUTH: 'hosted_demo', EDUTRACE_HOSTED_DEMO_PASSWORD_HASH: HOSTED_TEST_PASSWORD_HASH, RENDER: 'true', PORT: String(port) };
    app = start(hostedEnv);
    await new Promise(resolve => app.once('listening', resolve));
    assert.equal(app.address().address, '0.0.0.0');
    assert.equal(app.address().port, port, 'the listener uses the platform-provided PORT');
    assert.match(startupLog, new RegExp(`http://0\\.0\\.0\\.0:${port}(?:\\s|$)`), 'startup reports the externally bound address and actual port');
    assert.equal(startupLog.includes(HOSTED_TEST_PASSWORD), false);
    assert.equal(startupLog.includes(HOSTED_TEST_PASSWORD_HASH), false);
    for (const extra of [
      { EDUTRACE_AUTH: 'demo_header' },
      { EDUTRACE_AUTH: 'local' },
      { EDUTRACE_INTEGRATIONS: 'mock' },
      { EDUTRACE_STORE: 'json' },
      { EDUTRACE_DATABASE_URL: 'postgres://invalid.example/unused' },
      { EDUTRACE_AI_PROVIDER: 'ollama' },
      { PORT: 'not-a-port' }
    ]) {
      assert.throws(() => start({ EDUTRACE_MODE: 'demo', RENDER: 'true', ...extra }), /Hosted Demo|PORT must/);
    }
    assert.throws(() => start({ EDUTRACE_MODE: 'demo', RENDER: 'true', EDUTRACE_AUTH: 'demo_header', EDUTRACE_HOSTED_DEMO_PASSWORD_HASH: HOSTED_TEST_PASSWORD_HASH }), /EDUTRACE_AUTH=hosted_demo/);
    assert.throws(() => start({ EDUTRACE_MODE: 'demo', RENDER: 'true', EDUTRACE_AUTH: 'local', EDUTRACE_HOSTED_DEMO_PASSWORD_HASH: HOSTED_TEST_PASSWORD_HASH }), /EDUTRACE_AUTH=hosted_demo/);
    assert.throws(() => start({ EDUTRACE_MODE: 'demo', RENDER: 'true', EDUTRACE_AUTH: 'hosted_demo' }), /EDUTRACE_HOSTED_DEMO_PASSWORD_HASH/);
    assert.throws(() => start({ EDUTRACE_MODE: 'demo', RENDER: 'true', EDUTRACE_AUTH: 'hosted_demo', EDUTRACE_HOSTED_DEMO_PASSWORD_HASH: 'not-a-valid-hash' }), /valid scrypt hash/);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const runtime = await http(port, '/api/v1/runtime');
    assert.equal(runtime.status, 200);
    assert.equal(runtime.body.data.mode, 'demo');
    assert.equal(runtime.body.data.auth, 'hosted_demo');
    assert.equal(runtime.body.data.data_source, 'synthetic_in_memory');
    assert.equal(runtime.body.data.ai_enabled, false);
    assert.deepEqual(Object.keys(runtime.body.data).sort(), ['ai_enabled', 'auth', 'data_source', 'mode', 'read_only', 'registration_enabled']);
    assert.equal(runtime.body.data.registration_enabled, false);
    const anonymous = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/summary`, { headers: { 'x-demo-role': 'regulator', authorization: 'Bearer admin' } });
    assert.equal(anonymous.status, 401, 'protected reads require a hosted session even if privileged headers are supplied');
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/institutions`)).status, 401, 'institution metadata is also protected');
    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify({ password: HOSTED_TEST_PASSWORD }) });
    assert.equal(login.status, 200);
    assert.doesNotMatch(login.headers.get('set-cookie'), /password|hash/i);
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
    assert.match(login.headers.get('set-cookie'), /Secure/);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    for (const role of [undefined, 'institution', 'regulator']) {
      const headers = role ? { 'x-demo-role': role, 'x-demo-institution': 'RCA' } : {};
      const summary = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/summary`, { headers: { cookie, ...headers } });
      assert.equal(summary.status, 200);
      const summaryBody = await summary.json();
      const principal = summaryBody.principal;
      assert.equal(principal.method, 'hosted_demo');
      assert.equal(principal.authenticated, true, 'read access follows successful password authentication');
      assert.equal(principal.role, 'hosted_demo_viewer');
      assert.deepEqual(principal.roles, ['hosted_demo_viewer']);
      assert.deepEqual(principal.capabilities, ['records.read']);
      assert.equal(principal.scope, 'all');
      assert.equal(principal.institution_code, null, 'client role and institution headers cannot change hosted scope');
      assert.equal(summaryBody.data.institutions, 3, 'the viewer sees the synthetic all-institution scope');
    }
    const session = await http(port, '/api/v1/auth/session', { headers: { cookie } });
    assert.equal(session.body.data.authenticated, true);
    assert.equal(session.body.data.viewer.role, 'hosted_demo_viewer');
    const integrations = await http(port, '/api/v1/integrations', { headers: { cookie } });
    assert.equal(integrations.body.data.adapter, 'none');
    assert.ok(integrations.body.data.services.every(service => !service.connected && !service.simulated));

    for (const url of ['/api/v1/demo/reset', '/api/v1/imports/confirm']) {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-role': 'regulator' }, body: '{}'
      });
      assert.equal(response.status, 403, `${url} remains blocked in hosted Demo`);
      assert.equal((await response.json()).code, 'read_only_demo');
    }
  } finally {
    console.log = originalLog;
    if (app?.listening) await new Promise(resolve => app.close(resolve));
  }
});

test('development mode still starts by default and uses its file store', async () => {
  const project = copyProject();
  const file = path.join(project, 'scratch-db.json');
  // A real account, created the way an operator would: a users file with an scrypt hash. There are no default accounts.
  const users = path.join(project, 'users.json');
  fs.writeFileSync(users, JSON.stringify({ users: [{ username: 'nitm.reviewer', display_name: 'NITM Reviewer', role: 'reviewer', institution_code: 'NITM', password_hash: require('../src/accounts').hashPassword('correct horse battery staple') }] }));
  const { child, port, out } = await launch(project, { EDUTRACE_DB_PATH: file, EDUTRACE_USERS_PATH: users });
  try {
    assert.match(out, /development mode, the local default; institution sign-in with local accounts/);
    const runtime = (await http(port, '/api/v1/runtime')).body.data;
    assert.deepEqual([runtime.mode, runtime.read_only, runtime.data_source], ['development', false, 'json_file']);
    assert.equal(fs.existsSync(file), false, 'runtime and health checks do not load data');
    assert.equal(runtime.auth, 'local');
    assert.equal((await http(port, '/api/v1/dashboard/summary')).status, 401, 'no session, no data, whatever the role header says');
    assert.equal(fs.existsSync(file), false);
    const login = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nitm.reviewer', password: 'correct horse battery staple' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const summary = await fetch(`http://127.0.0.1:${port}/api/v1/dashboard/summary`, { headers: { cookie } });
    assert.equal(summary.status, 200); assert.equal((await summary.json()).principal.institution_code, 'NITM');
    assert.equal(fs.existsSync(file), true, 'development seeds its scratch file as before');
  } finally { await stop(child); }
});

test('the UI reads the mode from the server and says when it is read-only', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const imports = fs.readFileSync(path.join(PUBLIC, 'import.js'), 'utf8');
  const recon = fs.readFileSync(path.join(PUBLIC, 'reconciliation.js'), 'utf8');
  const matches = fs.readFileSync(path.join(PUBLIC, 'matches.js'), 'utf8');
  assert.match(html, /id="modeBanner" role="status" hidden/);
  assert.match(app, /api\('\/api\/v1\/runtime'\)/);
  assert.ok(app.includes('if (!(await loadRuntime())) return;'), 'runtime and local session are resolved before the first view renders');
  assert.match(app, /handleEntryNavigation\(\);/, 'the server-selected experience opens directly after runtime resolution');
  assert.match(app, /error\.readOnly = data\.code === 'read_only_demo'/);
  assert.match(app, /state\.auth === 'hosted_demo'[\s\S]*?\.demo-card'\)\.hidden = true/);
  assert.match(app, /state\.auth === 'hosted_demo'[\s\S]*?state\.role = 'hosted_demo_viewer'/, 'hosted Demo keeps its fixed viewer identity in client state');
  assert.doesNotMatch(app, /state\.auth === 'hosted_demo'[\s\S]{0,120}state\.role = 'regulator'/, 'hosted Demo never impersonates the simulated regulator');
  assert.match(app, /\$\('#ovAutomationAction'\)\.innerHTML = state\.role === 'regulator'/, 'regulator-only revalidation is omitted for the hosted viewer');
  assert.match(app, /ai\.configured && state\.role === 'regulator'/, 'regulator-only AI health checks are omitted for the hosted viewer');
  assert.match(app, /\$\('\[data-route="audit"\]'\)\.hidden = true/);
  assert.match(app, /\$\('#exportAll'\)\.hidden = true/);
  assert.match(app, /\$\('#rxExport'\)\.hidden = true/);
  assert.match(app, /state\.auth === 'hosted_demo' \|\| params\.get\('tab'\) === 'imports'/);
  assert.match(matches, /e\.receipt_id && state\.auth !== 'hosted_demo'/);
  assert.match(recon, /event\.receipt_id && state\.auth !== 'hosted_demo'/);
  assert.match(app, /state\.runtime\.auth === 'hosted_demo'[\s\S]*?state\.runtime\.ai_enabled !== false/);
  assert.match(app, /if \(state\.auth === 'hosted_demo'\) \{[\s\S]*?\/api\/v1\/auth\/session[\s\S]*?showLogin\(\); return false/,
    'hosted users must have an authenticated session before the route renders');
  assert.match(app, /const hosted = state\.auth === 'hosted_demo'/);
  assert.match(app, /credentials = hosted \? \{ password \} : \{ username, password \}/);
  assert.match(app, /api\('\/api\/v1\/auth\/logout', \{ method: 'POST'/);
  assert.match(html, /id="hostedSignOut" hidden/);
  assert.match(html, /id="loginUsernameField"/);
  assert.match(app, /registrationLink\.hidden = state\.runtime\?\.registration_enabled !== true/);
  assert.match(app, /const route = location\.hash[\s\S]*\|\| 'overview'/, 'refresh and deep links use the server-selected workspace without a local selection key');
  assert.match(app, /addEventListener\('hashchange', handleEntryNavigation\)/);
  assert.match(app, /addEventListener\('popstate', handleEntryNavigation\)/, 'browser back and forward re-run the app router');
  assert.match(app, /showStartupError\('EduTrace could not confirm the server configuration/);
  assert.match(app, /reset\.disabled = state\.readOnly \|\|/);
  assert.match(imports, /if \(state\.readOnly\) return/, 'no file input is rendered in the read-only demo');
  assert.match(recon, /state\.readOnly\s*\?\s*await api\(`\/api\/v1\/findings\/\$\{encodeURIComponent\(f\.id\)\}\/explanation`\)/);
  assert.match(html, /id="entryScreen"[\s\S]*?id="entryTitle">Opening EduTrace/);
  assert.match(html, /id="entryStatus" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /data-entry-mode|Choose your workspace|Synthetic Test Mode|Continue to Demo Login/);
  assert.doesNotMatch(app, /ENTRY_MODE_KEY|entryAllowed|chooseEntryMode|demo-login/);
  assert.match(app, /registrationLink\.hidden = state\.runtime\?\.registration_enabled !== true/);
  assert.match(app, /if \(state\.auth === 'local'\)[\s\S]*?showLogin\(\); return false/,
    'login is reachable only through server-selected local authentication');
  assert.match(html, /href="styles\.css"/);
  assert.doesNotMatch(html, /(?:href|src)="\/(?:styles\.css|app\.js|reconciliation\.js|import\.js)/, 'mounted browser assets resolve beneath the mode prefix');
  assert.match(app, /fetch\(`\$\{APP_BASE\}\$\{path\}`/);
  assert.match(app, /mountedMode && mountedMode !== state\.runtime\?\.mode/);
  // Success toasts are shown only after the awaited request resolves, so a 403 can never produce one.
  for (const [file, source, call] of [['app.js', app, "'/api/v1/demo/reset'"], ['import.js', imports, '/decision`'], ['reconciliation.js', recon, '/decision`']]) {
    const at = source.indexOf(call); assert.ok(at > 0, `${file} write call`);
    const next = source.slice(at, at + 600);
    assert.ok(next.indexOf("tone: 'success'") > 0, `${file}: success follows the awaited call`);
  }
});

test('the working database is unchanged by this file', () => {
  assert.equal(fileHash(DEFAULT_DATA), REAL_DB_BEFORE);
});
