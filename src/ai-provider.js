// Model-assisted tasks behind a small provider interface.
//
// Nothing in EduTrace depends on a model: every task has a deterministic fallback, and the
// provider is used only when it is explicitly configured. Inputs are minimised before they
// leave the process (field names, value *shapes*, rule metadata, institution codes, source row
// numbers and statuses — never identifiers, dates of birth or whole records), and every model
// response is validated against a strict schema and a grounding policy before it is used.
// Model output is advisory: it never changes a finding, a review status or an identity link.
//
// Two providers share this interface: Anthropic (Messages API over raw HTTPS) and a local Ollama
// server (its /api/chat endpoint on this machine). Both use structured JSON output, and both are
// called with fetch so the project keeps its zero-dependency build. Startup never contacts a
// provider; the first real call (or an explicit health check) does.
//
// Configuration (environment variables — the key is read from the environment only and is
// never logged, stored or returned by any endpoint):
//   EDUTRACE_AI_PROVIDER          'anthropic' or 'ollama' to enable; anything else (default) disables model assistance
//   ANTHROPIC_API_KEY             required for the anthropic provider
//   EDUTRACE_OLLAMA_URL           local Ollama server (default http://localhost:11434); only loopback
//                                 addresses are accepted, so requests never leave the machine
//   EDUTRACE_AI_MODEL             model id (default claude-opus-5-5 for anthropic, gemma4:e4b for ollama)
//   EDUTRACE_AI_EFFORT            low | medium | high | xhigh | max (default low: these are short, bounded tasks;
//                                 not sent to models that reject it, such as claude-haiku-4-5)
//   EDUTRACE_AI_TIMEOUT_MS        per-request timeout (default 60000, or 120000 for ollama, which may need to
//                                 load the model first; 1000–120000)
//   EDUTRACE_AI_CALLS_PER_MINUTE  local call limit (default 30, or 120 for ollama)
//   EDUTRACE_AI_LOCAL_NAMES       'true' allows the candidate-match task to send the two student names to
//                                 the local Ollama provider (they stay on this machine); off by default
//   EDUTRACE_AI_SHARE_NAMES       'true' allows the candidate-match task to send the two student names
//                                 to the remote (Anthropic) provider;
//                                 without it that task stays unavailable
const crypto = require('node:crypto');
const { FIELD_DEFINITIONS } = require('./engine');

const DEFAULT_MODEL = 'claude-opus-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2026-10-21';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// Models that accept server-side refusal fallbacks (`fallbacks: "default"`) on the Claude API.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
// Models that reject `output_config.effort` (it returns HTTP 400). For these the parameter is
// left out and an explicit EDUTRACE_AI_EFFORT is reported as ignored in the provider status.
const NO_EFFORT_MODELS = /^claude-(haiku-4-5|sonnet-4-5|opus-4-5|opus-4-1|(opus|sonnet)-4-\d{8}|3)/;
const MAX_TOKENS = 16000; // thinking is always on for current models and counts toward this cap
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
// Chosen from the local benchmark in docs/ai-local-benchmark.json (see README).
const DEFAULT_OLLAMA_MODEL = 'gemma4:e4b';
const OLLAMA_MAX_TOKENS = 1024; // no hidden thinking is requested locally, so answers are short
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_ATTEMPTS = 2;   // one retry, only for rate limits, overload, 5xx and network errors
const MAX_RETRY_WAIT_MS = 5000;
// Bump when a system prompt, schema or input contract changes, so cached output is regenerated.
const PROMPT_VERSION = 'p3';

