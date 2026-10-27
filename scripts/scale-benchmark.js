// Scale measurements on deterministic synthetic data
// (npm run benchmark:scale -- [--sizes 1000,5000] [--repeat 3] [--store json|postgres] [--out file]).
// Each size is built in memory, reconciled by the real pipeline, written to a temporary file and served by the real
// development store (file read and JSON parse on every request). Nothing touches data/demo-db.json.
// --store postgres imports each size into a fresh database on a throwaway embedded PostgreSQL server
// (test-support/postgres.js) and serves the same requests from the PostgreSQL store. --repeat reports the median.
// With PostgreSQL, each route also reports the SQL statements and rows its last run sent and received.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const sizes = (arg('--sizes') || '1000,5000,10000,20000').split(',').map(Number).filter(n => n > 0);
const outFile = arg('--out');
const storeKind = arg('--store') || 'json';
const repeat = Math.max(1, Number(arg('--repeat') || 1));
if (!['json', 'postgres'].includes(storeKind)) throw new Error('--store is json or postgres');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edutrace-scale-'));
process.env.EDUTRACE_DB_PATH = path.join(tmp, 'db.json');
for (const k of Object.keys(process.env)) if (k.startsWith('EDUTRACE_AI_') || k === 'ANTHROPIC_API_KEY') delete process.env[k];

const { normaliseRecord } = require('../src/engine');
const { processAll } = require('../src/pipeline');
const { saveDemo } = require('../src/seed');
const { createApp } = require('../server');
const { createPostgresStore } = require('../src/pg-store');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const FIRST = ['Asha', 'Ravi', 'Meera', 'Kiran', 'Arjun', 'Divya', 'Farhan', 'Gauri', 'Harish', 'Ishita', 'Jaya', 'Karthik', 'Lakshmi', 'Manoj', 'Nisha', 'Omkar', 'Pooja', 'Rahul', 'Sneha', 'Tarun', 'Usha', 'Varun', 'Yamini', 'Zoya', 'Bhavna', 'Chetan', 'Deepak', 'Esha', 'Gopal', 'Hema'];
const LAST = ['Rao', 'Iyer', 'Das', 'Bose', 'Nair', 'Menon', 'Khan', 'Patel', 'Sharma', 'Verma', 'Reddy', 'Gupta', 'Singh', 'Joshi', 'Pillai', 'Kulkarni', 'Mehta', 'Chopra', 'Ghosh', 'Saxena', 'Bhat', 'Kapoor', 'Mishra', 'Yadav', 'Naidu'];
const INSTITUTIONS = ['NITM', 'RCA', 'SVU', 'KIT', 'MDU'].map(code => ({ code, name: `Synthetic ${code}` }));
const PROGRAMMES = ['BTECH CSE', 'BBA', 'BSC DATA', 'BA', 'BCOM'];

// Deterministic generator: same size, same data. Roughly 2% missing and 1% malformed identifiers, 1% resubmissions
// (same student and identifier at another institution), 0.5% conflicts and 1% name and date-of-birth lookalikes.
function dataset(n) {
  let s = 1; const rand = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const records = [];
  for (let i = 1; i <= n; i++) {
    const inst = INSTITUTIONS[i % INSTITUTIONS.length].code; const programme = PROGRAMMES[Math.floor(rand() * PROGRAMMES.length)];
    const day = new Date(Date.UTC(2001, 0, 1) + Math.floor(rand() * 1826) * 86400000).toISOString().slice(0, 10);
    let apaar = String(800000000000 + i); let name = `${FIRST[Math.floor(rand() * FIRST.length)]} ${LAST[Math.floor(rand() * LAST.length)]} ${i}`; let dob = day;
    const roll = rand();
    if (roll < 0.02) apaar = ''; else if (roll < 0.03) apaar = `X${i}`;
    else if (roll < 0.04 && records.length) { const prev = records[Math.floor(rand() * records.length)]; apaar = prev.apaar_id; name = prev.student_name; dob = prev.date_of_birth; }
    else if (roll < 0.045 && records.length) { const prev = records[Math.floor(rand() * records.length)]; apaar = prev.apaar_id; name = prev.student_name; }
    else if (roll < 0.055 && records.length) { const prev = records[Math.floor(rand() * records.length)]; apaar = ''; name = prev.student_name; dob = prev.date_of_birth; }
    records.push({ apaar_id: apaar, student_name: name, date_of_birth: dob, institution_code: inst, programme, academic_session: '2026-27', admission_year: '2026', enrolment_status: 'Active' });
  }
  const sourceRecords = records.map((row, i) => ({ id: `SRC-${i + 1}`, source_file: `${row.institution_code.toLowerCase()}-synthetic.csv`, source_row: i + 2, import_id: `IMP-${row.institution_code}-01`, imported_at: '2026-10-20T09:00:00.000Z', ...normaliseRecord(row) }));
  return { version: 1, institutions: INSTITUTIONS, importBatches: INSTITUTIONS.map(x => ({ id: `IMP-${x.code}-01`, institution_code: x.code, source_file: `${x.code.toLowerCase()}-synthetic.csv`, imported: 0, rejected: 0, created_at: '2026-10-20T09:00:00.000Z' })), sourceRecords, capacityRules: [{ institution_code: 'NITM', programme: 'BTECH CSE', academic_session: '2026-27', permitted_capacity: Math.floor(n / 30) }], findings: [], auditEvents: [] };
}

