require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createProvider } = require('../src/ai-provider');
const { assistFinding, explanationInput } = require('../src/assist');
const { buildDemoDataset } = require('../src/demo-data');
const { isCurrent } = require('../src/engine');
const { server, setProvider } = require('../server');
const { saveDemo } = require('../src/seed');

const KEY = 'sk-ant-test-secret-value-0000';
const reply = output => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 10, output_tokens: 10 } });
const explanation = { summary: 'Two records share an identifier but their dates of birth differ.', what_it_indicates: 'One record may carry an incorrect value.', what_it_does_not_establish: 'It does not establish which record is correct, and nothing has been verified.', suggested_next_step: 'Ask the institutions for an authoritative source record.' };
async function withFetchSpy(fn) { const original = globalThis.fetch; let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('network'); }; try { await fn(); } finally { globalThis.fetch = original; } return calls; }

test('a hosted provider stays off without the explicit opt-in, and makes no request', async () => {
  const off = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY } });
  assert.equal(off.status().configured, false); assert.match(off.status().reason, /EDUTRACE_AI_HOSTED_ENABLED=true/);
  const calls = await withFetchSpy(async () => {
    assert.equal((await off.run('finding_explanation', { rule_code: 'APAAR_MISSING' })).ok, false);
    assert.equal((await off.check()).ok, false);
  });
  assert.equal(calls, 0, 'no network request without the opt-in');
  const on = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, EDUTRACE_AI_HOSTED_ENABLED: 'true' } });
  assert.equal(on.status().configured, true); assert.equal(on.status().hosted_enabled, true);
  assert.equal(on.status().health.state, 'configured_untested', 'configuration alone never contacts the provider');
  assert.equal(createProvider({ env: {} }).status().provider, 'none', 'deterministic mode is the default');
});

test('provider credentials never appear in any status the browser can read', async () => {
  setProvider(createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, EDUTRACE_AI_HOSTED_ENABLED: 'true' }, transport: async () => reply(explanation) }));
  saveDemo(buildDemoDataset());
  const get = url => new Promise(resolve => {
    const req = Readable.from([]); req.method = 'GET'; req.url = url; req.headers = { host: 'localhost', 'x-demo-role': 'regulator' };
    const res = new EventEmitter(); const chunks = []; res.writeHead = () => {}; res.end = v => { if (v) chunks.push(v); resolve(chunks.join('')); };
    server.emit('request', req, res);
  });
  try {
    for (const url of ['/api/v1/ai/status', '/api/v1/automation', '/api/v1/runtime', '/api/v1/dashboard/summary']) assert.ok(!(await get(url)).includes(KEY), `${url} does not contain the key`);
  } finally { setProvider(createProvider({ env: {} })); }
  assert.ok(!JSON.stringify(createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, EDUTRACE_AI_HOSTED_ENABLED: 'true' } }).status()).includes(KEY));
});

test('concurrent model calls are bounded; extra requests get the deterministic result at once', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const provider = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, EDUTRACE_AI_HOSTED_ENABLED: 'true', EDUTRACE_AI_MAX_CONCURRENT: '1' }, transport: async () => { await gate; return reply(explanation); } });
  const input = { rule_code: 'IDENTIFIER_ATTRIBUTE_CONFLICT', rule_explanation: 'x', record_count: 2, evidence: [], agreeing_fields: [], conflicting_fields: [] };
  const first = provider.run('finding_explanation', input);
  assert.equal(provider.status().concurrency.in_flight, 1);
  const second = await provider.run('finding_explanation', input);
  assert.equal(second.ok, false); assert.equal(second.error.kind, 'local_concurrency_limit'); assert.match(second.reason, /deterministic output is shown instead/);
  release(); assert.equal((await first).ok, true);
  assert.equal(provider.status().concurrency.in_flight, 0);
  assert.equal((await provider.run('finding_explanation', input)).ok, true, 'capacity returns once the call finishes');
});

test('by default no name, date of birth or identifier is sent, and a model answer changes no authoritative data', async () => {
  const db = buildDemoDataset();
  const f = db.findings.find(x => isCurrent(x) && x.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  const records = f.evidence.map(id => db.sourceRecords.find(r => r.id === id));
  let sent = null;
  const provider = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, EDUTRACE_AI_HOSTED_ENABLED: 'true' }, transport: async body => { sent = JSON.stringify(body); return reply(explanation); } });
  const before = JSON.stringify({ findings: db.findings.map(({ assist, ...x }) => x), links: db.identityLinks, decisions: db.matchDecisions, records: db.sourceRecords, audit: db.auditEvents });
  const out = await assistFinding(db, f, provider);
  assert.equal(out.result.explanation.source, 'model');
  for (const r of records) for (const value of [r.student_name, r.date_of_birth, r.apaar_id, r.apaar_fingerprint].filter(Boolean)) assert.ok(!sent.includes(value), `the request does not contain ${value}`);
  assert.ok(!Object.keys(explanationInput(db, f)).some(k => /name|birth|apaar/.test(k)));
  const after = JSON.stringify({ findings: db.findings.map(({ assist, ...x }) => x), links: db.identityLinks, decisions: db.matchDecisions, records: db.sourceRecords, audit: db.auditEvents });
  assert.equal(after, before, 'only the advisory cache on the finding changed');
  assert.equal(provider.status().tasks.candidate_assessment.available, false, 'the name task stays off without explicit name sharing');
});
