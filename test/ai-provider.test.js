require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider, valueShape, checkSchema, toJsonSchema, TASKS, API_VERSION } = require('../src/ai-provider');

/* Every test here uses a stub transport: no request leaves the process. */
const KEY = 'sk-test-not-a-real-key-123';
// A hosted provider is configured explicitly: credentials plus the hosted opt-in.
const env = (extra = {}) => ({ EDUTRACE_AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: KEY, EDUTRACE_AI_HOSTED_ENABLED: 'true', ...extra });
const reply = (output, extra = {}) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 120, output_tokens: 80 }, ...extra });
const http = (status, json, retry_after = null) => ({ status, json, retry_after, raw_is_json: json !== null });
const noSleep = { sleep: async () => {} };
const explanation = { summary: 'Two records share an identifier but their dates of birth differ.', what_it_indicates: 'One record may carry an incorrect value.', what_it_does_not_establish: 'It does not establish which record is correct, and nothing has been verified.', suggested_next_step: 'Ask the institutions for an authoritative source record.' };
const explainInput = { rule_code: 'IDENTIFIER_ATTRIBUTE_CONFLICT', rule_explanation: 'Shared identifier with differing date of birth.', record_count: 2, evidence: [{ institution_code: 'NITM', source_row: 6 }, { institution_code: 'NITM', source_row: 2 }], agreeing_fields: ['identifier'], conflicting_fields: ['date_of_birth'] };

test('without configuration the provider is disabled, never calls out, and reports not_configured', async () => {
  let called = false;
  const provider = createProvider({ env: {}, transport: async () => { called = true; } });
  const status = provider.status();
  assert.equal(status.provider, 'none'); assert.equal(status.configured, false);
  assert.equal(status.health.state, 'not_configured');
  assert.ok(Object.values(status.tasks).every(t => t.available === false));
  const result = await provider.run('finding_explanation', explainInput);
  assert.equal(result.ok, false); assert.match(result.reason, /No model provider is configured/);
  assert.equal((await provider.check()).ok, false);
  assert.equal(called, false);
  assert.equal(createProvider({ env: { EDUTRACE_AI_PROVIDER: 'anthropic' } }).status().configured, false, 'a provider name without a key stays disabled');
});

test('configured but unused reports configured_untested; creating the provider sends nothing', () => {
  let called = false;
  const status = createProvider({ env: env(), transport: async () => { called = true; } }).status();
  assert.equal(status.health.state, 'configured_untested');
  assert.equal(status.health.label, 'Configured, not yet tested');
  assert.equal(called, false);
});

test('requests use structured outputs, the configured model and effort, and refusal fallbacks where supported', async () => {
  let sent;
  const provider = createProvider({ env: env(), transport: async body => { sent = body; return reply(explanation); } });
  const result = await provider.run('finding_explanation', explainInput);
  assert.equal(result.ok, true, result.reason); assert.deepEqual(result.output, explanation);
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.tool_choice, undefined, 'no forced tool use');
  assert.equal(sent.output_config.format.type, 'json_schema');
  assert.equal(sent.output_config.effort, 'low');
  assert.equal(sent.fallbacks, 'default');
  assert.ok(sent.max_tokens >= 4000, 'room for adaptive thinking');
  assert.doesNotMatch(JSON.stringify(sent.output_config.format.schema), /minLength|maxLength|minimum|maximum|maxItems/);
  assert.equal(result.provenance.template_version, provider.status().tasks.finding_explanation.template_version);
  assert.deepEqual(result.provenance.usage, { input_tokens: 120, output_tokens: 80 });
  assert.equal(provider.status().health.state, 'available');
  assert.equal(provider.status().usage.finding_explanation.succeeded, 1);
  assert.equal(API_VERSION, '2026-10-21');

  let haikuBody;
  await createProvider({ env: env({ EDUTRACE_AI_MODEL: 'claude-haiku-5-5', EDUTRACE_AI_EFFORT: 'medium' }), transport: async body => { haikuBody = body; return reply(explanation); } }).run('finding_explanation', explainInput);
  assert.equal(haikuBody.model, 'claude-haiku-5-5'); assert.equal(haikuBody.output_config.effort, 'medium');
  assert.equal(haikuBody.fallbacks, undefined, 'Haiku has no server-side fallback');
  assert.deepEqual(toJsonSchema({ type: 'nullable-string' }), { anyOf: [{ type: 'string' }, { type: 'null' }] });
});

