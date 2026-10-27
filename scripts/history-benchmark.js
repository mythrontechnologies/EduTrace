// Student-history size measurements (npm run benchmark:history -- [--counts 25,100,250] [--out file]).
// One synthetic student is re-sent K times through the real import pipeline (alternating corrections and unchanged
// copies), then GET /api/v1/identities/:id/history is timed against the real development store.
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { performance } = require('node:perf_hooks');
const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const counts = (arg('--counts') || '25,100,250').split(',').map(Number);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edutrace-history-'));
process.env.EDUTRACE_DB_PATH = path.join(tmp, 'db.json');
const { buildDemoDataset } = require('../src/demo-data');
const { commitImport } = require('../src/pipeline');
const { saveDemo } = require('../src/seed');
const { createApp } = require('../server');
const { EventEmitter } = require('node:events'); const { Readable } = require('node:stream');
const app = createApp({ limits: { windowMs: 60000 } });
const get = url => new Promise(resolve => { const req = Readable.from([]); req.method = 'GET'; req.url = url; req.headers = { host: 'localhost', 'x-demo-role': 'regulator' }; const res = new EventEmitter(); const chunks = []; res.writeHead = () => {}; res.end = v => { if (v) chunks.push(v); resolve(chunks.join('')); }; app.emit('request', req, res); });
const HEADERS = ['source_reference', 'apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
(async () => {
  const results = [];
  for (const k of counts) {
    const db = buildDemoDataset(); let at = Date.parse('2026-10-25T00:00:00Z');
    const t0 = performance.now();
    for (let i = 0; i < k; i++) {
      const row = { source_reference: 'NITM-HIST-1', apaar_id: '', student_name: 'Synthetic Long History', date_of_birth: i % 2 ? '2004-01-01' : '2004-01-02', institution_code: 'NITM', programme: 'BA', academic_session: '2026-27', enrolment_status: 'Active' };
      commitImport(db, { parsed: { headers: HEADERS, rows: [row], row_numbers: [2] }, mapping: Object.fromEntries(HEADERS.map(h => [h, h])), batchInstitution: 'NITM', multiInstitution: false, filename: `history-${i}.csv`, at: new Date(at += 60000).toISOString() });
    }
    const buildMs = Math.round(performance.now() - t0);
    saveDemo(db);
    const id = db.sourceRecords.filter(r => r.source_reference === 'NITM-HIST-1').at(-1).id;
    const t1 = performance.now(); const body = await get(`/api/v1/identities/${id}/history`); const ms = Math.round((performance.now() - t1) * 10) / 10;
    const data = JSON.parse(body).data;
    // As of halfway through the resubmissions: the cluster is rebuilt from what was established by then.
    const asOf = new Date(Date.parse('2026-10-25T00:00:00Z') + Math.ceil(k / 2) * 60000).toISOString();
    const t2 = performance.now(); const pastBody = await get(`/api/v1/identities/${db.sourceRecords.find(r => r.source_reference === 'NITM-HIST-1').id}/history?as_of=${encodeURIComponent(asOf)}`); const asOfMs = Math.round((performance.now() - t2) * 10) / 10;
    const past = JSON.parse(pastBody).data;
    results.push({ resubmissions: k, versions: data.records?.length ?? null, timeline_events: data.timeline?.length ?? data.events?.length ?? null, response_kb: Math.round(Buffer.byteLength(body) / 1024), history_ms: ms, as_of_ms: asOfMs, as_of_versions: past.records?.length ?? null, build_ms: buildMs });
    console.log(`${k} resubmissions: ${results.at(-1).timeline_events} events, ${results.at(-1).response_kb} KB, history ${ms} ms, as of ${asOfMs} ms (${results.at(-1).as_of_versions} versions)`);
  }
  if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify({ generated_at: new Date().toISOString(), node: process.version, results }, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
})();
