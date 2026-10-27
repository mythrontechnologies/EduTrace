const { dir, dbPath } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createApp } = require('../server');
const { saveDemo, loadDemo } = require('../src/seed');
const { buildDemoDataset } = require('../src/demo-data');
const { createRateLimiter } = require('../src/security');
const { createBackup, verifyBackup, rehearseRestore } = require('../src/backup');
const { isCurrent } = require('../src/engine');

const REG = { 'x-demo-role': 'regulator' };
function call(app, { method = 'GET', url, headers = REG, raw, json, stream }) {
  return new Promise(resolve => {
    const request = stream || Readable.from(raw !== undefined ? [raw] : json === undefined ? [] : [JSON.stringify(json)]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', ...headers };
    const response = new EventEmitter(); let status = 200; let hdrs = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; hdrs = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, headers: hdrs, text, json: hdrs['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    app.emit('request', request, response);
  });
}

test('every response carries security headers, and the page has a strict content security policy', async () => {
  saveDemo(buildDemoDataset());
  const app = createApp();
  const html = await call(app, { url: '/' }); const api = await call(app, { url: '/api/v1/findings' }); const csv = await call(app, { url: '/api/v1/reports/findings.csv' }); const health = await call(app, { url: '/healthz' });
  for (const res of [html, api, csv, health]) {
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff'); assert.equal(res.headers['X-Frame-Options'], 'DENY');
    assert.equal(res.headers['Referrer-Policy'], 'no-referrer'); assert.equal(res.headers['Cross-Origin-Opener-Policy'], 'same-origin');
    assert.equal(res.headers['Cache-Control'], 'no-store'); assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  }
  const csp = html.headers['Content-Security-Policy'];
  assert.match(csp, /default-src 'self'/); assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /base-uri 'none'/); assert.match(csp, /connect-src 'self'/);
  const scriptSrc = csp.split('; ').find(d => d.startsWith('script-src'));
  assert.doesNotMatch(scriptSrc, /unsafe-inline|unsafe-eval|\*/, 'no inline script or eval is allowed wholesale');
  // Hash the inline script as a browser does: after the HTML parser normalises line endings to LF.
  const inline = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
  assert.ok(scriptSrc.includes(`'sha256-${crypto.createHash('sha256').update(inline).digest('base64')}'`), 'the only inline script is allowed by its exact hash');
  assert.equal(api.headers['Content-Security-Policy'], undefined);
});

test('no cross-origin access is granted', async () => {
  const app = createApp();
  const pre = await call(app, { method: 'OPTIONS', url: '/api/v1/findings', headers: { ...REG, origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
  assert.notEqual(pre.status, 204); assert.equal(pre.headers['Access-Control-Allow-Origin'], undefined); assert.equal(pre.headers['Access-Control-Allow-Methods'], undefined);
  const get = await call(app, { url: '/api/v1/dashboard/summary', headers: { ...REG, origin: 'https://evil.example' } });
  assert.equal(get.headers['Access-Control-Allow-Origin'], undefined);
});

test('server errors are generic in every mode and the log carries neither the query nor the body', async () => {
  const secret = 'Ravi Iyer 700000000123';
  const store = { kind: 'memory', load: () => { throw new Error(`EACCES: open '${path.join(dir, 'private', 'demo-db.json')}'`); }, save() {}, reset() {} };
  const { error } = console; const logged = []; console.error = (...a) => logged.push(a.map(x => (x instanceof Error ? `${x.message}\n${x.stack}` : String(x))).join(' '));
  try {
    for (const mode of ['development', 'demo']) {
      const res = await call(createApp({ mode, store }), { url: `/api/v1/findings?q=${encodeURIComponent(secret)}` });
      assert.equal(res.status, 500); assert.deepEqual(res.json, { error: 'Unexpected server error.' }); assert.doesNotMatch(res.text, /EACCES|private|stack|at /);
    }
  } finally { console.error = error; }
  assert.ok(logged.length >= 2); assert.ok(logged.every(l => !l.includes('Ravi') && !l.includes('700000000123')), 'the query string is not logged');
});

test('request bodies: wrong content types, malformed JSON, oversized and interrupted uploads are refused', async () => {
  saveDemo(buildDemoDataset()); const app = createApp();
  const url = '/api/v1/simulations/correction';
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp']) {
    const res = await call(app, { method: 'POST', url, headers: { ...REG, 'content-type': type }, raw: '{}' });
    assert.equal(res.status, 415, type); assert.equal(res.json.code, 'unsupported_media_type');
  }
  assert.equal((await call(app, { method: 'POST', url, headers: { ...REG, 'content-type': 'application/json; charset=utf-8' }, json: {} })).status, 404, 'JSON is accepted (the empty request then fails validation)');
  const bad = await call(app, { method: 'POST', url, raw: '{"record_id": ' }); assert.equal(bad.status, 400); assert.match(bad.json.error, /valid JSON/);
  const big = await call(app, { method: 'POST', url, raw: `{"x":"${'y'.repeat(2 * 1024 * 1024)}"}` }); assert.equal(big.status, 400); assert.match(big.json.error, /2 MB/);
  let started = false;
  const stream = new Readable({ read() { if (started) return; started = true; this.push('{"record_id":'); setTimeout(() => this.destroy(new Error('socket hang up')), 10); } });
  const cut = await call(app, { method: 'POST', url, stream }); assert.equal(cut.status, 400); assert.match(cut.json.error, /interrupted/);
});

test('repeated requests are rate limited per client and bucket, with Retry-After', async () => {
  saveDemo(buildDemoDataset());
  const app = createApp({ limits: { windowMs: 60000, read: 3, write: 2, simulation: 1 } });
  for (let i = 0; i < 3; i++) assert.equal((await call(app, { url: '/api/v1/dashboard/summary' })).status, 200);
  const limited = await call(app, { url: '/api/v1/dashboard/summary' });
  assert.equal(limited.status, 429); assert.equal(limited.json.code, 'rate_limited'); assert.ok(Number(limited.headers['Retry-After']) >= 1);
  assert.equal((await call(app, { url: '/healthz' })).status, 200, 'health checks are never limited');
  const sim = { record_id: 'SRC-250', field: 'enrolment_status', value: 'completed', evidence: { kind: 'institution_record', reference: 'Registrar letter' } };
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/simulations/correction', json: sim })).status, 200);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/simulations/correction', json: sim })).status, 429, 'simulations have their own, smaller budget');
  let t = 0; const limiter = createRateLimiter({ windowMs: 1000, read: 1 }, () => t);
  assert.equal(limiter.take('a', 'read'), 0); assert.ok(limiter.take('a', 'read') > 0); assert.equal(limiter.take('b', 'read'), 0, 'clients are counted separately');
  t = 1000; assert.equal(limiter.take('a', 'read'), 0, 'the window resets');
});