test('rate limits and overload are retried once, honouring retry-after, then reported as temporarily unavailable', async () => {
  const waits = [];
  let n = 0;
  const recovering = createProvider({ env: env(), sleep: async ms => { waits.push(ms); }, transport: async () => (++n === 1 ? http(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, '2') : reply(explanation)) });
  const ok = await recovering.run('finding_explanation', explainInput);
  assert.equal(ok.ok, true); assert.equal(ok.provenance.attempts, 2); assert.deepEqual(waits, [2000]);

  const busy = createProvider({ env: env(), ...noSleep, transport: async () => http(529, { type: 'error', error: { type: 'overloaded_error', message: 'busy' } }) });
  const failed = await busy.run('finding_explanation', explainInput);
  assert.equal(failed.ok, false); assert.equal(failed.error.kind, 'overloaded'); assert.equal(failed.attempts, 2);
  assert.equal(busy.status().health.state, 'temporarily_unavailable');
  assert.equal(busy.status().health.last_error.retryable, true);

  let calls = 0;
  const unauthorised = createProvider({ env: env(), ...noSleep, transport: async () => { calls++; return http(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }); } });
  const denied = await unauthorised.run('finding_explanation', explainInput);
  assert.equal(denied.error.kind, 'authentication'); assert.equal(calls, 1, 'authentication errors are not retried');
  assert.equal(unauthorised.status().health.state, 'misconfigured');

  const slow = createProvider({ env: env(), ...noSleep, transport: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  const timedOut = await slow.run('finding_explanation', explainInput);
  assert.equal(timedOut.error.kind, 'timeout'); assert.match(timedOut.reason, /timed out/);
  assert.equal(slow.status().health.state, 'temporarily_unavailable');
});

test('refusals, truncation, invalid JSON, schema breaks, policy and grounding failures are recoverable errors', async () => {
  const run = (response, input = explainInput, task = 'finding_explanation') => { const p = createProvider({ env: env(), ...noSleep, transport: async () => response }); return p.run(task, input).then(r => ({ r, health: p.status().health.state })); };
  const cases = [
    [reply(explanation, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] }), 'refusal', /declined/],
    [reply(explanation, { stop_reason: 'max_tokens' }), 'truncated', /cut off/],
    [{ ...reply(explanation), content: [{ type: 'text', text: '{"summary": "unterminated' }] }, 'invalid_json', /valid JSON/],
    [http(200, null), 'invalid_json', /not valid JSON/],
    [reply({ ...explanation, extra: 'x' }), 'schema_violation', /unexpected property extra/],
    [reply({ summary: 'Only a summary.' }), 'schema_violation', /missing/],
    [reply({ ...explanation, summary: 'This record is fraudulent.' }), 'policy_violation', /prohibited/],
    [reply({ ...explanation, summary: 'The identifier is verified.' }), 'policy_violation', /prohibited/],
    [reply({ ...explanation, summary: 'Identifier 700000000123 repeats.' }), 'policy_violation', /digit/],
    [reply({ ...explanation, summary: 'Seven records across 4 institutions disagree.' }), 'policy_violation', /mentions 4, which is not in the evidence/]
  ];
  for (const [response, kind, message] of cases) {
    const { r, health } = await run(response);
    assert.equal(r.ok, false, kind); assert.equal(r.error.kind, kind); assert.match(r.reason, message); assert.match(r.reason, /deterministic output is shown instead/);
    assert.equal(health, 'recoverable_error', kind);
  }
  const grounded = await run(reply({ ...explanation, summary: 'Rows 6 and 2 at NITM share an identifier; the 2 records disagree on date of birth.' }));
  assert.equal(grounded.r.ok, true, 'numbers present in the evidence are allowed');
  const schemaInput = { unmapped_fields: [{ key: 'student_name', label: 'Student name', required: true }], headers: [{ name: 'Learner', shape: 'text (2–4 words)' }] };
  assert.match((await run(reply({ mappings: [{ field: 'student_name', header: 'Not in file', confidence: 0.9, reason: 'guess' }] }), schemaInput, 'schema_interpretation')).r.reason, /not in the file/);
  assert.match((await run(reply({ mappings: [{ field: 'apaar_id', header: 'Learner', confidence: 0.9, reason: 'guess' }] }), schemaInput, 'schema_interpretation')).r.reason, /not requested/);
});

