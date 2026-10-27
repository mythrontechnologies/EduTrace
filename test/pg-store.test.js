// Integration tests against a real PostgreSQL server (embedded-postgres devDependency, or EDUTRACE_TEST_DATABASE_URL).
// If no server can be started, every test is skipped with the reason: reported as not run, never as passed.
const { dir, dbPath } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { startPostgres } = require('../test-support/postgres');
const { createPostgresStore, StoreError } = require('../src/pg-store');
const { TABLES } = require('../src/relational');
const { createApp } = require('../server');
const { saveDemo, loadDemo } = require('../src/seed');
const { buildDemoDataset } = require('../src/demo-data');
const { canonical, verifyReceipt } = require('../src/receipts');
const { isCurrent, isActiveRecord } = require('../src/engine');

const ROOT = path.join(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'db', 'postgres', 'schema.sql'), 'utf8');
let server = null; let unavailable = null; let n = 0;
test.before(async () => { try { server = await startPostgres(); } catch (error) { unavailable = `PostgreSQL could not be started: ${error.message}`; } });
test.after(async () => { if (server) await server.stop(); });

// A fresh database per test, migrated unless asked otherwise.
async function freshDb({ migrate = true } = {}) {
  const name = `t${process.pid}_${++n}`;
  const admin = new Client({ connectionString: server.url }); await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  const url = server.url.replace(/\/[^/]+$/, `/${name}`);
  if (migrate) { const c = new Client({ connectionString: url }); await c.connect(); await c.query(SCHEMA); await c.end(); }
  return url;
}
const call = (app, { method = 'GET', url, json }) => new Promise(resolve => {
  const req = Readable.from(json === undefined ? [] : [JSON.stringify(json)]); req.method = method; req.url = url; req.headers = { host: 'localhost', 'x-demo-role': 'regulator' };
  const res = new EventEmitter(); const chunks = []; let status = 200; res.writeHead = c => { status = c; }; res.end = v => { if (v) chunks.push(v); const t = chunks.join(''); resolve({ status, json: t.startsWith('{') ? JSON.parse(t) : t }); };
  app.emit('request', req, res);
});
const live = t => { if (!server) { t.skip(unavailable || 'PostgreSQL unavailable'); return false; } return true; };

test('an unmigrated database is refused; the schema is applied only by the explicit migrate command', async t => {
  if (!live(t)) return;
  const url = await freshDb({ migrate: false });
  const store = createPostgresStore({ url });
  await assert.rejects(store.verify(), e => e instanceof StoreError && e.code === 'schema_missing');
  const env = { ...process.env, EDUTRACE_DATABASE_URL: url }; delete env.NODE_TEST_CONTEXT;
  const migrate = spawnSync(process.execPath, ['scripts/db.js', 'migrate'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(migrate.status, 0, migrate.stderr); assert.match(migrate.stdout, /Schema applied \(version 1\)/);
  assert.deepEqual(await store.verify(), { schema_version: 1 });
  const again = spawnSync(process.execPath, ['scripts/db.js', 'migrate'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(again.status, 1); assert.match(again.stderr, /already exist; nothing was changed/);
  const empty = await store.load();
  assert.equal(empty.sourceRecords.length, 0, 'an empty database stays empty: nothing is seeded');
  await assert.rejects(store.reset(), e => e.code === 'reset_unsupported');
  await store.close();
});

test('a document survives a round trip through PostgreSQL exactly', async t => {
  if (!live(t)) return;
  const store = createPostgresStore({ url: await freshDb() });
  const doc = buildDemoDataset();
  await store.importInto(doc);
  assert.equal(canonical(await store.load()), canonical(doc));
  await assert.rejects(store.importInto(doc), e => e.code === 'not_empty');
  await store.close();
});

// The same reviewer workflow on both stores must end in the same state.
async function workflow(app) {
  const link = (await call(app, { url: '/api/v1/matches' })).json.data.find(m => m.status === 'needs_review');
  assert.equal((await call(app, { method: 'POST', url: `/api/v1/matches/${link.id}/decision`, json: { decision: 'needs_more_evidence', note: "O'Brien'); DROP TABLE findings; --" } })).status, 200);
  const finding = (await call(app, { url: '/api/v1/findings?status=pending' })).json.data.find(f => f.rule_code === 'APAAR_MALFORMED');
  assert.equal((await call(app, { method: 'POST', url: `/api/v1/findings/${finding.id}/decision`, json: { outcome: 'awaiting_verification', note: 'Waiting.' } })).status, 200);
  const candidate = (await call(app, { url: '/api/v1/corrections' })).json.data[0];
  assert.equal((await call(app, { method: 'POST', url: `/api/v1/corrections/${candidate.id}/decision`, json: { decision: 'confirm', confirm: true, note: 'Confirmed.' } })).status, 200);
  const csv = 'source_reference,apaar_id,student_name,date_of_birth,institution_code,programme,academic_session,enrolment_status\nRCA-9,911111111111,Kiran Bose,2002-02-02,RCA,BA,2026-27,Active';
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/imports/confirm', json: { filename: 'r.csv', csv, institution_code: 'RCA', mapping: Object.fromEntries(csv.split('\n')[0].split(',').map(h => [h, h])) } })).status, 201);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/automation/revalidate', json: {} })).status, 200);
  assert.equal((await call(app, { method: 'POST', url: '/api/v1/simulations/correction', json: { record_id: 'SRC-250', field: 'enrolment_status', value: 'completed', evidence: { kind: 'institution_record', reference: 'Registrar letter' } } })).status, 200);
}
// Imported record ids carry the import time (SRC-UP-<ms>-<row>); that part differs between two runs by design.
function normalise(db) {
  const set = ids => [...ids].sort().join(',');
  const out = {
    findings: db.findings.map(f => `${f.rule_code}|${set(f.evidence)}|${f.review_status}|${f.lifecycle_status}`).sort(),
    links: db.identityLinks.map(l => `${set(l.records)}|${l.outcome}`).sort(),
    records: db.sourceRecords.map(r => `${r.id}|${isActiveRecord(r)}|${r.processing?.status}|${r.lineage?.relation || 'original'}`).sort(),
    corrections: (db.correctionCandidates || []).map(c => `${c.earlier}>${c.later}|${c.status}`).sort(),
    decisions: Object.values(db.matchDecisions || {}).map(d => `${d.decision}|${d.note}`).sort(),
    audit: db.auditEvents.map(e => `${e.action}|${e.actor}`).sort(),
    receipts: (db.decisionReceipts || []).map(r => `${r.kind}|${verifyReceipt(db, r).status}`).sort()
  };
  return JSON.parse(JSON.stringify(out).replace(/SRC-UP-\d+-/g, 'SRC-UP-*-'));
}

