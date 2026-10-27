require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createApp } = require('../server');
const { buildDemoDataset } = require('../src/demo-data');
const { canonical } = require('../src/receipts');
const { mockAdapter } = require('../src/integrations');

// The PostgreSQL store hands every read the same snapshot (src/pg-store.js), so no read route may change the data
// it is given. Here one document is served to every request, and its content must be the same after each read.
function harness(doc) {
  const saves = [];
  const app = createApp({ store: { kind: 'probe', readOnly: false, load: async () => doc, save: async d => { saves.push(d); } }, limits: { windowMs: 60000, max: 1e6 }, integrations: mockAdapter() });
  const call = (method, url, json, role = 'regulator') => new Promise(resolve => {
    const req = Readable.from(json ? [JSON.stringify(json)] : []); req.method = method; req.url = url; req.headers = { host: 'localhost', 'x-demo-role': role, 'content-type': 'application/json' };
    const res = new EventEmitter(); let status = 200; const chunks = []; res.writeHead = s => { status = s; }; res.end = v => { if (v) chunks.push(v); resolve({ status, body: chunks.join('') }); };
    app.emit('request', req, res);
  });
  return { call, saves };
}

function readUrls(db) {
  const some = (list, k) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / k)) === 0);
  const records = some(db.sourceRecords, 20).map(r => r.id); const findings = some(db.findings, 15).map(f => f.id);
  const links = some(db.identityLinks || [], 10).map(l => l.id); const receipts = (db.decisionReceipts || []).map(r => r.receipt_id);
  return ['/api/v1/dashboard/summary', '/api/v1/findings', '/api/v1/findings?lifecycle=all', '/api/v1/findings?q=rao', '/api/v1/records', '/api/v1/records?q=meera', '/api/v1/graph', '/api/v1/graph?institution=RCA',
    '/api/v1/matches', '/api/v1/audit?limit=200', '/api/v1/notifications', '/api/v1/automation', '/api/v1/imports', '/api/v1/corrections?status=all', '/api/v1/reports/findings.csv?lifecycle=all',
    ...records.flatMap(id => [`/api/v1/identities/${id}/history`, `/api/v1/identities/${id}/history?as_of=2026-10-21T00:00:00.000Z`, `/api/v1/records/${id}`, `/api/v1/profiles/${id}`, `/api/v1/records/${id}/lineage`, `/api/v1/records/${id}/verification`]),
    ...findings.flatMap(id => [`/api/v1/findings/${id}`, `/api/v1/findings/${id}/explanation`, `/api/v1/evidence/checklist?finding=${id}`]),
    ...links.flatMap(id => [`/api/v1/matches/${id}`, `/api/v1/evidence/checklist?link=${id}`]), ...receipts.map(id => `/api/v1/receipts/${id}`), '/api/v1/findings/none', '/api/v1/records/none', '/api/v1/receipts/none'];
}

test('no read route changes the data it reads, for either scope, before and after decisions', async () => {
  const doc = buildDemoDataset(); const { call, saves } = harness(doc);
  const probe = async label => {
    const before = canonical(doc); let served = 0;
    for (const role of ['regulator', 'institution']) for (const url of readUrls(doc)) {
      const { status } = await call('GET', url, null, role);
      assert.ok(status === 200 || status === 404, `${label}: ${role} ${url} answered ${status}`); if (status === 200) served++;
      assert.equal(canonical(doc), before, `${label}: ${role} GET ${url} changed the data it read`);
    }
    assert.equal(saves.length, savedBefore, `${label}: a read saved data`);
    return served;
  };
  let savedBefore = 0;
  assert.ok(await probe('seeded data') > 100);
  // Decisions add receipts, audit events and consent; the reads are probed again over that state.
  const finding = doc.findings.find(f => f.review_status === 'pending' && f.lifecycle_status === 'current');
  const link = (doc.identityLinks || []).find(l => l.outcome === 'candidate_for_review');
  const record = doc.sourceRecords[0]; // sampled by readUrls, so its verification runs through the mock adapter with consent
  assert.ok(finding && link && record, 'the demo data has an open finding, a candidate pair and a record');
  assert.equal((await call('POST', `/api/v1/findings/${finding.id}/decision`, { outcome: 'awaiting_verification', note: 'Waiting for the corrected file.' })).status, 200);
  assert.equal((await call('POST', `/api/v1/matches/${link.id}/decision`, { decision: 'needs_more_evidence', note: 'Read-route probe.' })).status, 200);
  assert.equal((await call('POST', `/api/v1/records/${record.id}/consent`, { status: 'granted', reference: 'Signed consent form, admission file' })).status, 201);
  savedBefore = saves.length; assert.ok(savedBefore >= 3);
  assert.ok((doc.decisionReceipts || []).length >= 1, 'a decision issued a receipt');
  assert.ok(await probe('after decisions') > 100);
});