test('models without effort support get no effort parameter; a 400 keeps the safe API message and is a configuration error', async () => {
  let body;
  const haiku45 = createProvider({ env: env({ EDUTRACE_AI_MODEL: 'claude-haiku-4-5-20251001', EDUTRACE_AI_EFFORT: 'low' }), transport: async b => { body = b; return reply(explanation); } });
  assert.equal((await haiku45.run('finding_explanation', explainInput)).ok, true);
  assert.equal('effort' in body.output_config, false, 'Haiku 4.5 rejects output_config.effort');
  assert.equal(body.output_config.format.type, 'json_schema');
  for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'fallbacks', 'tool_choice']) assert.equal(key in body, false, key);
  assert.equal(haiku45.status().settings.effort, null);
  assert.match(haiku45.status().settings.warnings[0], /EDUTRACE_AI_EFFORT=low is ignored: claude-haiku-4-5-20251001 does not accept the effort parameter/);
  assert.deepEqual(createProvider({ env: env({ EDUTRACE_AI_MODEL: 'claude-haiku-5-5' }) }).status().settings.warnings, []);

  const apiMessage = 'output_config.effort: This model does not support the effort parameter. Key sk-ant-api03-abcDEF_123 row 700000000123 from someone@example.org';
  let sends = 0;
  const p = createProvider({ env: env(), ...noSleep, transport: async () => { sends++; return { ...http(400, { type: 'error', error: { type: 'invalid_request_error', message: apiMessage } }), request_id: 'req_test_1', rate_limits: { 'anthropic-ratelimit-requests-limit': '50' } }; } });
  const r = await p.run('finding_explanation', explainInput);
  assert.equal(r.ok, false); assert.equal(r.error.kind, 'invalid_request'); assert.equal(sends, 1, 'a 400 is not retried');
  assert.match(r.reason, /HTTP 400 \(invalid_request_error: output_config\.effort: This model does not support the effort parameter/);
  assert.equal(r.error.api_error.type, 'invalid_request_error'); assert.equal(r.error.request_id, 'req_test_1');
  assert.doesNotMatch(JSON.stringify([r, p.status()]), /sk-ant-api03|700000000123|someone@example/);
  assert.equal(p.status().health.state, 'misconfigured');
  assert.deepEqual(p.status().rate_limits, { 'anthropic-ratelimit-requests-limit': '50' });
});

test('the API key is never exposed in status, errors or provenance', async () => {
  const provider = createProvider({ env: env(), ...noSleep, transport: async () => http(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) });
  const failed = await provider.run('finding_explanation', explainInput);
  const ok = await createProvider({ env: env(), transport: async () => reply(explanation) }).run('finding_explanation', explainInput);
  assert.doesNotMatch(JSON.stringify([provider.status(), failed, ok]), new RegExp(KEY));
});

test('the candidate task needs explicit permission to send names', async () => {
  const off = createProvider({ env: env(), transport: async () => { throw new Error('must not be called'); } });
  assert.equal(off.status().tasks.candidate_assessment.available, false);
  assert.match((await off.run('candidate_assessment', { name_a: 'A', name_b: 'B' })).reason, /Name sharing with the remote provider is off/);
  const on = createProvider({ env: env({ EDUTRACE_AI_SHARE_NAMES: 'true' }), transport: async () => reply({ assessment: 'insufficient_evidence', name_relationship: 'abbreviation_or_initial', rationale: 'The names differ only by an abbreviated first name; this cannot confirm identity.' }) });
  assert.equal((await on.run('candidate_assessment', { name_a: 'Mohammed A', name_b: 'Mohd A' })).ok, true);
});

test('the health check runs one synthetic probe and reports the resulting state', async () => {
  let sent;
  const provider = createProvider({ env: env(), transport: async body => { sent = body; return reply({ summary: 'An identifier is missing in row 2.', what_it_indicates: 'The institution did not supply it.', what_it_does_not_establish: 'It does not establish that the student is not enrolled.', suggested_next_step: 'Request a corrected file.' }); } });
  const result = await provider.check();
  assert.equal(result.ok, true, result.reason); assert.equal(result.health.state, 'available');
  assert.match(sent.messages[0].content, /DEMO/, 'the probe uses synthetic input only');
});

test('value shapes describe columns without revealing values', () => {
  assert.equal(valueShape(['700000000001', '7000 0000 0002']), '12-digit number');
  assert.equal(valueShape(['01/02/2005', '2005-02-01']), 'date');
  assert.equal(valueShape(['2024-25']), 'year range');
  assert.equal(valueShape(['', ' ']), 'empty');
  const shape = valueShape(['Asha Rao', 'Kabir Iyer', 'NITM']);
  assert.doesNotMatch(shape, /Asha|Kabir|NITM/);
  for (const task of Object.values(TASKS)) assert.deepEqual(checkSchema(task.output, null).length > 0, true);
});

/* Ollama: these tests replace global fetch, so no request reaches a local server either. */
async function withFetch(stub, fn) {
  const original = globalThis.fetch; globalThis.fetch = stub;
  try { return await fn(); } finally { globalThis.fetch = original; }
}
const ollamaEnv = (extra = {}) => ({ EDUTRACE_AI_PROVIDER: 'ollama', ...extra });

