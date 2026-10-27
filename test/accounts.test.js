const { dir } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { createApp } = require('../server');
const { saveDemo } = require('../src/seed');
const { buildDemoDataset } = require('../src/demo-data');
const { createDemoStore } = require('../src/demo-data');
const { hashPassword, verifyPassword, fileDirectory, postgresDirectory, localSessionAuthenticator } = require('../src/accounts');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct horse battery staple';
function call(app, { method = 'GET', url, headers = {}, json, raw }) {
  return new Promise(resolve => {
    const req = Readable.from(raw !== undefined ? [raw] : json === undefined ? [] : [JSON.stringify(json)]); req.method = method; req.url = url; req.headers = { host: 'localhost', ...headers };
    const res = new EventEmitter(); const chunks = []; let status = 200; let hdrs = {};
    res.writeHead = (c, h) => { status = c; hdrs = h; }; res.end = v => { if (v) chunks.push(v); const t = chunks.join(''); resolve({ status, headers: hdrs, text: t, json: t.startsWith('{') ? JSON.parse(t) : undefined }); };
    app.emit('request', req, res);
  });
}
async function setup({ now } = {}) {
  saveDemo(buildDemoDataset());
  const file = path.join(fs.mkdtempSync(path.join(dir, 'users-')), 'users.json');
  const directory = fileDirectory(file);
  for (const [username, role, institution_code] of [['nitm.reviewer', 'reviewer', 'NITM'], ['regulator.one', 'reviewer', null], ['auditor.one', 'auditor', null], ['nitm.admin', 'institution_admin', 'NITM'], ['gone.user', 'reviewer', 'NITM']]) {
    await directory.add({ username, display_name: username, role, institution_code, password_hash: hashPassword(PASSWORD), disabled: username === 'gone.user' });
  }
  const auth = localSessionAuthenticator({ directory, ...(now ? { now } : {}) });
  return { app: createApp({ auth }), auth, file };
}
async function signIn(app, username, password = PASSWORD) {
  const res = await call(app, { method: 'POST', url: '/api/v1/auth/login', json: { username, password } });
  if (res.status !== 200) return { res };
  return { res, cookie: res.headers['Set-Cookie'].split(';')[0], csrf: res.json.data.csrf_token };
}
function registrationApp() {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'registration-')), 'users.json');
  const directory = fileDirectory(file);
  const store = createDemoStore();
  const app = createApp({ mode: 'demo', store, auth: localSessionAuthenticator({ directory }) });
  return { app, directory, file, store };
}
const registrationInput = overrides => ({ institution: 'NITM', full_name: 'Synthetic Demo Judge', username: 'judge.example', password: PASSWORD, confirm_password: PASSWORD, ...overrides });

test('passwords are stored only as salted scrypt hashes and verified in constant time', () => {
  const a = hashPassword(PASSWORD); const b = hashPassword(PASSWORD);
  assert.match(a, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/); assert.notEqual(a, b, 'a fresh salt each time');
  assert.equal(verifyPassword(PASSWORD, a), true); assert.equal(verifyPassword('wrong password here', a), false);
  assert.equal(verifyPassword(PASSWORD, undefined), false, 'an unknown user never verifies');
  assert.throws(() => hashPassword('short'), /12 to 256/);
  assert.throws(() => hashPassword('x'.repeat(257)), /12 to 256/);
});

test('file account password reset changes only the hash and rejects unknown users', async () => {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'password-reset-')), 'users.json');
  const directory = fileDirectory(file); const oldHash = hashPassword(PASSWORD);
  await directory.add({ username: 'nitm.admin', display_name: 'NITM Admin', role: 'institution_admin', institution_code: 'NITM', password_hash: oldHash, disabled: true });
  const before = await directory.find('nitm.admin'); const nextHash = hashPassword('a different secure password');
  await directory.setPassword('nitm.admin', nextHash);
  const after = await directory.find('nitm.admin'); const { password_hash: beforeHash, ...beforeFields } = before; const { password_hash: afterHash, ...afterFields } = after;
  assert.deepEqual(afterFields, beforeFields, 'role, institution, display name, and disabled state remain unchanged');
  assert.notEqual(afterHash, beforeHash); assert.equal(afterHash, nextHash);
  assert.equal(verifyPassword('a different secure password', afterHash), true); assert.equal(verifyPassword(PASSWORD, afterHash), false);
  const unchanged = fs.readFileSync(file, 'utf8');
  await assert.rejects(directory.setPassword('missing.user', hashPassword('another secure password')), /No such user/);
  assert.equal(fs.readFileSync(file, 'utf8'), unchanged, 'a missing account leaves the file unchanged');
});

