require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server, setProvider } = require('../server');
const { resetDemo, loadDemo } = require('../src/seed');
const { isCurrent } = require('../src/engine');
const { createProvider } = require('../src/ai-provider');
const { assistFinding, cacheKey, explanationInput } = require('../src/assist');
const { suggestMapping } = require('../src/pipeline');
const { buildEvaluationState } = require('../src/evaluation');
const { SCHEMA_CASES, parsedCase, runSchemaComparison, runIdentityComparison } = require('../src/ai-evaluation');

/* Every model call in this file goes to a stub transport; nothing leaves the process. */
const env = (extra = {}) => ({ EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test', ...extra });
const reply = output => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 10, output_tokens: 10 } });
const explanation = { summary: 'The cited records need review.', what_it_indicates: 'A value may need correction at source.', what_it_does_not_establish: 'It does not establish wrongdoing, and nothing has been verified.', suggested_next_step: 'Ask the institution for its source record.' };
function counting(output = explanation, extra = {}) {
  const calls = { n: 0 };
  return { calls, provider: createProvider({ env: env(extra), transport: async () => { calls.n++; return reply(typeof output === 'function' ? output() : output); } }) };
}
const failing = () => createProvider({ env: env(), sleep: async () => {}, transport: async () => ({ status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }, retry_after: null, raw_is_json: true }) });