test('ollama is a local provider: no key, loopback only, no effort, and an honest status', () => {
  const status = createProvider({ env: ollamaEnv() }).status();
  assert.equal(status.configured, true); assert.equal(status.provider, 'ollama'); assert.equal(status.local, true);
  assert.equal(status.model, 'gemma4:e4b');
  assert.match(status.provider_label, /Local model \(Ollama/);
  assert.equal(status.settings.base_url, 'http://localhost:11434'); assert.equal(status.settings.temperature, 0); assert.equal(status.settings.thinking, false);
  assert.equal('effort' in status.settings, false);
  assert.match(status.data_policy, /only to the Ollama server on this machine/);
  assert.equal(status.health.state, 'configured_untested');
  assert.match(createProvider({ env: ollamaEnv({ EDUTRACE_AI_EFFORT: 'high' }) }).status().settings.warnings[0], /local Ollama models do not accept/);
  const remote = createProvider({ env: ollamaEnv({ EDUTRACE_OLLAMA_URL: 'http://10.0.0.5:11434' }) }).status();
  assert.equal(remote.configured, false); assert.match(remote.reason, /must point to this machine/);
  assert.equal(createProvider({ env: ollamaEnv({ EDUTRACE_OLLAMA_URL: 'http://127.0.0.1:11434/' }) }).status().configured, true);
});

test('ollama requests use /api/chat with the JSON schema, no thinking and deterministic decoding; replies are validated as usual', async () => {
  const calls = [];
  const ok = (content, extra = {}) => ({ status: 200, text: async () => JSON.stringify({ model: 'gemma4:e4b', message: { role: 'assistant', content }, done_reason: 'stop', prompt_eval_count: 210, eval_count: 64, load_duration: 5e6, ...extra }) });
  await withFetch(async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return ok(JSON.stringify(explanation)); }, async () => {
    const p = createProvider({ env: ollamaEnv({ EDUTRACE_AI_MODEL: 'gemma4:e4b' }) });
    const r = await p.run('finding_explanation', explainInput);
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.provenance.provider, 'ollama'); assert.equal(r.provenance.local, true); assert.equal(r.provenance.model, 'gemma4:e4b');
    assert.deepEqual(r.provenance.usage, { input_tokens: 210, output_tokens: 64 });
    assert.equal(p.status().health.state, 'available');
  });
  const [{ url, body, headers }] = calls;
  assert.equal(url, 'http://localhost:11434/api/chat');
  assert.equal(body.model, 'gemma4:e4b'); assert.equal(body.stream, false); assert.equal(body.think, false);
  assert.deepEqual(body.options, { temperature: 0, seed: 7, num_predict: 1024 });
  assert.equal(body.format.type, 'object'); assert.equal(body.format.additionalProperties, false);
  assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
  assert.equal('x-api-key' in headers, false, 'no key is sent to the local server');

  await withFetch(async () => ok('{"summary": "cut', { done_reason: 'length' }), async () => {
    assert.equal((await createProvider({ env: ollamaEnv() }).run('finding_explanation', explainInput)).error.kind, 'truncated');
  });
  await withFetch(async () => ok(JSON.stringify({ ...explanation, summary: 'This record is fraudulent.' })), async () => {
    assert.equal((await createProvider({ env: ollamaEnv() }).run('finding_explanation', explainInput)).error.kind, 'policy_violation');
  });
});

test('ollama failures fall back to deterministic output: missing model is a configuration error, an unreachable server is temporary', async () => {
  await withFetch(async () => ({ status: 404, text: async () => JSON.stringify({ error: "model 'llama9:70b' not found" }) }), async () => {
    const p = createProvider({ env: ollamaEnv({ EDUTRACE_AI_MODEL: 'llama9:70b' }) });
    const r = await p.run('finding_explanation', explainInput);
    assert.equal(r.ok, false); assert.match(r.reason, /HTTP 404 \(ollama_error: model 'llama9:70b' not found\)/); assert.match(r.reason, /deterministic output is shown instead/);
    assert.equal(p.status().health.state, 'misconfigured');
  });
  let attempts = 0;
  await withFetch(async () => { attempts++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, async () => {
    const p = createProvider({ env: ollamaEnv(), sleep: async () => {} });
    const r = await p.run('finding_explanation', explainInput);
    assert.equal(r.ok, false); assert.match(r.reason, /local Ollama server at http:\/\/localhost:11434 could not be reached \(ECONNREFUSED\)/);
    assert.equal(p.status().health.state, 'temporarily_unavailable'); assert.equal(attempts, 2, 'one retry');
    assert.equal((await p.check()).ok, false);
  });
});