test('PostgreSQL account password reset is a parameterized single-column update', async () => {
  const calls = []; let rowCount = 1;
  const directory = postgresDirectory({ async query(sql, values) { calls.push({ sql, values }); return { rowCount }; } });
  const nextHash = hashPassword('a different secure password');
  await directory.setPassword('nitm.admin', nextHash);
  assert.deepEqual(calls[0], { sql: 'UPDATE app_users SET password_hash = $2 WHERE username = $1', values: ['nitm.admin', nextHash] });
  rowCount = 0;
  await assert.rejects(directory.setPassword('missing.user', nextHash), /No such user/);
  assert.deepEqual(calls[1].values, ['missing.user', nextHash]);
});

test('there are no default accounts, and the CLI never stores or prints a password', async () => {
  saveDemo(buildDemoDataset());
  const file = path.join(fs.mkdtempSync(path.join(dir, 'cli-')), 'users.json');
  const empty = createApp({ auth: localSessionAuthenticator({ directory: fileDirectory(file) }) });
  for (const username of ['admin', 'regulator', 'root', 'demo', 'test']) assert.equal((await call(empty, { method: 'POST', url: '/api/v1/auth/login', json: { username, password: 'password12345' } })).status, 401);
  const env = { ...process.env, EDUTRACE_USERS_PATH: file, EDUTRACE_NEW_PASSWORD: PASSWORD }; delete env.NODE_TEST_CONTEXT; delete env.EDUTRACE_STORE;
  const add = spawnSync(process.execPath, ['scripts/user.js', 'add', '--username', 'nitm.reviewer', '--name', 'NITM Reviewer', '--role', 'reviewer', '--institution', 'nitm'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const stored = fs.readFileSync(file, 'utf8');
  assert.ok(!stored.includes(PASSWORD)); assert.match(JSON.parse(stored).users[0].password_hash, /^scrypt\$/); assert.equal(JSON.parse(stored).users[0].institution_code, 'NITM');
  const list = spawnSync(process.execPath, ['scripts/user.js', 'list'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.ok(!list.stdout.includes('scrypt') && !list.stdout.includes(PASSWORD));
  const bad = spawnSync(process.execPath, ['scripts/user.js', 'add', '--username', 'x.admin', '--name', 'X', '--role', 'institution_admin'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /belongs to one institution/);
  const after = createApp({ auth: localSessionAuthenticator({ directory: fileDirectory(file) }) });
  assert.equal((await signIn(after, 'nitm.reviewer')).res.status, 200);
});

test('set-password CLI normalizes usernames, keeps account fields, and never prints the password or hash', async () => {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'password-reset-cli-')), 'users.json');
  const env = { ...process.env, EDUTRACE_USERS_PATH: file, EDUTRACE_NEW_PASSWORD: PASSWORD }; delete env.NODE_TEST_CONTEXT; delete env.EDUTRACE_STORE;
  const add = spawnSync(process.execPath, ['scripts/user.js', 'add', '--username', 'Reset.User', '--name', 'Reset User', '--role', 'institution_admin', '--institution', 'nitm'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  const before = JSON.parse(fs.readFileSync(file, 'utf8')).users[0]; const resetPassword = 'a different secure password';
  const resetEnv = { ...env, EDUTRACE_NEW_PASSWORD: resetPassword };
  const reset = spawnSync(process.execPath, ['scripts/user.js', 'set-password', '--username', 'RESET.USER'], { cwd: ROOT, env: resetEnv, encoding: 'utf8' });
  assert.equal(reset.status, 0, reset.stderr); assert.match(reset.stdout, /Password updated for account reset\.user \(file\)/);
  assert.doesNotMatch(reset.stdout + reset.stderr, /scrypt|password_hash|a different secure password/);
  const after = JSON.parse(fs.readFileSync(file, 'utf8')).users[0]; const { password_hash: beforeHash, ...beforeFields } = before; const { password_hash: afterHash, ...afterFields } = after;
  assert.deepEqual(afterFields, beforeFields); assert.notEqual(afterHash, beforeHash); assert.equal(verifyPassword(resetPassword, afterHash), true);

  const stdinPassword = 'stdin password reset value'; const stdinEnv = { ...env }; delete stdinEnv.EDUTRACE_NEW_PASSWORD;
  const stdinReset = spawnSync(process.execPath, ['scripts/user.js', 'set-password', '--username', 'reset.user'], { cwd: ROOT, env: stdinEnv, encoding: 'utf8', input: `${stdinPassword}\n` });
  assert.equal(stdinReset.status, 0, stdinReset.stderr); assert.doesNotMatch(stdinReset.stdout + stdinReset.stderr, /scrypt|password_hash|stdin password reset value/);
  assert.equal(verifyPassword(stdinPassword, JSON.parse(fs.readFileSync(file, 'utf8')).users[0].password_hash), true);

  const missing = spawnSync(process.execPath, ['scripts/user.js', 'set-password', '--username', 'missing.user'], { cwd: ROOT, env: resetEnv, encoding: 'utf8' });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /No such user/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).users.length, 1, 'a missing username is never created');
});

test('set-password CLI preserves the account file when password validation fails', async () => {
  const file = path.join(fs.mkdtempSync(path.join(dir, 'password-reset-validation-')), 'users.json');
  const directory = fileDirectory(file);
  await directory.add({ username: 'nitm.admin', display_name: 'NITM Admin', role: 'institution_admin', institution_code: 'NITM', password_hash: hashPassword(PASSWORD), disabled: true });
  const before = fs.readFileSync(file, 'utf8');
  for (const invalid of ['x'.repeat(11), 'x'.repeat(257)]) {
    const env = { ...process.env, EDUTRACE_USERS_PATH: file, EDUTRACE_NEW_PASSWORD: invalid }; delete env.NODE_TEST_CONTEXT; delete env.EDUTRACE_STORE;
    const result = spawnSync(process.execPath, ['scripts/user.js', 'set-password', '--username', 'nitm.admin'], { cwd: ROOT, env, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /12 to 256 characters/); assert.doesNotMatch(result.stderr + result.stdout, /scrypt\$/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'invalid passwords leave the stored account unchanged');
  }
});

test('open demo registration creates only a scoped reviewer and the account sees synthetic records only', async () => {
  const { app, directory, store } = registrationApp();
  const existing = { username: 'existing.rev', display_name: 'Existing Reviewer', role: 'reviewer', institution_code: 'SVU', password_hash: hashPassword('existing account password'), disabled: true };
  await directory.add(existing);
  const institutions = await call(app, { url: '/api/v1/institutions' });
  assert.equal(institutions.status, 200);
  assert.deepEqual(institutions.json.data.map(({ code }) => code), ['NITM', 'RCA', 'SVU']);
  assert.ok(institutions.json.data.every(item => Object.keys(item).sort().join(',') === 'code,name'));
  const runtime = await call(app, { url: '/api/v1/runtime' });
  assert.equal(runtime.json.data.registration_enabled, true); assert.equal(runtime.json.data.data_source, 'synthetic_in_memory');

  const created = await call(app, { method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, json: registrationInput({ full_name: '  Synthetic Demo Judge  ', username: 'Judge.Example' }) });
  assert.equal(created.status, 201, created.text); assert.deepEqual(created.json.data, { registered: true, username: 'judge.example' });
  const account = await directory.find('judge.example');
  assert.deepEqual({ display_name: account.display_name, role: account.role, institution_code: account.institution_code, disabled: account.disabled }, { display_name: 'Synthetic Demo Judge', role: 'reviewer', institution_code: 'NITM', disabled: false });
  assert.equal(verifyPassword(PASSWORD, account.password_hash), true); assert.notEqual(account.password_hash, PASSWORD);
  assert.equal(JSON.stringify(account).includes(PASSWORD), false);
  assert.deepEqual(await directory.find('existing.rev'), existing, 'registration leaves every existing account field unchanged');

  const signedIn = await signIn(app, 'judge.example'); assert.equal(signedIn.res.status, 200);
  const summary = await call(app, { url: '/api/v1/dashboard/summary', headers: { cookie: signedIn.cookie } });
  assert.equal(summary.status, 200); assert.equal(summary.json.principal.institution_code, 'NITM');
  assert.deepEqual(summary.json.principal.roles, ['reviewer']);
  assert.ok(!summary.json.principal.capabilities.includes('imports.write'));
  assert.ok(!summary.json.principal.capabilities.includes('data.initialize'));
  const listed = await call(app, { url: '/api/v1/records?limit=500', headers: { cookie: signedIn.cookie } });
  assert.equal(listed.status, 200); assert.ok(listed.json.data.length > 0); assert.ok(listed.json.data.every(record => record.institution_code === 'NITM'));
  const syntheticRecord = await call(app, { url: '/api/v1/records/SRC-1', headers: { cookie: signedIn.cookie } });
  assert.equal(syntheticRecord.status, 200); assert.match(syntheticRecord.text, /Student NITM 1/);
  const otherInstitution = store.load().sourceRecords.find(record => record.institution_code === 'RCA');
  const denied = await call(app, { url: `/api/v1/records/${otherInstitution.id}`, headers: { cookie: signedIn.cookie } });
  assert.equal(denied.status, 404); assert.doesNotMatch(denied.text, /Student RCA/);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/admin/initialize-empty-import', headers: { cookie: signedIn.cookie, 'x-demo-role': 'regulator' }, json: { confirmation: 'INITIALIZE_EMPTY_IMPORT' } })).json.code, 'read_only_demo');

  const csrfDenied = await call(app, { method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: signedIn.cookie }, json: {} });
  assert.equal(csrfDenied.status, 403); assert.equal(csrfDenied.json.code, 'csrf_failed');
  const logout = await call(app, { method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: signedIn.cookie, 'x-csrf-token': signedIn.csrf }, json: {} });
  assert.equal(logout.status, 200);
  assert.equal((await call(app, { url: '/api/v1/dashboard/summary', headers: { cookie: signedIn.cookie } })).status, 401);
});

test('registration validates fields, rejects privilege and institution overrides, and hides duplicate-account details', async () => {
  const invalidCases = [
    ['missing institution', { institution: '' }], ['unknown institution', { institution: 'UNKNOWN' }],
    ['blank name', { full_name: '   ' }], ['oversized name', { full_name: 'n'.repeat(121) }],
    ['invalid username', { username: 'not valid!' }], ['short password', { password: 'short', confirm_password: 'short' }],
    ['long password', { password: 'x'.repeat(257), confirm_password: 'x'.repeat(257) }],
    ['mismatched confirmation', { confirm_password: 'different confirmation value' }],
    ['email not collected', { email: 'judge@example.test' }], ['role injection', { role: 'platform_admin' }],
    ['roles injection', { roles: ['platform_admin'] }], ['capability injection', { capabilities: ['data.initialize'] }],
    ['scope injection', { scope: 'all' }], ['institution code override', { institution_code: 'RCA' }], ['admin flag', { isAdmin: true }]
  ];
  for (const [label, overrides] of invalidCases) {
    const { app, directory } = registrationApp();
    const result = await call(app, { method: 'POST', url: '/api/v1/auth/register', json: registrationInput(overrides) });
    assert.equal(result.status, 400, `${label}: ${result.text}`);
    assert.equal((await directory.list()).length, 0, `${label} creates no account`);
  }

  const { app, directory } = registrationApp();
  const first = await call(app, { method: 'POST', url: '/api/v1/auth/register', json: registrationInput() });
  assert.equal(first.status, 201);
  const duplicate = await call(app, { method: 'POST', url: '/api/v1/auth/register', json: registrationInput({ username: 'JUDGE.EXAMPLE' }) });
  assert.equal(duplicate.status, 400); assert.equal(duplicate.json.code, 'registration_failed');
  assert.doesNotMatch(duplicate.text, /judge\.example/); assert.equal((await directory.list()).length, 1);
});

test('registration rejects malformed, oversized and cross-origin requests and is rate limited', async () => {
  const { app, directory } = registrationApp();
  const malformed = await call(app, { method: 'POST', url: '/api/v1/auth/register', headers: { 'content-type': 'application/json' }, raw: '{' });
  assert.equal(malformed.status, 400);
  const tooLarge = await call(app, { method: 'POST', url: '/api/v1/auth/register', headers: { 'content-type': 'application/json' }, json: registrationInput({ full_name: 'x'.repeat(17000) }) });
  assert.equal(tooLarge.status, 413); assert.equal(tooLarge.json.code, 'body_too_large');
  const crossOrigin = await call(app, { method: 'POST', url: '/api/v1/auth/register', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, json: registrationInput() });
  assert.equal(crossOrigin.status, 403); assert.equal(crossOrigin.json.code, 'cross_origin');
  assert.equal((await directory.list()).length, 0);

  const limited = registrationApp();
  for (let i = 0; i < 5; i++) assert.equal((await call(limited.app, { method: 'POST', url: '/api/v1/auth/register', json: registrationInput({ institution: '' }) })).status, 400);
  const final = await call(limited.app, { method: 'POST', url: '/api/v1/auth/register', json: registrationInput() });
  assert.equal(final.status, 429); assert.equal(final.json.code, 'rate_limited');
});

test('registration and institution metadata are unavailable outside opt-in local-auth demo mode', async () => {
  const { directory } = registrationApp(); let reads = 0;
  const store = { kind: 'json-file', readOnly: false, async load() { reads++; throw new Error('development data must not be read'); } };
  const development = createApp({ mode: 'development', store, auth: localSessionAuthenticator({ directory }) });
  assert.equal((await call(development, { url: '/api/v1/institutions' })).status, 404);
  assert.equal((await call(development, { method: 'POST', url: '/api/v1/auth/register', json: registrationInput() })).status, 404);
  const simulatedDemo = createApp({ mode: 'demo', store: createDemoStore() });
  assert.equal((await call(simulatedDemo, { url: '/api/v1/institutions' })).status, 404);
  assert.equal((await call(simulatedDemo, { method: 'POST', url: '/api/v1/auth/register', json: registrationInput() })).json.code, 'read_only_demo');
  assert.equal(reads, 0); assert.equal((await directory.list()).length, 0);
});

test('sign-in answers the same for an unknown user and a wrong password, and sets a strict session cookie', async () => {
  const { app } = await setup();
  const unknown = await call(app, { method: 'POST', url: '/api/v1/auth/login', json: { username: 'nobody', password: PASSWORD } });
  const wrong = await call(app, { method: 'POST', url: '/api/v1/auth/login', json: { username: 'nitm.reviewer', password: 'not the password' } });
  assert.equal(unknown.status, 401); assert.deepEqual(unknown.json, wrong.json);
  assert.equal((await signIn(app, 'gone.user')).res.status, 401, 'a disabled account cannot sign in');
  const { res, cookie } = await signIn(app, 'nitm.reviewer');
  assert.match(res.headers['Set-Cookie'], /^edutrace_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/);
  assert.doesNotMatch(res.text, /scrypt|password_hash/);
  assert.deepEqual(res.json.data.user, { username: 'nitm.reviewer', display_name: 'nitm.reviewer', role: 'reviewer', institution_code: 'NITM' });
  const session = await call(app, { url: '/api/v1/auth/session', headers: { cookie } });
  assert.equal(session.json.data.authenticated, true);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, raw: `username=nitm.reviewer&password=${PASSWORD}` })).status, 415, 'a cross-site form cannot sign anyone in');
});

