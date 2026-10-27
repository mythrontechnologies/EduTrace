require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createFrontDoor, start, FrontDoorError } = require('../scripts/judge-frontdoor');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');
const { createDemoStore } = require('../src/demo-data');
const { createSyntheticTestStore, syntheticTestAuthenticator } = require('../src/synthetic-test');
const { fileDirectory, localSessionAuthenticator, hashPassword } = require('../src/accounts');

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  if (!server?.listening) return;
  server.close();
  server.closeAllConnections?.();
}
async function response(port, path, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  return { status: res.status, headers: res.headers, text: await res.text() };
}
function fakeBackend(mode, seen = []) {
  return http.createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    if (req.url === '/api/v1/runtime') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Backend-Mode': mode });
      return res.end(JSON.stringify({ data: { mode } }));
    }
    const headers = { 'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : 'application/json', 'X-Backend-Mode': mode };
    if (req.url === '/api/v1/auth/login') headers['Set-Cookie'] = 'edutrace_session=synthetic-only-test; Path=/; HttpOnly; SameSite=Strict';
    if (req.url === '/redirect') headers.Location = '/api/v1/runtime';
    res.writeHead(200, headers);
    res.end(JSON.stringify({ mode, path: req.url }));
  });
}

test('front door serves one landing page and routes mounted app, assets, and APIs to their fixed mode backends', async () => {
  const demoSeen = []; const syntheticSeen = [];
  const demo = fakeBackend('demo', demoSeen); const synthetic = fakeBackend('synthetic-test', syntheticSeen);
  const demoPort = await listen(demo); const syntheticPort = await listen(synthetic);
  const front = createFrontDoor({ demo: { host: '127.0.0.1', port: demoPort }, synthetic: { host: '127.0.0.1', port: syntheticPort } });
  const frontPort = await listen(front);
  try {
    const landing = await response(frontPort, '/');
    assert.equal(landing.status, 200);
    assert.match(landing.text, /href="\/demo\/"/);
    assert.match(landing.text, /href="\/synthetic\/"/);
    const demoApp = await response(frontPort, '/demo/');
    assert.equal(demoApp.headers.get('x-backend-mode'), 'demo');
    assert.match(demoApp.text, /"path":"\/"/);
    const demoAsset = await response(frontPort, '/demo/app.js');
    assert.equal(demoAsset.headers.get('x-backend-mode'), 'demo');
    assert.ok(demoSeen.some(item => item.path === '/app.js'));
    const syntheticApi = await response(frontPort, '/synthetic/api/v1/runtime');
    assert.equal(syntheticApi.headers.get('x-backend-mode'), 'synthetic-test');
    assert.match(syntheticApi.text, /"mode":"synthetic-test"/);
    assert.ok(syntheticSeen.some(item => item.path === '/api/v1/runtime'));
    assert.equal((await response(frontPort, '/api/v1/runtime')).status, 404, 'unmounted API routes do not select a backend by cookie or header');
  } finally { await close(front); await close(demo); await close(synthetic); }
});