test('the reviewer workflow on PostgreSQL ends in the same state as on the JSON store', async t => {
  if (!live(t)) return;
  const store = createPostgresStore({ url: await freshDb() });
  await store.importInto(buildDemoDataset());
  await workflow(createApp({ store }));
  const pgImportAudit = (await store.load()).auditEvents.filter(event => event.action === 'import_batch_committed');
  assert.equal(pgImportAudit.length, 1); assert.equal(pgImportAudit[0].actor, 'demo:regulator');
  saveDemo(buildDemoDataset());
  await workflow(createApp());
  const jsonImportAudit = loadDemo().auditEvents.filter(event => event.action === 'import_batch_committed');
  assert.equal(jsonImportAudit.length, 1); assert.equal(jsonImportAudit[0].actor, 'demo:regulator');
  const pg = normalise(await store.load()); const json = normalise(loadDemo());
  assert.deepEqual(pg, json);
  assert.ok(pg.receipts.length === 3 && pg.receipts.every(r => r.endsWith('|verified')), 'receipts written to PostgreSQL verify');
  assert.ok(pg.decisions.some(d => d.includes("DROP TABLE findings")), 'the note is stored as data');
  const c = new Client({ connectionString: store.pool.options.connectionString }); await c.connect();
  assert.ok(Number((await c.query('SELECT count(*) AS n FROM findings')).rows[0].n) > 0, 'the findings table still exists');
  await c.end(); await store.close();
});

test('append-only rows cannot change: the store refuses, and the database triggers refuse too', async t => {
  if (!live(t)) return;
  const url = await freshDb(); const store = createPostgresStore({ url });
  await store.importInto(buildDemoDataset());
  const doc = await store.load(); doc.sourceRecords[0].student_name = 'Changed';
  await assert.rejects(store.save(doc), e => e.code === 'append_only_violation');
  const doc2 = await store.load(); doc2.auditEvents.pop();
  await assert.rejects(store.save(doc2), e => e.code === 'append_only_violation');
  const c = new Client({ connectionString: url }); await c.connect();
  await c.query("INSERT INTO decision_receipts VALUES ('RCPT-t', 'k', now(), repeat('a', 64), 0, '{}')");
  await c.query("INSERT INTO consent_records VALUES ('CONS-t', 'SRC-1', 'NITM', 'identity_verification', 'granted', 'x', now(), 0, '{}')");
  for (const sql of ["UPDATE source_records SET source_row = 1", 'DELETE FROM audit_events', "UPDATE decision_receipts SET kind = 'x'", 'DELETE FROM consent_records', 'DELETE FROM lineage_events']) await assert.rejects(c.query(sql), /append-only/, sql);
  await c.end();
  assert.notEqual((await store.load()).sourceRecords[0].student_name, 'Changed');
  await store.close();
});