let app = createApp({ limits: { windowMs: 60000 } });
function request(method, url, json, role = 'regulator') {
  return new Promise(resolve => {
    const req = Readable.from(json ? [JSON.stringify(json)] : []); req.method = method; req.url = url; req.headers = { host: 'localhost', 'x-demo-role': role, 'content-type': 'application/json' };
    const res = new EventEmitter(); let status = 200; const chunks = []; res.writeHead = c => { status = c; }; res.end = v => { if (v) chunks.push(v); resolve({ status, bytes: Buffer.byteLength(chunks.join('')), body: chunks.join('') }); };
    app.emit('request', req, res);
  });
}
const ms = t => Math.round(t * 10) / 10;
// Every statement the PostgreSQL driver runs is counted, with the rows it returns (only used with --store postgres).
const sql = { queries: 0, rows: 0 };
if (storeKind === 'postgres') {
  const { Client } = require('pg'); const query = Client.prototype.query;
  const count = r => { sql.queries++; for (const x of [].concat(r)) sql.rows += x?.rows?.length || 0; };
  Client.prototype.query = function (...a) {
    const cb = typeof a.at(-1) === 'function' ? a.pop() : null;
    if (cb) return query.call(this, ...a, (e, r) => { if (!e) count(r); cb(e, r); });
    return query.apply(this, a).then(r => { count(r); return r; });
  };
}
async function timed(method, url, json, role) { sql.queries = 0; sql.rows = 0; const t = performance.now(); const r = await request(method, url, json, role); return { ms: ms(performance.now() - t), status: r.status, bytes: r.bytes, body: r.body, queries: sql.queries, rows: sql.rows }; }
const median = list => [...list].sort((a, b) => a - b)[Math.floor((list.length - 1) / 2)];
// The same request `repeat` times; the median time is reported (status and size from the last run).
async function measured(method, url, json, role) { const runs = []; for (let i = 0; i < repeat; i++) runs.push(await timed(method, typeof url === 'function' ? url(i) : url, json, role)); return { ...runs.at(-1), ms: median(runs.map(r => r.ms)) }; }