function call({ method = 'GET', url, headers = {}, json }) {
  return new Promise(resolve => {
    const request = Readable.from(json === undefined ? [] : [JSON.stringify(json)]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let responseHeaders = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; responseHeaders = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, text, json: responseHeaders['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    server.emit('request', request, response);
  });
}

test('a cached explanation is reused only while evidence, rule, template and model are unchanged', async () => {
  const { db } = buildEvaluationState();
  const f = db.findings.find(x => isCurrent(x) && x.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  const { calls, provider } = counting();
  const first = await assistFinding(db, f, provider);
  assert.equal(first.result.explanation.source, 'model'); assert.equal(first.changed, true); assert.equal(calls.n, 1);
  assert.equal(first.result.explanation.cache_key, undefined, 'the cache key is not returned');
  const second = await assistFinding(db, f, provider);
  assert.equal(second.result.explanation.cached, true); assert.equal(calls.n, 1);

  // Source-record content changed: the stored explanation is stale and is regenerated.
  db.sourceRecords.find(r => r.id === f.evidence[0]).programme = 'BTECH ECE';
  const third = await assistFinding(db, f, provider);
  assert.equal(calls.n, 2); assert.equal(third.result.explanation.replaced_stale, true);

  // Rule version and model are part of the key.
  const input = explanationInput(db, f);
  const key = cacheKey(db, f, 'finding_explanation', input, 'claude-opus-5-5');
  assert.notEqual(cacheKey(db, { ...f, rule_version: 'v-next' }, 'finding_explanation', explanationInput(db, { ...f, rule_version: 'v-next' }), 'claude-opus-5-5'), key);
  assert.notEqual(cacheKey(db, f, 'finding_explanation', input, 'claude-haiku-5-5'), key);
  const haiku = counting(explanation, { EDUTRACE_AI_MODEL: 'claude-haiku-5-5' });
  await assistFinding(db, f, haiku.provider);
  assert.equal(haiku.calls.n, 1, 'a different model regenerates');

  // Evidence changes while the provider is unavailable: the stale text is withheld, never shown as current.
  db.sourceRecords.find(r => r.id === f.evidence[1]).enrolment_status = 'withdrawn';
  const withheld = await assistFinding(db, f, failing());
  assert.equal(withheld.result.explanation.source, 'deterministic');
  assert.ok(withheld.result.explanation.stale_model_explanation_withheld);
  assert.equal(f.assist.explanation, undefined);
  assert.equal(withheld.result.explanation.summary, f.explanation);
});

test('the explanation input is the persisted finding and its real evidence, without names, identifiers or dates of birth', () => {
  const { db } = buildEvaluationState();
  const f = db.findings.find(x => isCurrent(x) && x.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  const input = explanationInput(db, f);
  assert.equal(input.record_count, f.evidence.length);
  assert.deepEqual(input.evidence.map(e => e.source_row), f.evidence.map(id => db.sourceRecords.find(r => r.id === id).source_row));
  assert.equal(input.rule_explanation, f.explanation);
  assert.equal(input.authoritative_verification, 'not available');
  const records = f.evidence.map(id => db.sourceRecords.find(r => r.id === id));
  const sent = JSON.stringify(input);
  for (const r of records) { assert.ok(!sent.includes(r.student_name)); assert.ok(!sent.includes(r.date_of_birth)); if (r.apaar_id) assert.ok(!sent.includes(r.apaar_id)); }
});

test('model output is advisory: it changes no finding, review status, decision or identity link', async () => {
  const { db } = buildEvaluationState();
  const candidate = db.findings.find(x => isCurrent(x) && x.rule_code === 'CANDIDATE_IDENTITY_MATCH');
  const before = JSON.stringify({ links: db.identityLinks, findings: db.findings.map(({ assist, ...f }) => f), records: db.sourceRecords });
  const multi = createProvider({ env: env({ EDUTRACE_AI_SHARE_NAMES: 'true' }), transport: async body => reply(/possible match/.test(body.system) ? { assessment: 'likely_same_person', name_relationship: 'identical', rationale: 'The names are identical and the dates of birth agree.' } : explanation) });
  const { result } = await assistFinding(db, candidate, multi);
  assert.equal(result.candidate_assessment.assessment, 'likely_same_person');
  assert.match(result.candidate_assessment.effect, /Advisory only/);
  assert.equal(JSON.stringify({ links: db.identityLinks, findings: db.findings.map(({ assist, ...f }) => f), records: db.sourceRecords }), before);
  assert.equal(candidate.review_status, 'pending');
  assert.ok(!db.identityLinks.some(l => l.outcome === 'auto_linked' && candidate.evidence.every(id => l.records.includes(id))));
});

test('model mapping suggestions are accepted only after validation', async () => {
  const parsed = parsedCase(SCHEMA_CASES.find(c => c.id === 'S04'));
  const provider = createProvider({ env: env(), transport: async body => {
    const input = JSON.parse(body.messages[0].content.replace(/^Task input \(JSON\):\n/, ''));
    const wanted = input.unmapped_fields.map(f => f.key);
    const plan = { student_name: ['Candidate', 0.9], date_of_birth: ['Date of Admission', 0.9], apaar_id: ['Mobile No', 0.95], programme: ['Stream', 0.4], enrolment_status: ['Student Status', 0.9] };
    return reply({ mappings: wanted.map(field => ({ field, header: plan[field]?.[0] ?? null, confidence: plan[field]?.[1] ?? 0, reason: 'stub' })) });
  } });
  const result = await suggestMapping(parsed, provider);
  const rejected = Object.fromEntries(result.model.rejected.map(r => [r.field, r.reason]));
  assert.equal(result.mapping.student_name, 'Candidate'); assert.equal(result.sources.student_name, 'model');
  assert.match(rejected.apaar_id, /does not fit apaar_id/, 'a phone-number column is never accepted as an identifier');
  assert.match(rejected.programme, /below 0.6/);
  assert.ok(!Object.values(result.mapping).includes('Mobile No'));
  assert.ok(result.model.sent.headers.every(h => !/\d{6,}/.test(JSON.stringify(h))), 'only header names and shapes are sent');
});

test('the evaluation harness scores model assistance against labels and never applies identity output', async () => {
  // A stub that answers from the labels shows the harness credits correct suggestions; it is not a model result.
  const truth = new Map(SCHEMA_CASES.flatMap(c => c.columns.filter(([, field]) => field).map(([h, field]) => [`${c.id}|${field}`, h])));
  let current = null;
  const oracle = createProvider({ env: env(), transport: async body => {
    const input = JSON.parse(body.messages[0].content.replace(/^Task input \(JSON\):\n/, ''));
    const headers = new Set(input.headers.map(h => h.name));
    current = SCHEMA_CASES.find(c => input.headers.every(h => c.columns.some(([name]) => name === h.name))) || current;
    return reply({ mappings: input.unmapped_fields.map(f => { const h = truth.get(`${current.id}|${f.key}`); return { field: f.key, header: h && headers.has(h) ? h : null, confidence: 0.9, reason: 'label' }; }) });
  } });
  const result = await runSchemaComparison(oracle);
  assert.ok(result.model_assisted.mapped_correctly > result.baseline.mapped_correctly);
  assert.equal(result.model.accepted_wrong, 0);
  assert.ok(result.model_assisted.mapped_wrongly >= result.baseline.mapped_wrongly, 'baseline errors are not corrected by the model');

  const identity = await runIdentityComparison(createProvider({ env: env({ EDUTRACE_AI_SHARE_NAMES: 'true' }), transport: async () => reply({ assessment: 'likely_same_person', name_relationship: 'identical', rationale: 'Same names.' }) }));
  assert.equal(identity.model_changed_links_or_findings, false);
  assert.equal(identity.model.said_same_but_different_people, identity.different_people, 'an always-same stub is scored as wrong on every different pair');
});

test('API: health check is regulator-only, assistance never verifies identifiers, and responses hide cache keys', { concurrency: false }, async () => {
  resetDemo();
  const { calls, provider } = counting();
  setProvider(provider);
  try {
    assert.equal((await call({ method: 'POST', url: '/api/v1/ai/check', headers: { 'x-demo-role': 'institution' } })).status, 403);
    const checked = await call({ method: 'POST', url: '/api/v1/ai/check', headers: { 'x-demo-role': 'regulator' } });
    assert.equal(checked.json.data.health.state, 'available');
    const status = (await call({ url: '/api/v1/ai/status' })).json.data;
    assert.equal(status.health.label, 'Available');
    const f = loadDemo().findings.find(x => isCurrent(x) && x.rule_code === 'APAAR_MISSING');
    const first = await call({ method: 'POST', url: `/api/v1/findings/${f.id}/assist`, headers: { 'x-demo-role': 'regulator' } });
    assert.equal(first.json.data.explanation.source, 'model');
    assert.doesNotMatch(first.text, /cache_key/);
    const n = calls.n;
    await call({ method: 'POST', url: `/api/v1/findings/${f.id}/assist`, headers: { 'x-demo-role': 'regulator' } });
    assert.equal(calls.n, n, 'the persisted explanation is reused');
    const automation = (await call({ url: '/api/v1/automation' })).json.data;
    assert.equal(automation.verification.authoritatively_verified, 0);
    assert.ok(loadDemo().sourceRecords.every(r => r.processing.authoritative_verification === 'not_available'));
    assert.equal(loadDemo().findings.find(x => x.id === f.id).review_status, 'pending');
  } finally { setProvider(createProvider({ env: {} })); }
});