test('concurrent writers: the second save of a stale copy is refused, nothing is lost, and failures roll back', async t => {
  if (!live(t)) return;
  const store = createPostgresStore({ url: await freshDb() });
  await store.importInto(buildDemoDataset());
  const a = await store.load(); const b = await store.load();
  a.findings.find(isCurrent).review_status = 'awaiting_verification'; await store.save(a);
  b.findings.find(isCurrent).review_status = 'resolved';
  await assert.rejects(store.save(b), e => e.status === 409 && e.code === 'conflict');
  assert.equal((await store.load()).findings.find(isCurrent).review_status, 'awaiting_verification');
  const before = canonical(await store.load());
  const bad = await store.load(); bad.consentRecords = [...(bad.consentRecords || []), { id: 'C-1', lineage_id: 'SRC-1', institution_code: 'NITM', purpose: 'identity_verification', status: 'maybe', recorded_by: 'x', recorded_at: '2026-10-26T00:00:00.000Z' }];
  await assert.rejects(store.save(bad), e => e.code === 'database_error');
  assert.equal(canonical(await store.load()), before, 'a refused save leaves nothing behind');
  const broken = await store.load(); broken.findings[0].evidence.push('SRC-nope');
  await assert.rejects(store.save(broken), e => e.code === 'invalid_document');
  await assert.rejects(store.save(buildDemoDataset()), e => e.code === 'unknown_document');
  await store.close();
});

test('startup with the PostgreSQL store verifies the database and never falls back to JSON', async t => {
  if (!live(t)) return;
  const run = env => { const base = { ...process.env }; delete base.NODE_TEST_CONTEXT; delete base.EDUTRACE_MODE; const e = { ...base, PORT: '0', EDUTRACE_DB_PATH: path.join(dir, 'never.json'), ...env }; return spawnSync(process.execPath, ['server.js'], { cwd: ROOT, env: e, encoding: 'utf8', timeout: 30000 }); };
  const unmigrated = run({ EDUTRACE_STORE: 'postgres', EDUTRACE_DATABASE_URL: await freshDb({ migrate: false }) });
  assert.equal(unmigrated.status, 1); assert.match(unmigrated.stderr, /schema is not installed/); assert.doesNotMatch(unmigrated.stdout, /running at/);
  const unreachable = run({ EDUTRACE_STORE: 'postgres', EDUTRACE_DATABASE_URL: 'postgres://u:p@127.0.0.1:9/none' });
  assert.equal(unreachable.status, 1); assert.match(unreachable.stderr, /unreachable/);
  assert.match(run({ EDUTRACE_STORE: 'postgres' }).stderr, /needs EDUTRACE_DATABASE_URL/);
  assert.match(run({ EDUTRACE_STORE: 'postgres', EDUTRACE_MODE: 'demo', EDUTRACE_DATABASE_URL: server.url }).stderr, /development mode only/);
  assert.equal(fs.existsSync(path.join(dir, 'never.json')), false, 'no JSON database was created as a fallback');
  assert.ok(dbPath);
});