(async () => {
  const results = [];
  let pg = null;
  if (storeKind === 'postgres') pg = await require('../test-support/postgres').startPostgres();
  for (const n of sizes) {
    const db = dataset(n);
    let t = performance.now(); processAll(db, { at: '2026-10-20T09:00:00.000Z', reason: 'benchmark', origin: 'seed' }); const reconcileMs = ms(performance.now() - t);
    const extra = {}; let store = null; let saveMs; let loadMs; let bytes = 0;
    if (pg) {
      // A fresh database per size, migrated with the real schema; the reconciled document is imported once.
      const name = `edutrace_bench_${n}`; const { Pool } = require('pg'); const admin = new Pool({ connectionString: pg.url, max: 1 });
      await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
      store = createPostgresStore({ url: pg.url.replace(/\/[^/]+$/, `/${name}`) });
      await store.pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'postgres', 'schema.sql'), 'utf8'));
      t = performance.now(); await store.importInto(db); saveMs = ms(performance.now() - t);
      const loads = []; for (let i = 0; i < repeat; i++) { t = performance.now(); await store.load(); loads.push(ms(performance.now() - t)); } loadMs = median(loads);
      extra.db_mb = Math.round(Number((await store.pool.query('SELECT pg_database_size(current_database()) AS b')).rows[0].b) / 1048576);
      app = createApp({ store, limits: { windowMs: 60000 } });
    } else {
      t = performance.now(); saveDemo(db); saveMs = ms(performance.now() - t);
      bytes = fs.statSync(process.env.EDUTRACE_DB_PATH).size;
      t = performance.now(); JSON.parse(fs.readFileSync(process.env.EDUTRACE_DB_PATH, 'utf8')); loadMs = ms(performance.now() - t);
    }
    const someRecord = db.sourceRecords[Math.floor(n / 2)].id;
    const nitmRecord = db.sourceRecords.slice(Math.floor(n / 2)).find(r => r.institution_code === 'NITM').id;
    const routes = {};
    for (const [label, url, role] of [['summary', '/api/v1/dashboard/summary'], ['findings', '/api/v1/findings'], ['findings search', '/api/v1/findings?q=rao'], ['records search', '/api/v1/records?q=meera'], ['graph', '/api/v1/graph'], ['matches', '/api/v1/matches'], ['student history', `/api/v1/identities/${someRecord}/history`], ['student history as of', `/api/v1/identities/${someRecord}/history?as_of=2026-10-21T00:00:00.000Z`], ['audit', '/api/v1/audit?limit=200'],
      ['institution summary', '/api/v1/dashboard/summary', 'institution'], ['institution findings', '/api/v1/findings', 'institution'], ['institution student history', `/api/v1/identities/${nitmRecord}/history`, 'institution']]) {
      const r = await measured('GET', url, undefined, role); routes[label] = { ms: r.ms, status: r.status, kb: Math.round(r.bytes / 1024), ...(pg ? { sql_queries: r.queries, sql_rows: r.rows } : {}) };
    }
    const sim = await measured('POST', '/api/v1/simulations/correction', { record_id: someRecord, field: 'enrolment_status', value: 'transferred', evidence: { kind: 'institution_record', reference: 'Benchmark' } });
    // One reviewer decision per run, each on a different open candidate pair: a full load, decision and save.
    const open = db.identityLinks.filter(l => l.outcome === 'candidate_for_review').map(l => l.id);
    const decision = open.length >= repeat ? await measured('POST', i => `/api/v1/matches/${open[i]}/decision`, { decision: 'needs_more_evidence', note: 'Benchmark decision.' }) : null;
    // The interactive pattern: the reviewer reads the queue, then decides. Only the decision is timed.
    let afterRead = null;
    if (open.length >= 2 * repeat) { const runs = []; for (let i = 0; i < repeat; i++) { await request('GET', '/api/v1/matches'); runs.push(await timed('POST', `/api/v1/matches/${open[repeat + i]}/decision`, { decision: 'needs_more_evidence', note: 'Benchmark decision after a read.' })); } afterRead = { ms: median(runs.map(r => r.ms)), status: runs.at(-1).status, ...(pg ? { sql_queries: runs.at(-1).queries, sql_rows: runs.at(-1).rows } : {}) }; }
    const graph = JSON.parse((await request('GET', '/api/v1/graph')).body).data;
    results.push({
      records: n, findings: db.findings.length, identity_links: db.identityLinks.length,
      reconcile_ms: reconcileMs, ...(pg ? { store: 'postgres', import_ms: saveMs, load_ms: loadMs, ...extra } : { file_kb: Math.round(bytes / 1024), save_ms: saveMs, parse_ms: loadMs }),
      routes, simulation: { ms: sim.ms, status: sim.status }, decision: decision && { ms: decision.ms, status: decision.status, ...(pg ? { sql_queries: decision.queries, sql_rows: decision.rows } : {}) }, decision_after_read: afterRead, graph_nodes: graph.nodes.length, graph_edges: graph.edges.length,
      heap_mb: Math.round(process.memoryUsage().heapUsed / 1048576)
    });
    console.log(`${n} records: reconcile ${reconcileMs} ms, ${pg ? `import ${saveMs} ms, load ${loadMs} ms` : `file ${Math.round(bytes / 1024)} KB, parse ${loadMs} ms`}, summary ${routes.summary.ms} ms, findings ${routes.findings.ms} ms, graph ${routes.graph.ms} ms, history ${routes['student history'].ms} ms, simulation ${sim.ms} ms, decision ${decision?.ms} ms (${decision?.status}), after a read ${afterRead?.ms} ms`);
    if (store) await store.close();
  }
  if (pg) await pg.stop();
  const method = pg
    ? `In-process requests against the PostgreSQL store (PostgreSQL 17 embedded, same machine). A request that may write loads the document; a read loads it only when the stored version has changed since the last load (src/pg-store.js), otherwise it sends one version query. Median of ${repeat} run(s) per route; sql_queries and sql_rows are from the last run.`
    : `In-process requests against the real development store (file read and JSON parse per request), ${repeat === 1 ? 'single run per size, no warm-up beyond the first request' : `median of ${repeat} runs per route`}.`;
  const report = { generated_at: new Date().toISOString(), node: process.version, platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, method, results, dataset_sha256: Object.fromEntries(sizes.map(n => [n, crypto.createHash('sha256').update(JSON.stringify(dataset(n).sourceRecords.map(r => r.id + r.apaar_id))).digest('hex').slice(0, 16)])) };
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch(error => { console.error(error); process.exit(1); });