test('the findings export neutralises spreadsheet formulas', async () => {
  const db = buildDemoDataset();
  const f = db.findings.find(isCurrent); f.title = '=HYPERLINK("https://evil.example","click")'; f.id = '+cmd'; saveDemo(db);
  const text = (await call(createApp(), { url: '/api/v1/reports/findings.csv?lifecycle=all' })).text;
  assert.ok(text.includes(`"'=HYPERLINK(""https://evil.example"",""click"")"`), 'the title is prefixed so it stays text');
  assert.ok(text.split('\n').some(line => line.startsWith("'+cmd,")), 'the id is prefixed too');
  assert.ok(!text.split('\n').some(line => /(^|,)[=+@]/.test(line) && !/(^|,)"?'[=+@-]/.test(line)), 'no cell starts with a formula character');
});

test('overlapping writes are serialised, so neither update is lost', async () => {
  const decide = (app, f) => call(app, { method: 'POST', url: `/api/v1/findings/${f.id}/decision`, json: { outcome: 'awaiting_verification', note: `note for ${f.id}` } });
  const pending = db => db.findings.filter(f => isCurrent(f) && f.review_status === 'pending').slice(0, 2);
  // Without serialisation, both requests load the same snapshot and the later save discards the earlier one.
  saveDemo(buildDemoDataset()); let targets = pending(loadDemo());
  const unsafe = createApp({ serializeWrites: false });
  await Promise.all(targets.map(f => decide(unsafe, f)));
  const lost = loadDemo(); const keptUnsafe = targets.filter(f => lost.findings.find(x => x.id === f.id).review_status === 'awaiting_verification').length;
  assert.equal(keptUnsafe, 1, 'the lost-update hazard is real without serialisation');
  saveDemo(buildDemoDataset()); targets = pending(loadDemo());
  const app = createApp();
  const results = await Promise.all(targets.map(f => decide(app, f)));
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  const after = loadDemo();
  for (const f of targets) assert.equal(after.findings.find(x => x.id === f.id).review_status, 'awaiting_verification', 'both decisions persisted');
  assert.equal(after.decisionReceipts.length, 2); assert.equal(after.auditEvents.filter(e => e.note?.startsWith('note for')).length, 2);
});

test('backups are verified, never overwrite, and a restore is rehearsed away from the working file', () => {
  saveDemo(buildDemoDataset());
  const backups = fs.mkdtempSync(path.join(dir, 'backups-'));
  const b = createBackup(dbPath, backups, { label: 'test', now: new Date('2026-10-26T10:00:00Z') });
  assert.equal(b.sha256, crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'));
  assert.ok(verifyBackup(b.path).ok);
  assert.throws(() => createBackup(dbPath, backups, { label: 'test', now: new Date('2026-10-26T10:00:00Z') }), /already exists; nothing was overwritten/);
  const report = rehearseRestore(b.path, { workingPath: dbPath });
  assert.equal(report.ok, true, report.problems.join('; ')); assert.notEqual(path.resolve(report.restored_to), path.resolve(dbPath));
  assert.ok(report.counts.sourceRecords >= 360);
  const tampered = path.join(backups, 'tampered.json'); fs.copyFileSync(b.path, tampered); fs.copyFileSync(b.manifest, `${tampered}.sha256`);
  const doc = JSON.parse(fs.readFileSync(tampered, 'utf8')); doc.auditEvents.push({ id: 'AUD-x', finding_id: 'missing', action: 'x', at: 'x' }); fs.writeFileSync(tampered, JSON.stringify(doc));
  assert.equal(verifyBackup(tampered).reason, 'hash_mismatch');
  const bad = rehearseRestore(tampered, { workingPath: dbPath });
  assert.equal(bad.ok, false); assert.ok(bad.problems.some(p => /hash_mismatch/.test(p))); assert.ok(bad.problems.some(p => /missing finding/.test(p)));
});