// ── Strict schema validation (subset of JSON Schema; the sent schema drops what the API does not support) ──
function checkSchema(schema, value, path = '$') {
  const errors = [];
  const fail = message => errors.push(`${path}: ${message}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  switch (schema.type) {
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('must be an object'); break; }
      for (const key of schema.required || []) if (!(key in value)) fail(`missing ${key}`);
      for (const key of Object.keys(value)) {
        if (!schema.properties?.[key]) { if (schema.additionalProperties === false) fail(`unexpected property ${key}`); continue; }
        errors.push(...checkSchema(schema.properties[key], value[key], `${path}.${key}`));
      }
      break;
    }
    case 'array':
      if (!Array.isArray(value)) { fail('must be an array'); break; }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`at most ${schema.maxItems} items`);
      value.forEach((item, i) => errors.push(...checkSchema(schema.items, item, `${path}[${i}]`)));
      break;
    case 'string':
      if (typeof value !== 'string') { fail('must be a string'); break; }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`at most ${schema.maxLength} characters`);
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(`at least ${schema.minLength} characters`);
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) { fail('must be a number'); break; }
      if (schema.minimum !== undefined && value < schema.minimum) fail(`must be ≥ ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(`must be ≤ ${schema.maximum}`);
      break;
    case 'nullable-string':
      if (value !== null && typeof value !== 'string') fail('must be a string or null');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') fail('must be a boolean');
      break;
  }
  return errors;
}
// JSON Schema sent with `output_config.format`. Structured outputs do not support length, numeric
// or array-size constraints, so those are removed here and still enforced by checkSchema().
const UNSUPPORTED_KEYWORDS = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'maxItems']);
function toJsonSchema(schema) {
  if (schema.type === 'nullable-string') return { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const out = Object.fromEntries(Object.entries(schema).filter(([k]) => !UNSUPPORTED_KEYWORDS.has(k)));
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (schema.items) out.items = toJsonSchema(schema.items);
  return out;
}

const text = max => ({ type: 'string', minLength: 1, maxLength: max });
// Language a decision-support explanation must not use: findings are review signals, not conclusions.
// A sentence may mention these words only when it negates them ("this is not proof of fraud",
// "the identifier has not been verified"); an unnegated use is rejected.
const FLAGGED = /\b(fraud\w*|fake|forg(ed|ery)|criminal|cheat\w*|guilty|illegal|misconduct|verified|authentic(ated)?)\b/i;
const NEGATION = /\b(no|not|never|without|cannot|neither|nor)\b|n't\b/i;
const PROHIBITED = { test: value => String(value).split(/(?<=[.!?])\s+/).some(sentence => FLAGGED.test(sentence) && !NEGATION.test(sentence)) };
const LONG_DIGITS = /\d{6,}/;
// Wording that would present a candidate identity match as settled.
const CONCLUSIVE = /\b(confirm(ed|s)?|definitely|certainly|certain|undoubtedly|prov(es|en|ed)|proof)\b/i;
// Grounding: every number in model prose must appear in the input it was given (the APAAR
// format length, 12, is a documented fact and always allowed). This stops invented counts,
// rows or values from being presented as evidence.
const numbersIn = value => String(value).match(/\d+(?:\.\d+)?/g) || [];
function ungroundedNumber(output, input) {
  const allowed = new Set([...numbersIn(JSON.stringify(input)), '12']);
  return numbersIn(Object.values(output).join(' ')).find(n => !allowed.has(n)) || null;
}
function proseCheck(output, input, what) {
  const all = Object.values(output).join(' ');
  if (PROHIBITED.test(all)) return `${what} uses prohibited conclusion language`;
  if (LONG_DIGITS.test(all)) return `${what} contains a long digit sequence`;
  const n = ungroundedNumber(output, input);
  return n ? `${what} mentions ${n}, which is not in the evidence it was given` : null;
}

// ── Tasks ──
const TASKS = {
  schema_interpretation: {
    description: 'Map unrecognised CSV column headers to EduTrace canonical fields using only header names and value shapes.',
    system: 'You map CSV column headers to a fixed set of canonical student-record fields. You receive only header names and coarse value shapes, never data values. Map a header only when its name and shape clearly indicate the field; otherwise return null for that field. Never map one header to two fields. Columns about parents, guardians, contact details, admission dates or remarks are not student identity fields. Return exactly one entry for every field key listed in unmapped_fields, using that key unchanged, and no other fields. Keep each reason under 200 characters.',
    output: { type: 'object', additionalProperties: false, required: ['mappings'], properties: { mappings: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['field', 'header', 'confidence', 'reason'], properties: { field: { type: 'string', enum: FIELD_DEFINITIONS.map(f => f.key) }, header: { type: 'nullable-string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }, reason: text(200) } } } } },
    check(output, input) {
      const fields = new Set(input.unmapped_fields.map(f => f.key));
      const headers = new Set(input.headers.map(h => h.name));
      const used = new Set();
      for (const m of output.mappings) {
        if (!fields.has(m.field)) return `field ${m.field} was not requested`;
        if (m.header !== null) { if (!headers.has(m.header)) return `header ${m.header} is not in the file`; if (used.has(m.header)) return `header ${m.header} mapped twice`; used.add(m.header); }
      }
      return null;
    }
  },
  candidate_assessment: {
    requiresNames: true,
    description: 'Assess whether two student names in an unconfirmed candidate match look like the same person, as advisory context for a human reviewer.',
    system: 'You assist a human reviewer. Two student records were flagged as a possible match because their names are similar and their dates of birth agree; at least one has no usable identifier. Judge only the names and the booleans provided. Your assessment is advisory and cannot merge records. When the names alone cannot settle it, answer insufficient_evidence. Never claim certainty, verification, wrongdoing or fraud. Keep the rationale to one or two sentences, under 400 characters.',
    output: { type: 'object', additionalProperties: false, required: ['assessment', 'name_relationship', 'rationale'], properties: { assessment: { type: 'string', enum: ['likely_same_person', 'likely_different_people', 'insufficient_evidence'] }, name_relationship: { type: 'string', enum: ['identical', 'spelling_variant', 'abbreviation_or_initial', 'transliteration_variant', 'different'] }, rationale: text(400) } },
    check(output, input) { return proseCheck({ rationale: output.rationale }, input, 'rationale'); }
  },
  match_explanation: {
    description: 'Explain in plain language why the deterministic identity-resolution pipeline proposed a pair of source records, from field-level comparison results only.',
    system: 'You explain identity-resolution evidence to a reviewer. You receive the field-level comparison results for the three identity fields of two source records (agree, equivalent, similar, conflict, missing, not_comparable), the matching method, the deterministic policy outcome, any disqualifying contradictions, and separately some context fields (institution, programme, session, status) that describe circumstances and are not identity evidence. You never receive names, dates of birth, identifiers or other values, and must not invent them. List only identity fields: under agreeing_fields only if the result is agree, equivalent or similar; under conflicting_fields only if the result is conflict; under missing_fields only if the result is missing or not_comparable. Include every identity field whose result is conflict. Never list a context field in these lists; you may mention context in the summary. Do not decide whether the records belong to the same student: never call the match confirmed, proven, certain or verified. No identifier has been checked against an authoritative register. Keep the summary under 400 characters and each limitation under 200 characters.',
    output: { type: 'object', additionalProperties: false, required: ['summary', 'agreeing_fields', 'conflicting_fields', 'missing_fields', 'limitations', 'recommended_action'], properties: {
      summary: text(400),
      agreeing_fields: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['identifier', 'student_name', 'date_of_birth'] } },
      conflicting_fields: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['identifier', 'student_name', 'date_of_birth'] } },
      missing_fields: { type: 'array', maxItems: 3, items: { type: 'string', enum: ['identifier', 'student_name', 'date_of_birth'] } },
      limitations: { type: 'array', maxItems: 4, items: text(200) },
      recommended_action: { type: 'string', enum: ['request_identifier_or_source_document', 'confirm_conflicting_attribute_with_institutions', 'correct_malformed_identifier', 'compare_all_competing_candidates', 'compare_source_records_and_decide'] }
    } },
    check(output, input) {
      const results = new Map(input.fields.map(f => [f.field, f.result]));
      const allowed = { agreeing_fields: ['agree', 'equivalent', 'similar'], conflicting_fields: ['conflict'], missing_fields: ['missing', 'not_comparable'] };
      for (const [list, ok] of Object.entries(allowed)) {
        for (const field of output[list]) {
          if (!results.has(field)) return `${list} names ${field}, which was not supplied`;
          if (!ok.includes(results.get(field))) return `${list} names ${field}, whose result is ${results.get(field)}`;
        }
      }
      const hidden = input.fields.filter(f => f.kind === 'identity' && f.result === 'conflict' && !output.conflicting_fields.includes(f.field));
      if (hidden.length) return `the explanation omits the conflicting ${hidden.map(f => f.field).join(', ')}`;
      const prose = { summary: output.summary, limitations: output.limitations.join(' ') };
      const claim = String(Object.values(prose).join(' ')).split(/(?<=[.!?])\s+/).find(sentence => CONCLUSIVE.test(sentence) && !NEGATION.test(sentence));
      if (claim) return 'explanation presents the match as confirmed or certain';
      return proseCheck(prose, input, 'explanation');
    }
  },
  finding_explanation: {
    description: 'Write a plain-language explanation of a persisted reconciliation finding for a reviewer, from its rule metadata and source-record evidence.',
    system: 'You explain deterministic data-reconciliation findings to reviewers in plain language. You receive the persisted finding: its rule, the rule\'s own explanation, and a summary of the source records it cites (institution, file row, status, identifier check) — no names, identifiers or dates of birth. Use only these facts: do not invent records, values, counts or verification results. No identifier has been checked against an authoritative register. Explain what the rule observed, what it may indicate, what it does not establish, and a proportionate next step. Findings are review signals: never call them fraud, misconduct, fake, verified or authentic. Keep each of the four fields to one or two short sentences, under 300 characters.',
    output: { type: 'object', additionalProperties: false, required: ['summary', 'what_it_indicates', 'what_it_does_not_establish', 'suggested_next_step'], properties: { summary: text(300), what_it_indicates: text(300), what_it_does_not_establish: text(300), suggested_next_step: text(300) } },
    check(output, input) { return proseCheck(output, input, 'explanation'); }
  }
};
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// Identifies the prompt, schema and input contract of each task; part of every cache key.
const TASK_VERSIONS = Object.fromEntries(Object.entries(TASKS).map(([key, t]) => [key, `${PROMPT_VERSION}-${sha(JSON.stringify([t.system, t.output])).slice(0, 10)}`]));

// ── Minimisation helpers (shared with callers so the payload is inspectable and testable) ──
// A coarse description of what a column contains, so headers can be interpreted without values.
function valueShape(values) {
  const filled = values.map(v => String(v ?? '').trim()).filter(Boolean);
  if (!filled.length) return 'empty';
  const kinds = new Set(filled.map(v => {
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date';
    if (/^\d{4}-\d{2}$/.test(v)) return 'year range';
    const compact = v.replace(/[\s-]/g, '');
    if (/^\d{12}$/.test(compact)) return '12-digit number';
    if (/^\d+$/.test(compact)) return `${compact.length <= 4 ? 'short' : 'long'} number`;
    if (/^[A-Z]{2,6}$/.test(v)) return 'short uppercase code';
    const words = v.split(/\s+/).length;
    return /\d/.test(v) ? 'mixed text and digits' : `text (${words <= 1 ? '1 word' : words <= 4 ? '2–4 words' : '5+ words'})`;
  }));
  return [...kinds].slice(0, 3).join(' or ');
}

// ── Health ──
const HEALTH = {
  disabled: 'Disabled',
  not_configured: 'Not configured',
  configured_untested: 'Configured, not yet tested',
  available: 'Available',
  temporarily_unavailable: 'Temporarily unavailable',
  recoverable_error: 'Failed with a recoverable error',
  misconfigured: 'Failed: check configuration'
};
// Which health state each failure kind leaves the provider in.
const KIND_STATE = {
  rate_limited: 'temporarily_unavailable', overloaded: 'temporarily_unavailable', server_error: 'temporarily_unavailable', timeout: 'temporarily_unavailable', network: 'temporarily_unavailable',
  // A 400 means the request itself was rejected (a parameter the model or API version does not
  // accept), so it is a configuration problem: retrying the same request cannot succeed.
  authentication: 'misconfigured', permission: 'misconfigured', not_found: 'misconfigured', invalid_request: 'misconfigured',
  refusal: 'recoverable_error', truncated: 'recoverable_error', invalid_json: 'recoverable_error', schema_violation: 'recoverable_error', policy_violation: 'recoverable_error', unexpected_status: 'recoverable_error'
};
function httpKind(status) {
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'server_error';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 413) return 'invalid_request';
  return 'unexpected_status';
}
const RETRYABLE = new Set(['rate_limited', 'overloaded', 'server_error', 'network']);
// The provider's own error text, made safe to store and show: keys, long digit runs and email
// addresses are redacted and the text is capped. Request bodies and headers are never kept.
function safeApiError(json) {
  const type = typeof json?.error?.type === 'string' ? json.error.type.slice(0, 60) : null;
  const message = typeof json?.error?.message === 'string'
    ? json.error.message.replace(/sk-ant-[\w-]+/g, '[redacted key]').replace(/\d{6,}/g, '[digits]').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]').replace(/\s+/g, ' ').trim().slice(0, 300)
    : null;
  return { type, message };
}