test('accounts live in PostgreSQL: the CLI creates one, and it signs in to an app on the PostgreSQL store', async t => {
  if (!live(t)) return;
  const url = await freshDb();
  const store = createPostgresStore({ url }); await store.importInto(buildDemoDataset());
  const env = { ...process.env, EDUTRACE_STORE: 'postgres', EDUTRACE_DATABASE_URL: url, EDUTRACE_NEW_PASSWORD: 'correct horse battery staple' }; delete env.NODE_TEST_CONTEXT;
  const add = spawnSync(process.execPath, ['scripts/user.js', 'add', '--username', 'rca.reviewer', '--name', 'RCA Reviewer', '--role', 'reviewer', '--institution', 'RCA'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr); assert.match(add.stdout, /created \(postgres\)/);
  const { localSessionAuthenticator, postgresDirectory } = require('../src/accounts');
  const app = createApp({ store, auth: localSessionAuthenticator({ directory: postgresDirectory(store.pool) }) });
  const login = await new Promise(resolve => {
    const req = Readable.from([JSON.stringify({ username: 'rca.reviewer', password: 'correct horse battery staple' })]); req.method = 'POST'; req.url = '/api/v1/auth/login'; req.headers = { host: 'localhost' };
    const res = new EventEmitter(); let headers = {}; let status = 0; res.writeHead = (c, h) => { status = c; headers = h; }; res.end = () => resolve({ status, cookie: headers['Set-Cookie']?.split(';')[0] });
    app.emit('request', req, res);
  });
  assert.equal(login.status, 200);
  const records = await new Promise(resolve => {
    const req = Readable.from([]); req.method = 'GET'; req.url = '/api/v1/records?limit=200'; req.headers = { host: 'localhost', cookie: login.cookie, 'x-demo-role': 'regulator' };
    const res = new EventEmitter(); const chunks = []; res.writeHead = () => {}; res.end = v => { if (v) chunks.push(v); resolve(JSON.parse(chunks.join(''))); };
    app.emit('request', req, res);
  });
  assert.ok(records.data.length && records.data.every(r => r.institution_code === 'RCA'), 'scope from the account stored in PostgreSQL');
  const c = new Client({ connectionString: url }); await c.connect();
  const row = (await c.query('SELECT password_hash FROM app_users WHERE username = $1', ['rca.reviewer'])).rows[0];
  assert.match(row.password_hash, /^scrypt\$/); await c.end(); await store.close();
});

test('a save writes only rows that changed, and the stored state still equals the document exactly', async t => {
  if (!live(t)) return;
  const store = createPostgresStore({ url: await freshDb() });
  try {
    await store.importInto(buildDemoDataset());
    // xmin changes when PostgreSQL writes a new version of a row, so it shows which rows a save rewrote.
    const versions = async table => new Map((await store.pool.query(`SELECT xmin::text AS v, * FROM ${table}`)).rows.map(r => [JSON.stringify(TABLES[table].pk.map(c => r[c])), r.v]));
    const rewritten = (a, b) => [...b.entries()].filter(([k, v]) => a.get(k) !== v).length;
    const watched = ['findings', 'record_processing', 'identity_links', 'finding_evidence', 'identity_link_records', 'notification_items', 'notification_registry'];
    const snapshot = async () => Object.fromEntries(await Promise.all(watched.map(async tb => [tb, await versions(tb)])));

    let before = await snapshot();
    await store.save(await store.load());
    let after = await snapshot();
    for (const tb of watched) assert.equal(rewritten(before[tb], after[tb]), 0, `an unchanged save rewrites no ${tb} row`);

    const app = createApp({ store });
    const link = (await store.load()).identityLinks.find(l => l.outcome === 'candidate_for_review');
    before = after;
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/matches/${link.id}/decision`, json: { decision: 'needs_more_evidence', note: 'Waiting for the registrar.' } })).status, 200);
    after = await snapshot();
    assert.ok(rewritten(before.record_processing, after.record_processing) <= 2, 'a decision does not rewrite every record');
    assert.ok(rewritten(before.findings, after.findings) <= 2);
    const decided = await store.load();
    assert.equal(decided.matchDecisions && Object.values(decided.matchDecisions).some(d => d.decision === 'needs_more_evidence'), true, 'the decision itself was stored');

    // Edits, removals and additions across parent and child tables.
    const doc = await store.load();
    const f = doc.findings.find(x => x.evidence.length >= 2);
    f.title = 'Edited title'; f.evidence = [...f.evidence].reverse();
    const n = doc.notifications.find(x => x.items.length >= 2); const removedItem = n.items.pop();
    const r = doc.sourceRecords.find(x => x.processing); r.processing = { ...r.processing, status: `${r.processing.status}_edited` };
    await store.save(doc);
    const reloaded = await store.load();
    assert.equal(canonical(reloaded), canonical(doc), 'the stored state equals the document');
    assert.equal(reloaded.findings.find(x => x.id === f.id).title, 'Edited title');
    assert.deepEqual(reloaded.findings.find(x => x.id === f.id).evidence, f.evidence);
    assert.equal(reloaded.sourceRecords.find(x => x.id === r.id).processing.status, r.processing.status);
    assert.ok(!JSON.stringify(reloaded.notifications.find(x => x.id === n.id).items).includes(JSON.stringify(removedItem)), 'the removed child row is gone');

    // A stale copy is still refused after these partial writes.
    const stale = await store.load(); await store.save(await store.load());
    await assert.rejects(store.save(stale), e => e.code === 'conflict');
  } finally { await store.close(); }
});

test('reads share one snapshot while the stored version is unchanged, and never see stale data after a save', async t => {
  if (!live(t)) return;
  const url = await freshDb();
  const store = createPostgresStore({ url }); const other = createPostgresStore({ url });
  // Statements sent by this process, so a read can be shown to cost one small query.
  const query = Client.prototype.query; const sent = [];
  Client.prototype.query = function (...a) { sent.push(typeof a[0] === 'string' ? a[0] : a[0]?.text); return query.apply(this, a); };
  try {
    await store.importInto(buildDemoDataset());
    const first = await store.load({ shared: true });
    sent.length = 0;
    assert.equal(await store.load({ shared: true }), first, 'an unchanged version returns the same snapshot');
    assert.deepEqual(sent, ['SELECT value FROM edutrace_meta WHERE key = $1'], 'and reads only the version row');
    await assert.rejects(store.save(first), e => e.code === 'unknown_document', 'a shared snapshot can never be saved');
    const own = await store.load(); assert.notEqual(own, first, 'a writer gets its own copy');

    // A save through this store: the next read sees it.
    own.findings[0].title = 'Saved through this store'; await store.save(own);
    const afterOwn = await store.load({ shared: true });
    assert.notEqual(afterOwn, first); assert.equal(afterOwn.findings[0].title, 'Saved through this store');
    assert.equal(first.findings[0].title, buildDemoDataset().findings[0].title, 'the earlier snapshot was not changed by the save');

    // A save through another store (another process, in production): the version check finds it.
    const theirs = await other.load(); theirs.findings[0].title = 'Saved elsewhere'; await other.save(theirs);
    assert.equal((await store.load({ shared: true })).findings[0].title, 'Saved elsewhere');

    // A save compared against the snapshot's rows stores exactly the document, as one that reads every table does.
    await store.load({ shared: true });
    const doc = await store.load();
    const link = doc.identityLinks.find(l => l.outcome === 'not_linked'); link.outcome = 'needs_investigation';
    doc.sourceRecords[1].processing = { ...doc.sourceRecords[1].processing, status: 'edited' }; doc.notifications[0].items.pop();
    sent.length = 0; await store.save(doc);
    assert.ok(!sent.some(s => /^SELECT \* FROM/.test(s)), 'with a current snapshot the save reads no table again');
    assert.equal(canonical(await store.load()), canonical(doc), 'the stored state equals the document');

    // The snapshot never hides a conflict or an append-only change.
    await store.load({ shared: true });
    const stale = await store.load(); const newer = await other.load(); await other.save(newer);
    await assert.rejects(store.save(stale), e => e.code === 'conflict');
    await store.load({ shared: true });
    const tampered = await store.load(); tampered.auditEvents[0] = { ...tampered.auditEvents[0], actor: 'someone else' };
    await assert.rejects(store.save(tampered), e => e.code === 'append_only_violation');
    const dropped = await store.load(); dropped.auditEvents.pop();
    await assert.rejects(store.save(dropped), e => e.code === 'append_only_violation');
    assert.equal(canonical(await store.load()), canonical(await other.load()), 'refused saves left nothing behind');

    // An unreachable database is an error for a read, never a reason to serve the snapshot already held.
    await store.load({ shared: true });
    const reachable = store.pool.query; store.pool.query = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
    try { await assert.rejects(store.load({ shared: true }), /ECONNREFUSED/); } finally { store.pool.query = reachable; }

    // Through the app: a repeated read sends one statement; a decision is visible to the very next read.
    const app = createApp({ store });
    assert.equal((await call(app, { url: '/api/v1/dashboard/summary' })).status, 200);
    sent.length = 0; assert.equal((await call(app, { url: '/api/v1/dashboard/summary' })).status, 200); assert.equal(sent.length, 1);
    const open = (await store.load()).identityLinks.find(l => l.outcome === 'candidate_for_review');
    const statusOf = async () => (await call(app, { url: '/api/v1/matches' })).json.data.find(e => e.id === open.id)?.status;
    assert.equal(await statusOf(), 'needs_review');
    assert.equal((await call(app, { method: 'POST', url: `/api/v1/matches/${open.id}/decision`, json: { decision: 'needs_more_evidence', note: 'Snapshot test.' } })).status, 200);
    assert.equal(await statusOf(), 'needs_more_evidence', 'the decision is in the next read');
  } finally { Client.prototype.query = query; await store.close(); await other.close(); }
});
