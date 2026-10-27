const { dir } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server');
const { saveDemo, loadDemo } = require('../src/seed');
const { buildDemoDataset } = require('../src/demo-data');
const { createDemoStore } = require('../src/demo-data');
const { commitImport } = require('../src/pipeline');
const { ROLES, ROUTE_RULES, routeRule, principalOf, verifyJwt, parseMemberships, oidcAuthenticator, demoHeaderAuthenticator, authFromEnv } = require('../src/auth');
const { StartupError } = require('../src/mode');

const ROOT = path.join(__dirname, '..');
function call(app, { method = 'GET', url, headers = {}, json, onBodyRead }) {
  return new Promise(resolve => {
    let sent = false; const payload = json === undefined ? null : JSON.stringify(json);
    const request = new Readable({ read() { if (onBodyRead) onBodyRead(); if (!sent && payload) { sent = true; this.push(payload); } this.push(null); } });
    request.method = method; request.url = url; request.headers = { host: 'localhost', ...headers };
    const response = new EventEmitter(); let status = 200; let hdrs = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; hdrs = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, headers: hdrs, text, json: hdrs['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    app.emit('request', request, response);
  });
}
const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// One sample request per API route in server.js (method, path).
function sampleRoutes(db) {
  const link = db.identityLinks.find(l => l.outcome === 'candidate_for_review');
  const f = db.findings.find(x => x.lifecycle_status === 'current');
  return [
    ['GET', '/api/v1/dashboard/summary'], ['GET', '/api/v1/audit'], ['GET', '/api/v1/imports'], ['GET', '/api/v1/ai/status'], ['POST', '/api/v1/ai/check'],
    ['GET', '/api/v1/automation'], ['GET', '/api/v1/matches'], ['POST', `/api/v1/matches/${link.id}/decision`], ['POST', `/api/v1/matches/${link.id}/explain`], ['GET', `/api/v1/matches/${link.id}`],
    ['GET', '/api/v1/records'], ['GET', '/api/v1/identities/SRC-3/history'], ['GET', '/api/v1/records/SRC-3/lineage'], ['GET', '/api/v1/corrections'], ['POST', '/api/v1/corrections/CORR-x/decision'],
    ['GET', '/api/v1/records/SRC-3'], ['GET', '/api/v1/profiles/SRC-3'], ['GET', '/api/v1/notifications'], ['POST', '/api/v1/notifications/NTF-x/acknowledge'], ['POST', '/api/v1/automation/revalidate'],
    ['GET', `/api/v1/findings/${f.id}/explanation`], ['POST', `/api/v1/findings/${f.id}/assist`], ['GET', '/api/v1/graph'], ['GET', `/api/v1/evidence/checklist?finding=${f.id}`], ['POST', '/api/v1/simulations/correction'],
    ['GET', '/api/v1/receipts/RCPT-x'], ['GET', '/api/v1/findings'], ['GET', `/api/v1/findings/${f.id}`], ['POST', `/api/v1/findings/${f.id}/decision`], ['POST', '/api/v1/imports/preview'],
    ['POST', '/api/v1/imports/confirm'], ['GET', '/api/v1/reports/findings.csv'], ['POST', '/api/v1/demo/reset'], ['POST', '/api/v1/admin/initialize-empty-import'],
    ['GET', '/api/v1/integrations'], ['GET', '/api/v1/records/SRC-3/verification'], ['POST', '/api/v1/auth/logout'], ['POST', '/api/v1/records/SRC-3/consent']
  ];
}
// An app whose store records every load, so a rejected request can be shown to have read nothing.
function spyApp(auth, extra = {}) {
  const base = createDemoStore(); const loads = []; let saves = 0;
  const store = { kind: 'memory', readOnly: false, load: () => { loads.push(1); return base.load(); }, save: () => { saves++; }, reset: () => { saves++; return base.load(); } };
  return { app: createApp({ mode: 'development', store, auth, ...extra }), loads, saves: () => saves };
}
const fixed = principal => ({ kind: 'test', authenticate: () => principal });

// ── Keys and tokens for the OIDC adapter ─────────────────────────────────────────
const ISSUER = 'https://idp.example.test/realms/edutrace'; const AUDIENCE = 'edutrace-api';
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }); const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const KEYS = [{ ...rsa.publicKey.export({ format: 'jwk' }), kid: 'rsa-1', alg: 'RS256', use: 'sig' }, { ...ec.publicKey.export({ format: 'jwk' }), kid: 'ec-1', alg: 'ES256', use: 'sig' }];
const now = () => Math.floor(Date.now() / 1000);
function sign(claims, { alg = 'RS256', kid = alg === 'RS256' ? 'rsa-1' : 'ec-1', key } = {}) {
  const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url');
  const head = `${enc({ alg, typ: 'JWT', kid })}.${enc({ iss: ISSUER, aud: AUDIENCE, iat: now(), exp: now() + 300, ...claims })}`;
  if (alg === 'none') return `${head}.`;
  if (alg === 'HS256') return `${head}.${crypto.createHmac('sha256', key).update(head).digest('base64url')}`;
  const sig = alg === 'RS256' ? crypto.sign('sha256', Buffer.from(head), rsa.privateKey) : crypto.sign('sha256', Buffer.from(head), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${head}.${sig.toString('base64url')}`;
}
const MEMBERSHIPS = { memberships: [
  { issuer: ISSUER, subject: 'reg-1', display_name: 'Regulator Reviewer One', roles: ['reviewer'], institution_code: null },
  { issuer: ISSUER, subject: 'nitm-1', display_name: 'NITM Reviewer', roles: ['reviewer'], institution_code: 'NITM' },
  { issuer: ISSUER, subject: 'nitm-admin', display_name: 'NITM Admin', roles: ['institution_admin'], institution_code: 'NITM' },
  { issuer: ISSUER, subject: 'audit-1', display_name: 'Auditor', roles: ['auditor'], institution_code: null },
  { issuer: ISSUER, subject: 'ops-1', display_name: 'Platform Admin', roles: ['platform_admin'], institution_code: null }
] };
const oidc = () => oidcAuthenticator({ issuer: ISSUER, audience: AUDIENCE, keys: KEYS, memberships: MEMBERSHIPS });
const bearer = (sub, extra) => ({ authorization: `Bearer ${sign({ sub, ...extra })}` });

test('every protected API route in server.js has a capability rule; only runtime, institution metadata, auth and static routes are public', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const routes = [...source.matchAll(/req\.method === '(GET|POST)' && (?:url\.pathname === '([^']+)'|(\w+))/g)].map(m => [m[1], m[2] || m[3]]);
  // Mode-specific import dispatch shares the same API route names as the general handler.
  const apiRoutes = [...new Map(routes.filter(([, p]) => !['/healthz', '/api/v1/runtime', '/api/v1/institutions', '/api/v1/auth/login', '/api/v1/auth/session', '/api/v1/auth/register', 'STATIC_FILES'].includes(p) && p !== 'STATIC').map(([method, route]) => [`${method}:${route}`, [method, route]])).values()];
  const samples = sampleRoutes(buildDemoDataset());
  assert.equal(samples.length, apiRoutes.length, 'one sample per API route');
  for (const [method, url] of samples) { const r = routeRule(method, url.split('?')[0]); assert.equal(r.public, false); assert.ok(r.capability, `${method} ${url} has a capability`); }
  assert.equal(ROUTE_RULES.length, samples.length);
  assert.deepEqual(routeRule('GET', '/api/v1/runtime'), { public: true, capability: null });
  for (const [method, path] of [['GET', '/api/v1/institutions'], ['POST', '/api/v1/auth/register']]) assert.deepEqual(routeRule(method, path), { public: true, capability: null });
  assert.deepEqual(routeRule('GET', '/api/v1/unknown'), { public: false, capability: null });
});

test('an anonymous request gets 401 on every API route before any body is read or data loaded', async () => {
  for (const auth of [demoHeaderAuthenticator(), oidc()]) {
    const { app, loads } = spyApp(auth);
    for (const [method, url] of sampleRoutes(buildDemoDataset())) {
      let bodyRead = false;
      const res = await call(app, { method, url, json: { any: 'thing' }, onBodyRead: () => { bodyRead = true; } });
      assert.equal(res.status, 401, `${auth.kind} ${method} ${url}`);
      assert.equal(res.json.code, 'unauthenticated'); assert.match(res.headers['WWW-Authenticate'], /^Bearer realm="edutrace"/);
      assert.equal(bodyRead, false);
    }
    assert.equal(loads.length, 0, `${auth.kind}: no data was loaded for an anonymous request`);
    assert.equal((await call(app, { url: '/api/v1/unknown' })).status, 401, 'unknown API paths do not reveal whether they exist');
    assert.equal((await call(app, { url: '/healthz' })).status, 200);
    assert.equal((await call(app, { url: '/api/v1/runtime' })).json.data.auth, auth.kind);
  }
  // The read-only demo still rejects writes first, then requires a principal for reads.
  const demo = createApp({ mode: 'demo', store: createDemoStore() });
  assert.equal((await call(demo, { method: 'POST', url: '/api/v1/demo/reset' })).status, 403);
  assert.equal((await call(demo, { url: '/api/v1/findings' })).status, 401);
  assert.equal((await call(demo, { url: '/api/v1/findings', headers: { 'x-demo-role': 'institution' } })).status, 200);
});

test('roles map to explicit capabilities, and a missing capability is refused before data is touched', async () => {
  const expected = {
    reviewer: { allow: ['GET /api/v1/findings', 'POST /api/v1/findings/x/decision', 'POST /api/v1/matches/x/decision', 'POST /api/v1/simulations/correction'], deny: ['POST /api/v1/imports/confirm', 'POST /api/v1/corrections/x/decision', 'POST /api/v1/automation/revalidate', 'POST /api/v1/ai/check', 'POST /api/v1/demo/reset', 'POST /api/v1/admin/initialize-empty-import'] },
    auditor: { allow: ['GET /api/v1/audit', 'GET /api/v1/receipts/x', 'GET /api/v1/reports/findings.csv'], deny: ['POST /api/v1/findings/x/decision', 'POST /api/v1/matches/x/decision', 'POST /api/v1/imports/preview', 'POST /api/v1/simulations/correction', 'POST /api/v1/notifications/x/acknowledge', 'POST /api/v1/findings/x/assist', 'POST /api/v1/admin/initialize-empty-import'] },
    institution_admin: { allow: ['POST /api/v1/imports/confirm', 'POST /api/v1/corrections/x/decision', 'POST /api/v1/notifications/x/acknowledge'], deny: ['POST /api/v1/findings/x/decision', 'POST /api/v1/matches/x/decision', 'POST /api/v1/automation/revalidate', 'POST /api/v1/admin/initialize-empty-import'] },
    platform_admin: { allow: ['POST /api/v1/ai/check', 'POST /api/v1/automation/revalidate', 'GET /api/v1/ai/status', 'POST /api/v1/admin/initialize-empty-import'], deny: ['GET /api/v1/findings', 'GET /api/v1/records', 'GET /api/v1/audit', 'GET /api/v1/receipts/x', 'POST /api/v1/findings/x/decision'] }
  };
  for (const [role, { allow, deny }] of Object.entries(expected)) {
    const p = principalOf({ name: role, subject: role, scope: 'all', roles: [role], method: 'test' });
    for (const r of allow) { const [m, u] = r.split(' '); assert.ok(p.capabilities.includes(routeRule(m, u).capability), `${role} may ${r}`); }
    const { app, loads } = spyApp(fixed(p));
    for (const r of deny) {
      const [m, u] = r.split(' ');
      const res = await call(app, { method: m, url: u, json: {} });
      assert.equal(res.status, 403, `${role} may not ${r}`); assert.equal(res.json.code, 'forbidden'); assert.equal(res.json.capability, routeRule(m, u).capability);
    }
    assert.equal(loads.length, 0, `${role}: refused requests loaded no data`);
  }
  assert.deepEqual(Object.keys(ROLES).sort(), ['auditor', 'institution_admin', 'platform_admin', 'reviewer']);
});

test('JWT verification accepts valid RS256 and ES256 tokens and rejects every tampered or misdirected one', () => {
  const opts = { issuer: ISSUER, audience: AUDIENCE, keys: KEYS };
  assert.equal(verifyJwt(sign({ sub: 'reg-1' }), opts).sub, 'reg-1');
  assert.equal(verifyJwt(sign({ sub: 'reg-1' }, { alg: 'ES256' }), opts).sub, 'reg-1');
  assert.equal(verifyJwt(sign({ sub: 'reg-1', aud: ['other', AUDIENCE] }), opts).sub, 'reg-1');
  const good = sign({ sub: 'reg-1' }); const [h, , s] = good.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, sub: 'ops-1', exp: now() + 300 })).toString('base64url')}.${s}`;
  const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  const bad = {
    expired: sign({ sub: 'reg-1', exp: now() - 3600 }), notYet: sign({ sub: 'reg-1', nbf: now() + 3600 }), future: sign({ sub: 'reg-1', iat: now() + 3600 }),
    wrongIssuer: sign({ sub: 'reg-1', iss: 'https://evil.example' }), wrongAudience: sign({ sub: 'reg-1', aud: 'someone-else' }), noSubject: sign({ sub: '' }),
    unknownKey: sign({ sub: 'reg-1' }, { kid: 'nope' }), algNone: sign({ sub: 'reg-1' }, { alg: 'none' }), hmacWithPublicKey: sign({ sub: 'reg-1' }, { alg: 'HS256', key: rsaPem }),
    forgedPayload: forged, notAJwt: 'abc.def', tooLong: `${'a'.repeat(9000)}.b.c`, garbage: '!!!.@@@.###'
  };
  for (const [name, token] of Object.entries(bad)) assert.throws(() => verifyJwt(token, opts), error => error.status === 401 && error.code === 'invalid_token', name);
  assert.ok(verifyJwt(sign({ sub: 'reg-1', exp: now() - 30 }), opts), 'within the clock skew');
});