// The default transport: one HTTPS request, returning the status, retry-after and parsed body.
function httpTransport({ apiKey, timeoutMs, beta }) {
  return async body => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': API_VERSION, ...(beta ? { 'anthropic-beta': beta } : {}) }, body: JSON.stringify(body) });
      const raw = await res.text();
      let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
      // Rate-limit headers report the account's limits and remaining quota; they carry no secrets.
      const rate_limits = Object.fromEntries([...res.headers].filter(([k]) => /^(anthropic|x)-ratelimit-/.test(k)));
      return { status: res.status, retry_after: res.headers.get('retry-after'), request_id: res.headers.get('request-id'), rate_limits, json, raw_is_json: json !== null };
    } finally { clearTimeout(timer); }
  };
}
// Local Ollama transport: translates the Messages-style request built by run() into an /api/chat
// request and the reply back into the same message shape, so validation is identical for both
// providers. Decoding is deterministic (temperature 0, fixed seed) and hidden thinking is turned
// off, which keeps answers short and repeatable on a laptop GPU.
function ollamaTransport({ baseUrl, timeoutMs }) {
  return async body => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        model: body.model, stream: false, think: false, format: body.output_config.format.schema,
        options: { temperature: 0, seed: 7, num_predict: OLLAMA_MAX_TOKENS },
        messages: [{ role: 'system', content: body.system }, ...body.messages]
      }) });
      const raw = await res.text();
      let json = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
      if (res.status !== 200) return { status: res.status, retry_after: null, request_id: null, rate_limits: null, json: { type: 'error', error: { type: 'ollama_error', message: typeof json?.error === 'string' ? json.error : `HTTP ${res.status}` } }, raw_is_json: json !== null };
      if (!json) return { status: 200, retry_after: null, request_id: null, rate_limits: null, json: null, raw_is_json: false };
      return { status: 200, retry_after: null, request_id: null, rate_limits: null, raw_is_json: true, json: {
        model: json.model, stop_reason: json.done_reason === 'length' ? 'max_tokens' : 'end_turn',
        content: [{ type: 'text', text: json.message?.content ?? '' }],
        usage: { input_tokens: json.prompt_eval_count ?? null, output_tokens: json.eval_count ?? null, load_ms: json.load_duration ? Math.round(json.load_duration / 1e6) : null }
      } };
    } finally { clearTimeout(timer); }
  };
}
// A test transport may return a bare message object; treat it as HTTP 200.
const normalise = r => (r && typeof r.status === 'number' && 'json' in r ? r : { status: 200, retry_after: null, request_id: null, rate_limits: null, json: r, raw_is_json: true });