test('role and institution come only from the account; headers cannot escalate, and institutions stay isolated', async () => {
  const { app } = await setup();
  const db = buildDemoDataset(); const rca = db.sourceRecords.find(r => r.institution_code === 'RCA');
  const spoof = { 'x-demo-role': 'regulator', 'x-demo-institution': 'RCA' };
  assert.equal((await call(app, { url: '/api/v1/findings', headers: spoof })).status, 401, 'a role header alone is no identity');
  const nitm = await signIn(app, 'nitm.reviewer');
  const records = await call(app, { url: '/api/v1/records?limit=200', headers: { cookie: nitm.cookie, ...spoof } });
  assert.equal(records.status, 200); assert.ok(records.json.data.length && records.json.data.every(r => r.institution_code === 'NITM'));
  assert.equal((await call(app, { url: `/api/v1/records/${rca.id}`, headers: { cookie: nitm.cookie, ...spoof } })).status, 404);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/automation/revalidate', headers: { cookie: nitm.cookie, 'x-csrf-token': nitm.csrf, ...spoof }, json: {} })).status, 403);
  const auditor = await signIn(app, 'auditor.one');
  const f = db.findings.find(x => x.lifecycle_status === 'current');
  const decide = await call(app, { method: 'POST', url: `/api/v1/findings/${f.id}/decision`, headers: { cookie: auditor.cookie, 'x-csrf-token': auditor.csrf, ...spoof }, json: { outcome: 'dismissed', note: 'x' } });
  assert.equal(decide.status, 403); assert.equal(decide.json.capability, 'findings.decide');
  assert.equal((await call(app, { url: '/api/v1/audit', headers: { cookie: auditor.cookie } })).status, 200, 'auditors read the audit history');
  const reg = await signIn(app, 'regulator.one');
  assert.equal((await call(app, { url: `/api/v1/records/${rca.id}`, headers: { cookie: reg.cookie } })).status, 200, 'cross-institution scope comes from the account');
});