test('in OIDC mode roles come only from server-side memberships; headers and token claims cannot raise them', async () => {
  saveDemo(buildDemoDataset());
  const { app } = spyApp(oidc());
  const forbidden = async (headers, method, url) => (await call(app, { method, url, headers, json: {} })).status;
  assert.equal(await forbidden({ 'x-demo-role': 'regulator' }, 'GET', '/api/v1/findings'), 401, 'the demo header is not an identity in OIDC mode');
  assert.equal(await forbidden(bearer('nitm-1', { roles: ['platform_admin'], groups: ['admins'], institution_code: null, scope: 'admin' }), 'POST', '/api/v1/automation/revalidate'), 403, 'token role claims are ignored');
  assert.equal((await call(app, { url: '/api/v1/findings', headers: bearer('stranger') })).json.code, 'no_membership');
  assert.equal(await forbidden({ authorization: 'Basic dXNlcjpwYXNz' }, 'GET', '/api/v1/findings'), 401);
  const nitm = await call(app, { url: '/api/v1/records', headers: { ...bearer('nitm-1'), 'x-demo-role': 'regulator', 'x-demo-institution': 'RCA' } });
  assert.equal(nitm.status, 200); assert.ok(nitm.json.data.every(r => r.institution_code === 'NITM'), 'spoofed scope headers change nothing');
  const reg = await call(app, { url: '/api/v1/dashboard/summary', headers: bearer('reg-1') });
  assert.equal(reg.json.principal.role, 'regulator'); assert.equal(reg.json.principal.name, 'Regulator Reviewer One'); assert.equal(reg.json.principal.method, 'oidc');
  assert.ok(!reg.json.principal.capabilities.includes('automation.revalidate'));
});