// `disabled` (a reason) turns every task off whatever the environment says: no transport is built
// and nothing can be sent. The read-only demo uses it.
function createProvider({ env = process.env, transport = null, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), disabled = null } = {}) {
  const name = String(env.EDUTRACE_AI_PROVIDER || '').trim().toLowerCase();
  const local = name === 'ollama';
  const model = String(env.EDUTRACE_AI_MODEL || (local ? DEFAULT_OLLAMA_MODEL : DEFAULT_MODEL)).trim();
  const requestedEffort = String(env.EDUTRACE_AI_EFFORT || '').trim().toLowerCase();
  const supportsEffort = !local && !NO_EFFORT_MODELS.test(model);
  const effort = !supportsEffort ? null : EFFORTS.has(requestedEffort) ? requestedEffort : 'low';
  const warnings = [];
  if (requestedEffort && !EFFORTS.has(requestedEffort)) warnings.push(`EDUTRACE_AI_EFFORT=${requestedEffort.slice(0, 20)} is not a recognised level (low, medium, high, xhigh, max); ${effort || 'no effort'} is used.`);
  else if (requestedEffort && !supportsEffort) warnings.push(`EDUTRACE_AI_EFFORT=${requestedEffort} is ignored: ${local ? 'local Ollama models do' : `${model} does`} not accept the effort parameter.`);
  const timeout = Math.min(Math.max(Number(env.EDUTRACE_AI_TIMEOUT_MS) || (local ? 120000 : 60000), 1000), 120000);
  const perMinute = Math.min(Math.max(Number(env.EDUTRACE_AI_CALLS_PER_MINUTE) || (local ? 120 : 30), 1), 600);
  const shareNames = String(env.EDUTRACE_AI_SHARE_NAMES || '').toLowerCase() === 'true';
  const localNames = String(env.EDUTRACE_AI_LOCAL_NAMES || '').toLowerCase() === 'true';
  const fallbacks = !local && FALLBACK_MODELS.has(model);
  // Calls in flight at once; further requests get the deterministic result instead of queueing.
  const maxConcurrent = Math.min(Math.max(Number(env.EDUTRACE_AI_MAX_CONCURRENT) || (local ? 1 : 4), 1), 16);
  // A hosted provider needs an explicit opt-in on top of its credentials. Code that injects a transport (tests, evaluation) is explicit already.
  const hostedEnabled = String(env.EDUTRACE_AI_HOSTED_ENABLED || '').trim().toLowerCase() === 'true' || Boolean(transport);
  const ollamaUrl = String(env.EDUTRACE_OLLAMA_URL || DEFAULT_OLLAMA_URL).trim().replace(/\/+$/, '');
  let ollamaHost = null; try { ollamaHost = new URL(ollamaUrl).hostname; } catch { ollamaHost = null; }
  const calls = [];
  let inFlight = 0;
  let lastRateLimits = null;
  let reason = null;
  if (disabled) reason = String(disabled);
  else if (name !== 'anthropic' && !local) reason = 'No model provider is configured (set EDUTRACE_AI_PROVIDER=ollama for a local model, or anthropic with ANTHROPIC_API_KEY). Deterministic rules are used for every task.';
  else if (local && !LOOPBACK_HOSTS.has(ollamaHost)) reason = 'EDUTRACE_OLLAMA_URL must point to this machine (localhost, 127.0.0.1 or [::1]); a remote server would send data off the machine. Deterministic rules are used for every task.';
  else if (!local && !env.ANTHROPIC_API_KEY && !transport) reason = 'EDUTRACE_AI_PROVIDER is anthropic but ANTHROPIC_API_KEY is not set. Deterministic rules are used for every task.';
  else if (!local && !hostedEnabled) reason = 'Hosted inference is off. Set EDUTRACE_AI_HOSTED_ENABLED=true only after a provider is selected, its credentials are configured on the server and its outputs have been evaluated on synthetic cases. Deterministic rules are used for every task.';
  const configured = !reason;
  const send = disabled ? () => { throw new Error('Model provider is disabled.'); } : transport || (local ? ollamaTransport({ baseUrl: ollamaUrl, timeoutMs: timeout }) : httpTransport({ apiKey: env.ANTHROPIC_API_KEY, timeoutMs: timeout, beta: fallbacks ? FALLBACK_BETA : null }));

  const health = { state: configured ? 'configured_untested' : disabled ? 'disabled' : 'not_configured', checked_at: null, last_success_at: null, last_error: null, consecutive_failures: 0 };
  const stats = Object.fromEntries(Object.keys(TASKS).map(key => [key, { calls: 0, succeeded: 0, failed: 0, input_tokens: 0, output_tokens: 0, total_latency_ms: 0 }]));

  function taskAvailability(task) {
    if (!configured) return { available: false, reason };
    if (TASKS[task]?.requiresNames && local && !localNames) return { available: false, reason: 'This task needs the two student names. Sending names to the local model is off (set EDUTRACE_AI_LOCAL_NAMES=true; names stay on this machine).' };
    if (TASKS[task]?.requiresNames && !local && !shareNames) return { available: false, reason: 'This task needs the two student names. Name sharing with the remote provider is off (set EDUTRACE_AI_SHARE_NAMES=true to allow it).' };
    return { available: true, reason: null };
  }

  function status() {
    return {
      provider: configured ? name : 'none',
      provider_label: !configured ? 'None' : local ? 'Local model (Ollama, this machine)' : 'Anthropic (cloud API)',
      local: configured && local,
      concurrency: { max: maxConcurrent, in_flight: inFlight }, hosted_enabled: !local && hostedEnabled,
      model: configured ? model : null,
      configured,
      reason,
      health: { ...health, label: HEALTH[health.state] },
      settings: !configured ? null : local
        ? { base_url: ollamaUrl, timeout_ms: timeout, calls_per_minute: perMinute, temperature: 0, thinking: false, local_names: localNames, warnings }
        : { api_version: API_VERSION, effort, timeout_ms: timeout, calls_per_minute: perMinute, refusal_fallbacks: fallbacks, share_names: shareNames, warnings },
      rate_limits: lastRateLimits,
      tasks: Object.fromEntries(Object.entries(TASKS).map(([key, t]) => [key, { description: t.description, template_version: TASK_VERSIONS[key], ...taskAvailability(key) }])),
      usage: stats,
      data_policy: (local ? `Requests go only to the Ollama server on this machine (${ollamaUrl}); nothing is sent to an external service. ` : '') + `Only field names, value shapes, rule metadata, institution codes, source row numbers and record statuses are sent. Identifiers and dates of birth are never sent; student names are sent only for the candidate-match task, and only when ${local ? 'EDUTRACE_AI_LOCAL_NAMES' : 'EDUTRACE_AI_SHARE_NAMES'}=true. Match explanations receive field-level results only. Model output is schema-validated, checked against the evidence it was given, and advisory — it never changes findings, review status or identity links.`
    };
  }

  const failure = (task, kind, message, extra = {}) => {
    health.state = KIND_STATE[kind] || 'recoverable_error';
    health.checked_at = new Date(now()).toISOString();
    health.consecutive_failures++;
    health.last_error = { kind, message, at: health.checked_at, http_status: extra.http_status ?? null, api_error: extra.api_error ?? null, request_id: extra.request_id ?? null, retryable: RETRYABLE.has(kind) || kind === 'timeout' };
    stats[task].failed++;
    return { ok: false, reason: `${message}; deterministic output is shown instead.`, error: health.last_error, ...extra };
  };

  // Returns { ok: true, output, provenance } or { ok: false, reason, error } — it never throws.
  async function run(task, input) {
    const spec = TASKS[task];
    if (!spec) return { ok: false, reason: `Unknown task ${task}.` };
    const availability = taskAvailability(task);
    if (!availability.available) return { ok: false, reason: availability.reason };
    const started = now();
    while (calls.length && started - calls[0] > 60000) calls.shift();
    if (calls.length >= perMinute) return { ok: false, reason: 'The local model call limit for this minute was reached; deterministic output is shown instead.', error: { kind: 'local_rate_limit', retryable: true } };
    if (inFlight >= maxConcurrent) return { ok: false, reason: `The model is already handling ${inFlight} ${inFlight === 1 ? 'request' : 'requests'}; deterministic output is shown instead.`, error: { kind: 'local_concurrency_limit', retryable: true } };
    calls.push(started);
    stats[task].calls++;
    inFlight++;
    try { return await execute(task, spec, input, started); } finally { inFlight--; }
  }

  async function execute(task, spec, input, started) {
    const body = {
      model, max_tokens: MAX_TOKENS, system: spec.system,
      messages: [{ role: 'user', content: `Task input (JSON):\n${JSON.stringify(input)}` }],
      output_config: { ...(effort ? { effort } : {}), format: { type: 'json_schema', schema: toJsonSchema(spec.output) } },
      ...(fallbacks ? { fallbacks: 'default' } : {})
    };

    let response = null; let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      let kind = null; let message = null; let wait = 0;
      try {
        response = normalise(await send(body));
        if (response.rate_limits && Object.keys(response.rate_limits).length) lastRateLimits = response.rate_limits;
        if (response.status === 200) break;
        kind = httpKind(response.status);
        const api = safeApiError(response.json);
        message = `Provider returned HTTP ${response.status}${api.type ? ` (${api.type}${api.message ? `: ${api.message}` : ''})` : ''}`;
        wait = Math.min((Number(response.retry_after) || 2 ** attempts) * 1000, MAX_RETRY_WAIT_MS);
      } catch (error) {
        kind = error.name === 'AbortError' ? 'timeout' : 'network';
        message = kind === 'timeout' ? `Model request timed out after ${timeout} ms` : local ? `The local Ollama server at ${ollamaUrl} could not be reached (${error.cause?.code || error.message})` : `Model request failed (${error.cause?.code || error.message})`;
        wait = 1000;
      }
      if (!RETRYABLE.has(kind) || attempts >= MAX_ATTEMPTS) return failure(task, kind, message, { http_status: response?.status ?? null, api_error: response?.json?.error ? safeApiError(response.json) : null, request_id: response?.request_id ?? null, attempts, latency_ms: now() - started });
      await sleep(wait);
    }

    const msg = response.json || {};
    const latency = now() - started;
    const usage = { input_tokens: msg.usage?.input_tokens ?? null, output_tokens: msg.usage?.output_tokens ?? null };
    stats[task].input_tokens += usage.input_tokens || 0; stats[task].output_tokens += usage.output_tokens || 0; stats[task].total_latency_ms += latency;
    const meta = { attempts, latency_ms: latency, usage, request_id: response.request_id ?? null };
    if (!response.raw_is_json) return failure(task, 'invalid_json', 'The provider response was not valid JSON', meta);
    if (msg.stop_reason === 'refusal') return failure(task, 'refusal', `The model declined the request${msg.stop_details?.category ? ` (${msg.stop_details.category})` : ''}`, meta);
    if (msg.stop_reason === 'max_tokens') return failure(task, 'truncated', 'The model output was cut off at the token limit', meta);
    const textOut = (msg.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
    let output;
    try { output = JSON.parse(textOut); } catch { return failure(task, 'invalid_json', 'The model did not return valid JSON', meta); }
    const errors = checkSchema(spec.output, output);
    if (errors.length) return failure(task, 'schema_violation', `Model output was rejected by schema validation (${errors[0]})`, meta);
    const policy = spec.check(output, input);
    if (policy) return failure(task, 'policy_violation', `Model output was rejected (${policy})`, meta);

    health.state = 'available';
    health.checked_at = health.last_success_at = new Date(now()).toISOString();
    health.consecutive_failures = 0;
    stats[task].succeeded++;
    const servedByFallback = (msg.usage?.iterations || []).some(entry => entry.type === 'fallback_message');
    return { ok: true, output, provenance: { provider: name, local, model: msg.model || model, requested_model: model, served_by_fallback: servedByFallback, task, template_version: TASK_VERSIONS[task], generated_at: new Date(started).toISOString(), input_fields: Object.keys(input), ...meta } };
  }

  // An explicit health check on a fixed synthetic input. Never run at startup.
  async function check() {
    if (!configured) return { ok: false, health: status().health, reason };
    const probe = { rule_code: 'APAAR_MISSING', rule_title: 'Identifier missing', rule_explanation: 'apaar_id needs review in source row 2. Local format checks are not authoritative verification.', category: 'identifier', severity: 'medium', review_status: 'pending', processing_outcome: 'needs_institution_correction', record_count: 1, institution_count: 1, evidence: [{ institution_code: 'DEMO', source_row: 2, enrolment_status: 'active', identifier_check: 'missing' }], authoritative_verification: 'not available' };
    const result = await run('finding_explanation', probe);
    return { ok: result.ok, health: status().health, reason: result.ok ? null : result.reason, latency_ms: result.provenance?.latency_ms ?? result.latency_ms ?? null };
  }

  return { status, run, check, configured };
}

module.exports = { createProvider, checkSchema, toJsonSchema, valueShape, ungroundedNumber, safeApiError, TASKS, TASK_VERSIONS, PROHIBITED, HEALTH, API_VERSION, DEFAULT_MODEL, DEFAULT_OLLAMA_MODEL };