test('every write needs the session\'s CSRF token; sign-out and idle expiry end the session; failures lock sign-in', async () => {
  let t = Date.parse('2026-10-26T10:00:00Z');
  const { app } = await setup({ now: () => t });
  const s = await signIn(app, 'nitm.reviewer');
  const f = buildDemoDataset().findings.find(x => x.lifecycle_status === 'current' && x.evidence.length === 1 && x.rule_code === 'APAAR_MALFORMED');
  const url = `/api/v1/findings/${f.id}/decision`; const json = { outcome: 'awaiting_verification', note: 'Waiting.' };
  assert.equal((await call(app, { method: 'POST', url, headers: { cookie: s.cookie }, json })).json.code, 'csrf_failed');
  assert.equal((await call(app, { method: 'POST', url, headers: { cookie: s.cookie, 'x-csrf-token': 'x'.repeat(s.csrf.length) }, json })).json.code, 'csrf_failed');
  const ok = await call(app, { method: 'POST', url, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, json });
  assert.equal(ok.status, 200); assert.equal(ok.json.data.decision.reviewer, 'nitm.reviewer', 'the actor is the signed-in account');
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: s.cookie, 'x-csrf-token': s.csrf }, json: {} })).status, 200);
  assert.equal((await call(app, { url: '/api/v1/findings', headers: { cookie: s.cookie } })).status, 401, 'signed out');
  const idle = await signIn(app, 'nitm.reviewer');
  t += 31 * 60000; assert.equal((await call(app, { url: '/api/v1/findings', headers: { cookie: idle.cookie } })).status, 401, 'idle sessions expire');
  for (let i = 0; i < 5; i++) await signIn(app, 'regulator.one', 'wrong password!!');
  const locked = await call(app, { method: 'POST', url: '/api/v1/auth/login', json: { username: 'regulator.one', password: PASSWORD } });
  assert.equal(locked.status, 429); assert.equal(locked.json.code, 'locked');
  t += 16 * 60000; assert.equal((await signIn(app, 'regulator.one')).res.status, 200, 'the lock expires');
});