test('an institution principal cannot reach another institution\'s objects by changing an id', async () => {
  const db = buildDemoDataset();
  // A pending correction candidate that belongs to RCA, raised through the real import pipeline.
  const fields = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'admission_year', 'enrolment_status'];
  const nair = db.sourceRecords.find(r => r.id === 'SRC-121');
  commitImport(db, { parsed: { headers: fields, rows: [Object.fromEntries(fields.map(k => [k, k === 'apaar_id' ? '700000000991' : String(nair[k] ?? '')]))], row_numbers: [2] }, mapping: Object.fromEntries(fields.map(k => [k, k])), batchInstitution: 'RCA', multiInstitution: false, filename: 'rca-fix.csv', at: '2026-10-25T00:00:00.000Z' });
  const rcaCandidate = db.correctionCandidates.find(c => c.status === 'pending' && c.institution_code === 'RCA');
  saveDemo(db);
  const before = fileHash(path.join(dir, 'demo-db.json'));
  const rca = db.sourceRecords.find(r => r.institution_code === 'RCA');
  const rcaFinding = db.findings.find(f => f.evidence.every(id => db.sourceRecords.find(r => r.id === id).institution_code !== 'NITM'));
  const crossLink = db.identityLinks.find(l => l.records.some(id => db.sourceRecords.find(r => r.id === id).institution_code !== 'NITM') && ['candidate_for_review', 'needs_investigation'].includes(l.outcome));
  const rcaNotification = db.notifications.find(n => n.institution_code !== 'NITM');
  const real = createApp({ mode: 'development', auth: oidc() });
  const asNitm = { ...bearer('nitm-1'), 'x-demo-role': 'regulator' }; const asAdmin = bearer('nitm-admin');
  const attempts = [
    ['GET', `/api/v1/records/${rca.id}`, asNitm], ['GET', `/api/v1/records/${rca.id}/lineage`, asNitm], ['GET', `/api/v1/identities/${rca.id}/history`, asNitm], ['GET', `/api/v1/profiles/${rca.id}`, asNitm],
    ['GET', `/api/v1/findings/${rcaFinding.id}`, asNitm], ['GET', `/api/v1/findings/${rcaFinding.id}/explanation`, asNitm], ['GET', `/api/v1/evidence/checklist?finding=${rcaFinding.id}`, asNitm],
    ['GET', `/api/v1/matches/${crossLink.id}`, asNitm], ['POST', `/api/v1/matches/${crossLink.id}/decision`, asNitm, { decision: 'needs_more_evidence', note: 'x' }],
    ['POST', `/api/v1/findings/${rcaFinding.id}/decision`, asNitm, { outcome: 'dismissed', note: 'x' }], ['POST', `/api/v1/notifications/${rcaNotification.id}/acknowledge`, asNitm],
    ['POST', '/api/v1/simulations/correction', asNitm, { record_id: rca.id, field: 'enrolment_status', value: 'transferred', evidence: { kind: 'institution_record', reference: 'Registrar letter' } }],
    ['POST', `/api/v1/corrections/${rcaCandidate.id}/decision`, asAdmin, { decision: 'reject', note: 'x' }]
  ];
  for (const [method, url, headers, json] of attempts) {
    const res = await call(real, { method, url, headers, json });
    assert.equal(res.status, 404, `${method} ${url} is not found for NITM`);
    assert.doesNotMatch(res.text, /RCA|SVU|Ambiguous|Student RCA/, 'the refusal reveals nothing about the other institution');
  }
  const importOther = await call(real, { method: 'POST', url: '/api/v1/imports/confirm', headers: asAdmin, json: { filename: 'x.csv', csv: 'apaar_id,student_name,date_of_birth,institution_code,programme,academic_session,enrolment_status\n799999999999,X Y,01/01/2005,RCA,BA,2026-27,Active', institution_code: 'RCA', mapping: { apaar_id: 'apaar_id', student_name: 'student_name', date_of_birth: 'date_of_birth', institution_code: 'institution_code', programme: 'programme', academic_session: 'academic_session', enrolment_status: 'enrolment_status' } } });
  assert.equal(importOther.status, 403, 'an institution administrator cannot import for another institution');
  assert.equal(fileHash(path.join(dir, 'demo-db.json')), before, 'nothing was written');
});

