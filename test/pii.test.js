require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createApp } = require('../server');
const { saveDemo, loadDemo } = require('../src/seed');
const { buildDemoDataset, createDemoStore } = require('../src/demo-data');
const { createProvider } = require('../src/ai-provider');
const { principalOf, hostedDemoAuthenticator } = require('../src/auth');
const { hashPassword } = require('../src/accounts');
const { REVEAL_ROUTES, maskPII } = require('../src/pii');

const call = (app, { method = 'GET', url, json, headers = {} }) => new Promise(resolve => {
  const req = Readable.from(json === undefined ? [] : [JSON.stringify(json)]); req.method = method; req.url = url; req.headers = { host: 'localhost', ...headers };
  const res = new EventEmitter(); const chunks = []; let status = 200; res.writeHead = c => { status = c; }; res.end = v => { if (v) chunks.push(v); resolve({ status, text: chunks.join('') }); };
  app.emit('request', req, res);
});
const as = roles => createApp({ auth: { kind: 'test', authenticate: () => principalOf({ name: 'Tester', subject: 'test', scope: 'all', roles, method: 'test' }) } });

// Every value that must never leave in clear: identifiers anywhere; names and dates of birth outside reveal views.
function secrets(db) {
  const ids = [...new Set(db.sourceRecords.map(r => r.apaar_id).filter(v => v && v.length >= 5))];
  const names = [...new Set(db.sourceRecords.map(r => r.student_name).filter(Boolean))];
  const dobs = [...new Set(db.sourceRecords.map(r => r.date_of_birth).filter(Boolean))];
  return { ids, names, dobs };
}
function routes(db) {
  const link = db.identityLinks.find(l => l.outcome === 'candidate_for_review'); const f = db.findings.find(x => x.lifecycle_status === 'current' && x.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  return ['/api/v1/dashboard/summary', '/api/v1/audit?limit=200', '/api/v1/imports', '/api/v1/automation', '/api/v1/matches', `/api/v1/matches/${link.id}`, '/api/v1/records?limit=200', '/api/v1/records/SRC-41', '/api/v1/records/SRC-1/lineage',
    '/api/v1/identities/SRC-1/history', '/api/v1/profiles/SRC-41', '/api/v1/corrections?status=all', '/api/v1/notifications', '/api/v1/graph', '/api/v1/findings?lifecycle=all', `/api/v1/findings/${f.id}`, `/api/v1/findings/${f.id}/explanation`,
    `/api/v1/evidence/checklist?finding=${f.id}`, '/api/v1/records/SRC-3/verification', '/api/v1/integrations', '/api/v1/reports/findings.csv'];
}
const revealed = url => REVEAL_ROUTES.some(re => re.test(url.split('?')[0]));

test('no raw identifier leaves the server on any route, for any role, including raw source values', async () => {
  saveDemo(buildDemoDataset()); const db = loadDemo(); const { ids } = secrets(db);
  for (const roles of [['reviewer'], ['auditor'], ['reviewer', 'auditor', 'institution_admin', 'platform_admin']]) {
    const app = as(roles);
    for (const url of routes(db)) {
      const res = await call(app, { url });
      assert.ok([200, 403].includes(res.status), `${roles} ${url} ${res.status}`);
      for (const id of ids) assert.ok(!res.text.includes(id), `${roles} ${url} exposes an identifier`);
    }
  }
  const detail = JSON.parse((await call(as(['reviewer']), { url: '/api/v1/records/SRC-41' })).text).data;
  assert.match(detail.original.apaar_id, /^•••• •••• /, 'the raw value as recorded is masked too');
});

test('names and dates of birth are masked everywhere except record-level views for roles with pii.read', async () => {
  saveDemo(buildDemoDataset()); const db = loadDemo(); const { names, dobs } = secrets(db);
  const reviewer = as(['reviewer']); const auditor = as(['auditor']);
  let revealedSomething = false;
  for (const url of routes(db)) {
    const r = (await call(reviewer, { url })).text; const a = (await call(auditor, { url })).text;
    const leaks = text => [...names.filter(n => text.includes(`"${n}"`)), ...dobs.filter(d => text.includes(`"${d}"`))];
    assert.deepEqual(leaks(a), [], `auditor: ${url} is masked`);
    if (revealed(url)) revealedSomething = revealedSomething || leaks(r).length > 0;
    else assert.deepEqual(leaks(r), [], `reviewer: ${url} is a list or overview and is masked`);
  }
  assert.ok(revealedSomething, 'record-level views do show full values to a reviewer');
  const graph = JSON.parse((await call(reviewer, { url: '/api/v1/graph' })).text).data;
  assert.ok(graph.nodes.filter(n => n.type === 'record').every(n => n.detail.student_name.includes('•') && !names.some(x => n.label.includes(x))), 'graph names and labels are masked');
  const audit = JSON.parse((await call(reviewer, { url: '/api/v1/audit?limit=200' })).text).data;
  assert.ok(audit.flatMap(e => e.record_context).every(c => c.student_name.includes('•')));
});

test('hosted Demo has only records.read and masks PII on every exercised public record response', async () => {
  const db = buildDemoDataset();
  const auth = hostedDemoAuthenticator({ passwordHash: hashPassword('test-only-hosted-viewer-password-2026'), secureCookies: false });
  const login = auth.login({ headers: {}, socket: { remoteAddress: 'test-pii' } }, { password: 'test-only-hosted-viewer-password-2026' });
  const cookie = login.setCookie.split(';')[0];
  const app = createApp({ mode: 'demo', store: createDemoStore(), auth, getProvider: () => createProvider({ env: {}, disabled: 'disabled in hosted Demo' }) });
  const viewer = auth.authenticate({ method: 'GET', headers: { cookie,
    'x-demo-role': 'regulator', 'x-demo-institution': 'RCA', 'x-edutrace-mode': 'development',
    'x-http-method-override': 'GET', authorization: 'Bearer admin'
  } });
  assert.equal(viewer.role, 'hosted_demo_viewer');
  assert.deepEqual(viewer.roles, ['hosted_demo_viewer']);
  assert.deepEqual(viewer.capabilities, ['records.read']);
  assert.equal(viewer.authenticated, true);

  const link = db.identityLinks.find(item => item.outcome === 'candidate_for_review');
  const finding = db.findings.find(item => item.lifecycle_status === 'current' && item.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  const urls = [
    '/api/v1/dashboard/summary', '/api/v1/imports', '/api/v1/automation', '/api/v1/matches', `/api/v1/matches/${link.id}`,
    '/api/v1/records?limit=200', '/api/v1/records?limit=200&offset=200', '/api/v1/records/SRC-41', '/api/v1/records/SRC-1/lineage', '/api/v1/identities/SRC-1/history',
    '/api/v1/profiles/SRC-41', '/api/v1/corrections?status=all', '/api/v1/notifications', '/api/v1/graph',
    '/api/v1/findings?lifecycle=all', `/api/v1/findings/${finding.id}`, `/api/v1/findings/${finding.id}/explanation`,
    '/api/v1/records/SRC-3/verification', `/api/v1/evidence/checklist?finding=${finding.id}`
  ];
  const spoof = { cookie, 'x-demo-role': 'regulator', 'x-demo-institution': 'RCA', 'x-edutrace-mode': 'development', 'x-http-method-override': 'GET', authorization: 'Bearer admin', 'x-hosted-demo-csrf': 'ignored' };
  const { ids, names, dobs } = secrets(db);
  for (const url of urls) {
    const response = await call(app, { url, headers: spoof });
    assert.equal(response.status, 200, `${url} remains available to the walkthrough`);
    for (const value of [...ids, ...names, ...dobs]) assert.ok(!response.text.includes(JSON.stringify(value)), `${url} contains only masked personal fields`);
  }
  for (const code of ['NITM', 'RCA', 'SVU']) {
    const response = await call(app, { url: `/api/v1/records?institution=${code}`, headers: spoof });
    assert.equal(response.status, 200);
    assert.ok(JSON.parse(response.text).data.length > 0, `public walkthrough can read synthetic ${code} records`);
  }
  for (const url of ['/api/v1/audit?limit=200', '/api/v1/reports/findings.csv', '/api/v1/ai/status']) {
    const response = await call(app, { url, headers: spoof });
    assert.equal(response.status, 403, `${url} requires a capability the public viewer does not have`);
  }
});

test('simulations, consent, decisions and receipts are masked, and so is the import preview', async () => {
  saveDemo(buildDemoDataset()); const db = loadDemo(); const { ids, names, dobs } = secrets(db);
  const app = as(['reviewer', 'auditor', 'institution_admin', 'platform_admin']);
  const sim = await call(app, { method: 'POST', url: '/api/v1/simulations/correction', json: { record_id: 'SRC-41', field: 'student_name', value: 'Student NITM 5', evidence: { kind: 'institution_record', reference: 'Registrar letter' } } });
  assert.equal(sim.status, 200);
  for (const v of [...ids, ...names, ...dobs]) assert.ok(!sim.text.includes(`"${v}"`) && !sim.text.includes(`: ${v}`), `simulation leaks ${v}`);
  const staged = JSON.parse(sim.text).data.staged; assert.match(staged.before, /•/); assert.match(staged.after, /•/);
  const link = db.identityLinks.find(l => l.outcome === 'candidate_for_review');
  const decided = JSON.parse((await call(app, { method: 'POST', url: `/api/v1/matches/${link.id}/decision`, json: { decision: 'needs_more_evidence', note: 'Waiting.' } })).text).data;
  const receipt = await call(app, { url: `/api/v1/receipts/${decided.decision.receipt_id}` });
  for (const v of [...ids, ...names, ...dobs]) assert.ok(!receipt.text.includes(v), `receipt leaks ${v}`);
  const consent = await call(app, { method: 'POST', url: '/api/v1/records/SRC-8/consent', json: { status: 'granted', reference: 'Signed form' } });
  for (const v of ids) assert.ok(!consent.text.includes(v));
  const csv = 'apaar_id,student_name,date_of_birth,institution_code,programme,academic_session,enrolment_status\n812345678901,Asha Rao,14/09/2004,NITM,BA,2026-27,Active';
  const preview = JSON.parse((await call(app, { method: 'POST', url: '/api/v1/imports/preview', json: { filename: 'p.csv', csv, institution_code: 'NITM' } })).text).data;
  assert.equal(preview.mapping.student_name, 'student_name', 'column mappings are configuration, not personal data');
  assert.ok(!JSON.stringify(preview).includes('812345678901') && !JSON.stringify(preview).includes('Asha Rao') && !JSON.stringify(preview).includes('14/09/2004'));
  assert.equal(preview.header_samples.date_of_birth, '••/••/2004');
});

test('the masking rules themselves: identifiers always, names to initials, dates of birth to the year', () => {
  const out = maskPII({ student_name: 'Asha Rao', date_of_birth: '2004-09-14', apaar_id: '812345678901', original: { apaar_id: '8123-4567-8901', student_name: ' Asha  Rao ', date_of_birth: '14/09/2004' }, fields: [{ key: 'student_name', reference: { value: 'Asha Rao', source: { original_value: 'ASHA RAO' } } }], changes: [{ field: 'date_of_birth', from: '2004-09-14', to: '2004-09-15' }], institution: { name: 'Northbridge' } });
  assert.equal(out.student_name, 'A••• R••'); assert.equal(out.date_of_birth, '2004-••-••'); assert.equal(out.apaar_id, '•••• •••• 8901');
  assert.equal(out.original.apaar_id, '•••• •••• 8901'); assert.equal(out.original.date_of_birth, '••/••/2004');
  assert.equal(out.fields[0].reference.value, 'A••• R••'); assert.equal(out.fields[0].reference.source.original_value, 'A••• R••');
  assert.deepEqual([out.changes[0].from, out.changes[0].to], ['2004-••-••', '2004-••-••']);
  assert.equal(out.institution.name, 'Northbridge', 'other names are untouched');
  const shown = maskPII({ student_name: 'Asha Rao', apaar_id: '812345678901' }, { reveal: true });
  assert.equal(shown.student_name, 'Asha Rao'); assert.equal(shown.apaar_id, '•••• •••• 8901', 'identifiers stay masked even when names are shown');
});