test('mode cookies and auth headers are confined to their mount', async () => {
  const demoSeen = []; const syntheticSeen = [];
  const demo = fakeBackend('demo', demoSeen); const synthetic = fakeBackend('synthetic-test', syntheticSeen);
  const demoPort = await listen(demo); const syntheticPort = await listen(synthetic);
  const front = createFrontDoor({ demo: { host: '127.0.0.1', port: demoPort }, synthetic: { host: '127.0.0.1', port: syntheticPort } });
  const frontPort = await listen(front);
  try {
    const login = await response(frontPort, '/demo/api/v1/auth/login', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.match(login.headers.get('set-cookie'), /Path=\/demo\//);
    const demoRequest = await response(frontPort, '/demo/api/v1/records', { headers: { cookie: 'edutrace_session=demo', 'x-edutrace-test-institution': 'TSTB' } });
    assert.equal(demoRequest.headers.get('x-backend-mode'), 'demo');
    const demoRecordRequest = demoSeen.find(item => item.path === '/api/v1/records');
    assert.equal(demoRecordRequest.headers.cookie, 'edutrace_session=demo');
    assert.equal(demoRecordRequest.headers['x-edutrace-test-institution'], undefined);

    const testRequest = await response(frontPort, '/synthetic/api/v1/records', { headers: {
      cookie: 'edutrace_session=demo', authorization: 'Bearer unrelated', 'x-demo-role': 'regulator', 'x-demo-institution': 'RCA',
      'x-csrf-token': 'unrelated', 'x-edutrace-test-institution': 'TSTB'
    } });
    assert.equal(testRequest.headers.get('set-cookie'), null);
    const syntheticRecordRequest = syntheticSeen.find(item => item.path === '/api/v1/records');
    for (const header of ['cookie', 'authorization', 'x-demo-role', 'x-demo-institution', 'x-csrf-token']) assert.equal(syntheticRecordRequest.headers[header], undefined, `${header} is not forwarded to Synthetic Test`);
    assert.equal(syntheticRecordRequest.headers['x-edutrace-test-institution'], 'TSTB');
  } finally { await close(front); await close(demo); await close(synthetic); }
});

test('real demo login and synthetic runtime stay separated through the local proxy', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'edutrace-frontdoor-'));
  const usersPath = path.join(scratch, 'users.json');
  await fileDirectory(usersPath).add({ username: 'synthetic.demo.user', display_name: 'Synthetic Demo User', role: 'reviewer', institution_code: 'NITM', password_hash: hashPassword('synthetic-demo-password-123'), disabled: false });
  const demo = createApp({ mode: 'demo', store: createDemoStore(), auth: localSessionAuthenticator({ directory: fileDirectory(usersPath) }) });
  const synthetic = createApp({ mode: 'synthetic-test', store: createSyntheticTestStore(), auth: syntheticTestAuthenticator() });
  const demoPort = await listen(demo); const syntheticPort = await listen(synthetic);
  const front = createFrontDoor({ demo: { host: '127.0.0.1', port: demoPort }, synthetic: { host: '127.0.0.1', port: syntheticPort } });
  const frontPort = await listen(front);
  try {
    const demoHtml = await response(frontPort, '/demo/');
    assert.equal(demoHtml.status, 200);
    assert.match(demoHtml.text, /src="app\.js"/, 'mounted app asset URLs remain inside the mode prefix');
    const demoLogin = await fetch(`http://127.0.0.1:${frontPort}/demo/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'synthetic.demo.user', password: 'synthetic-demo-password-123' }) });
    assert.equal(demoLogin.status, 200);
    const cookieHeader = demoLogin.headers.get('set-cookie');
    assert.match(cookieHeader, /Path=\/demo\//);
    const demoCookie = cookieHeader.split(';')[0];
    const demoSummary = await fetch(`http://127.0.0.1:${frontPort}/demo/api/v1/dashboard/summary`, { headers: { cookie: demoCookie } });
    assert.equal(demoSummary.status, 200);
    assert.equal((await demoSummary.json()).principal.institution_code, 'NITM');
    const forbiddenDemoWrite = await fetch(`http://127.0.0.1:${frontPort}/demo/api/v1/imports/confirm`, { method: 'POST', headers: { cookie: demoCookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(forbiddenDemoWrite.status, 403);

    const syntheticSummary = await fetch(`http://127.0.0.1:${frontPort}/synthetic/api/v1/dashboard/summary`, { headers: { cookie: demoCookie, authorization: 'Bearer irrelevant', 'x-demo-role': 'regulator', 'x-edutrace-test-institution': 'TSTA' } });
    assert.equal(syntheticSummary.status, 200);
    const syntheticBody = await syntheticSummary.json();
    assert.equal(syntheticBody.principal.method, 'synthetic_test');
    assert.equal(syntheticBody.principal.institution_code, 'TSTA');
    assert.equal(syntheticBody.data.imported_records, 3);
    const forbiddenSyntheticAuthWrite = await fetch(`http://127.0.0.1:${frontPort}/synthetic/api/v1/auth/login`, { method: 'POST', headers: { cookie: demoCookie, 'content-type': 'application/json', 'x-demo-role': 'regulator' }, body: '{}' });
    assert.equal(forbiddenSyntheticAuthWrite.status, 403);
  } finally {
    await close(front); await close(demo); await close(synthetic);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('front door fails safely for an unavailable backend and refuses a backend running the wrong mode', async () => {
  const seen = []; const wrongDemo = fakeBackend('synthetic-test', seen); const synthetic = fakeBackend('synthetic-test');
  const wrongPort = await listen(wrongDemo); const syntheticPort = await listen(synthetic);
  const unused = http.createServer(); const unavailablePort = await listen(unused); await close(unused);
  const front = createFrontDoor({ demo: { host: '127.0.0.1', port: wrongPort }, synthetic: { host: '127.0.0.1', port: syntheticPort } });
  const frontPort = await listen(front);
  try {
    const mismatch = await response(frontPort, '/demo/api/v1/records');
    assert.equal(mismatch.status, 502);
    assert.match(mismatch.text, /configured demo address is running synthetic-test/);
    assert.deepEqual(seen.map(item => item.path), ['/api/v1/runtime'], 'mismatched backends receive no application request');
    const goodLanding = await response(frontPort, '/');
    assert.equal(goodLanding.status, 200, 'one failing backend does not take down the entry page');
  } finally { await close(front); await close(wrongDemo); await close(synthetic); }

  const offlineFront = createFrontDoor({ demo: { host: '127.0.0.1', port: syntheticPort }, synthetic: { host: '127.0.0.1', port: unavailablePort } });
  const offlinePort = await listen(offlineFront);
  try {
    const unavailable = await response(offlinePort, '/synthetic/', { headers: { accept: 'text/html' } });
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.text, /Synthetic Test Mode unavailable/);
  } finally { await close(offlineFront); }
});

test('front door startup rejects hosted, non-loopback, and port-collision configuration', () => {
  assert.throws(() => start({ K_SERVICE: 'hosted', EDUTRACE_JUDGE_PORT: '3100' }), FrontDoorError);
  assert.throws(() => start({ HOST: '0.0.0.0' }), /binds only to 127\.0\.0\.1/);
  assert.throws(() => start({ EDUTRACE_JUDGE_PORT: '3100', EDUTRACE_DEMO_PORT: '3100', EDUTRACE_SYNTHETIC_TEST_PORT: '3102' }), /must be distinct/);
});