test('authentication configuration is validated at startup and fails closed', () => {
  assert.equal(authFromEnv({}, 'development', { usersPath: path.join(dir, 'users.json') }).kind, 'local', 'development signs people in by default');
  assert.equal(authFromEnv({}, 'demo').kind, 'demo_header', 'the read-only demo keeps its viewing scope');
  assert.throws(() => authFromEnv({ EDUTRACE_AUTH: 'demo_header' }, 'development'), /only for the read-only demo/, 'a role header never authorises a writable mode');
  assert.equal(authFromEnv({ EDUTRACE_AUTH: 'local' }, 'demo', { usersPath: path.join(dir, 'demo-users.json') }).kind, 'local', 'local sign-in is explicitly opt-in for the synthetic demo');
  assert.throws(() => authFromEnv({ EDUTRACE_AUTH: 'basic' }, 'development'), StartupError);
  assert.throws(() => authFromEnv({ EDUTRACE_AUTH: 'oidc' }, 'development'), /missing EDUTRACE_OIDC_ISSUER/);
  assert.throws(() => authFromEnv({ EDUTRACE_AUTH: 'oidc' }, 'demo'), /supports simulated viewing or opt-in local accounts/);
  const jwks = path.join(dir, 'jwks.json'); const members = path.join(dir, 'members.json');
  fs.writeFileSync(jwks, JSON.stringify({ keys: KEYS })); fs.writeFileSync(members, JSON.stringify(MEMBERSHIPS));
  assert.equal(authFromEnv({ EDUTRACE_AUTH: 'oidc', EDUTRACE_OIDC_ISSUER: ISSUER, EDUTRACE_OIDC_AUDIENCE: AUDIENCE, EDUTRACE_OIDC_JWKS_PATH: jwks, EDUTRACE_MEMBERSHIPS_PATH: members }, 'development').kind, 'oidc');
  assert.throws(() => parseMemberships({ memberships: [{ issuer: ISSUER, subject: 'a', roles: ['superuser'], institution_code: null }] }, ISSUER), /roles must be/);
  assert.throws(() => parseMemberships({ memberships: [{ issuer: ISSUER, subject: 'a', roles: ['reviewer'], institution_code: 'NITM' }, { issuer: ISSUER, subject: 'a', roles: ['reviewer'], institution_code: 'RCA' }] }, ISSUER), /more than one scope/);
  assert.throws(() => parseMemberships({ memberships: [{ issuer: 'https://other', subject: 'a', roles: ['reviewer'], institution_code: null }] }, ISSUER), /configured issuer/);
  const env = { ...process.env, EDUTRACE_AUTH: 'bogus', PORT: '0', EDUTRACE_DB_PATH: path.join(dir, 'never.json') }; delete env.NODE_TEST_CONTEXT; delete env.EDUTRACE_MODE;
  const run = spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 1); assert.match(run.stderr, /EDUTRACE_AUTH="bogus" is not recognised/); assert.equal(fs.existsSync(path.join(dir, 'never.json')), false);
});
