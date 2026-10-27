const { dir, dbPath } = require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server } = require('../server');
const { saveDemo, loadDemo } = require('../src/seed');
const { buildDemoDataset } = require('../src/demo-data');
const { isCurrent } = require('../src/engine');
const { TABLES, toRelational, fromRelational, validateRelational, compareDocuments, toSql } = require('../src/relational');
const { canonical } = require('../src/receipts');

const ROOT = path.join(__dirname, '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'db', 'postgres', 'schema.sql'), 'utf8');
const call = ({ method = 'GET', url, json }) => new Promise(resolve => {
  const req = Readable.from(json === undefined ? [] : [JSON.stringify(json)]); req.method = method; req.url = url; req.headers = { host: 'localhost', 'x-demo-role': 'regulator' };
  const res = new EventEmitter(); const chunks = []; let status = 200; res.writeHead = c => { status = c; }; res.end = v => { if (v) chunks.push(v); resolve({ status, json: JSON.parse(chunks.join('')) }); };
  server.emit('request', req, res);
});
const roundTrip = db => { const t = toRelational(db); return { t, back: fromRelational(t), validation: validateRelational(t) }; };

test('every collection survives the round trip exactly, including decisions, receipts, corrections and absent collections', async () => {
  saveDemo(buildDemoDataset());
  const db = loadDemo();
  const link = db.identityLinks.find(l => l.outcome === 'candidate_for_review');
  assert.equal((await call({ method: 'POST', url: `/api/v1/matches/${link.id}/decision`, json: { decision: 'needs_more_evidence', note: "O'Brien's file — \"quoted\" \\ backslash" } })).status, 200);
  const f = loadDemo().findings.find(x => isCurrent(x) && x.review_status === 'pending');
  assert.equal((await call({ method: 'POST', url: `/api/v1/findings/${f.id}/decision`, json: { outcome: 'awaiting_verification', note: 'Waiting.' } })).status, 200);
  const c = loadDemo().correctionCandidates.find(x => x.status === 'pending');
  assert.equal((await call({ method: 'POST', url: `/api/v1/corrections/${c.id}/decision`, json: { decision: 'confirm', confirm: true, note: 'Confirmed.' } })).status, 200);
  const full = loadDemo();
  assert.ok(full.decisionReceipts.length === 3 && Object.keys(full.matchDecisions).length >= 3);
  for (const doc of [full, buildDemoDataset(), { version: 1, institutions: [], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] }]) {
    const { back, validation } = roundTrip(doc);
    assert.ok(validation.ok, validation.problems.join('; '));
    assert.equal(canonical(back), canonical(doc), 'the rebuilt document is identical');
    assert.ok(compareDocuments(doc, back).every(p => p.equal));
    assert.deepEqual(Object.keys(back).sort(), Object.keys(doc).sort(), 'collections absent in the source stay absent');
  }
  assert.deepEqual(fromRelational(toRelational(full)).sourceRecords.map(r => r.id), full.sourceRecords.map(r => r.id), 'record order, which reconciliation depends on, is kept');
});

test('source record versions are immutable rows: supersession and processing live in their own tables', () => {
  const { t } = roundTrip(buildDemoDataset());
  for (const r of t.source_records) { assert.equal(r.doc.processing, undefined); assert.equal(r.doc.superseded_by, undefined); assert.equal(r.doc.superseded_at, undefined); }
  assert.ok(t.record_supersessions.length >= 1); assert.equal(t.record_processing.length, t.source_records.length);
  for (const table of ['source_records', 'audit_events', 'lineage_events', 'decision_receipts']) assert.match(SCHEMA, new RegExp(`CREATE TRIGGER ${table}_append_only BEFORE UPDATE OR DELETE ON ${table}`));
});

test('validation catches broken keys, references, required values and timestamps', () => {
  const db = buildDemoDataset();
  const broken = structuredClone(db);
  broken.findings[0].evidence.push('SRC-missing');
  broken.sourceRecords.push({ ...broken.sourceRecords[0] });
  broken.auditEvents[0].at = 'yesterday';
  broken.sourceRecords[1].institution_code = 'XYZ';
  broken.correctionCandidates[0].later = 'SRC-gone';
  const v = validateRelational(toRelational(broken));
  assert.equal(v.ok, false);
  for (const pattern of [/finding_evidence: record_id SRC-missing/, /source_records: duplicate primary key/, /audit_events .*: at is not a timestamp/, /institution_code XYZ has no institutions row/, /correction_candidates: later SRC-gone/]) assert.ok(v.problems.some(p => pattern.test(p)), String(pattern));
});

test('the SQL is deterministic, escapes values and matches the schema\'s tables and columns', () => {
  const db = buildDemoDataset(); db.institutions[0].name = "St. Mary's College \\ 'quoted'";
  const sqlA = toSql(toRelational(db)); const sqlB = toSql(toRelational(structuredClone(db)));
  assert.equal(crypto.createHash('sha256').update(sqlA).digest('hex'), crypto.createHash('sha256').update(sqlB).digest('hex'), 'repeatable');
  assert.ok(sqlA.includes("'St. Mary''s College \\ ''quoted'''"), 'single quotes are doubled; backslashes need no escaping with standard strings');
  assert.match(sqlA, /^-- Generated[\s\S]*\nBEGIN;\n[\s\S]*\nCOMMIT;\n$/);
  const t = toRelational(db);
  for (const table of Object.keys(TABLES)) {
    const block = SCHEMA.match(new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\);`));
    assert.ok(block, `schema.sql defines ${table}`);
    for (const column of Object.keys(t[table][0] || {})) assert.match(block[1], new RegExp(`(^|[\\s(,])${column} `), `${table}.${column} exists in schema.sql`);
  }
});

test('the rehearsal script works on a verified copy, leaves the source unchanged and refuses to overwrite', () => {
  saveDemo(buildDemoDataset());
  const before = crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex');
  const out = fs.mkdtempSync(path.join(dir, 'migration-'));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['scripts/migrate-json-to-postgres.js', '--source', dbPath, '--out', out], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.ok, true); assert.equal(report.applied_to_database, false); assert.equal(report.source.sha256, before); assert.equal(report.source.unchanged_after_run, true);
  assert.ok(report.parity.every(p => p.equal)); assert.ok(fs.existsSync(path.join(out, 'migration.sql')));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'), before);
  const again = spawnSync(process.execPath, ['scripts/migrate-json-to-postgres.js', '--source', dbPath, '--out', out], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(again.status, 2); assert.match(again.stderr, /not empty; nothing was written/);
});
