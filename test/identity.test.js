require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { compareNames, nameKey } = require('../src/names');
const { buildIdentityLinks, compareRecords, AUTO_LINK_POLICY } = require('../src/identity');
const { normaliseRecord, reconcile } = require('../src/engine');
const { runPipelineScenarios, buildPairDataset, scorePairs } = require('../src/identity-benchmark');
const { explainMatch, matchExplanationInput } = require('../src/matches');
const { createProvider, TASKS } = require('../src/ai-provider');
const { server, setProvider } = require('../server');
const { resetDemo, loadDemo } = require('../src/seed');

/* No test here contacts a model: providers use stub transports. */
setProvider(createProvider({ env: {} }));
let seq = 0;
const rec = (inst, { id = '', name, dob = '' }) => ({ id: `T-${++seq}`, source_file: `${inst.toLowerCase()}.csv`, source_row: seq + 1, import_id: null, imported_at: '2026-10-21T09:00:00.000Z', ...normaliseRecord({ apaar_id: id, student_name: name, date_of_birth: dob, institution_code: inst, programme: 'BTECH CSE', academic_session: '2026-27', enrolment_status: 'Active' }) });
const linkBetween = (links, a, b) => links.find(l => l.records.includes(a.id) && l.records.includes(b.id));

test('name comparison folds formatting, documented abbreviations and initials without changing stored values', () => {
  const cases = [
    ['mohammed imran khan', 'mohd imran khan', 'equivalent'], ['zoë fernandes', 'zoe fernandes', 'equivalent'], ['priya sharma', 'sharma priya', 'equivalent'],
    ['ravi-kumar iyer', 'ravi kumar iyer', 'equivalent'], ['ambiguous nair', 'ambiguous nair', 'exact'], ['a. kumar', 'arun kumar', 'similar'],
    ['rohan mehta', 'rohit mehta', 'different'], ['ananya iyer', 'ananya iyengar', 'different'], ['kiran joshi', 'kiran joshi rao', 'different'], ['', 'x y', 'missing']
  ];
  for (const [a, b, expected] of cases) assert.equal(compareNames(a, b).result, expected, `${a} / ${b}`);
  assert.match(compareNames('mohammed ali', 'mohd ali').note, /documented abbreviation/);
  assert.equal(nameKey('Mohd. Imran KHAN'), nameKey('Khan Mohammed Imran'));
  const r = rec('NITM', { name: '  Mohd.  Imran ', dob: '01/02/2004' });
  assert.equal(r.student_name, 'Mohd. Imran', 'the stored name keeps the supplied spelling');
});

test('the automatic-link policy requires a usable identifier, agreeing names and dates of birth, and no contradiction', () => {
  const id = '930000000101';
  const a = rec('NITM', { id, name: 'Meera Nath', dob: '01/02/2004' });
  const b = rec('RCA', { id, name: 'MEERA  NATH', dob: '2004-02-01' });
  const c = rec('SVU', { id: '930000000102', name: 'Mohammed Ali', dob: '05/05/2005' });
  const d = rec('RCA', { id: '930000000102', name: 'Mohd Ali', dob: '05/05/2005' });
  const links = buildIdentityLinks([a, b, c, d]);
  assert.equal(linkBetween(links, a, b).outcome, 'auto_linked');
  assert.equal(linkBetween(links, a, b).policy_version, AUTO_LINK_POLICY.version);
  assert.equal(linkBetween(links, c, d).outcome, 'auto_linked', 'equivalent names after a documented abbreviation');

  const bad1 = rec('NITM', { id: '12345', name: 'Tara Rao', dob: '03/03/2003' }); const bad2 = rec('RCA', { id: '12345', name: 'Tara Rao', dob: '03/03/2003' });
  const malformed = linkBetween(buildIdentityLinks([bad1, bad2]), bad1, bad2);
  assert.equal(malformed.outcome, 'candidate_for_review', 'a shared malformed identifier is never identifier evidence');
  assert.ok(malformed.disqualifiers.includes('shared_malformed_identifier'));

  const e = rec('NITM', { id: '930000000103', name: 'Dev Rao', dob: '01/01/2004' }); const f = rec('RCA', { id: '930000000103', name: 'Dev Rao', dob: '02/01/2004' });
  const dobConflict = linkBetween(buildIdentityLinks([e, f]), e, f);
  assert.equal(dobConflict.outcome, 'needs_investigation'); assert.ok(dobConflict.disqualifiers.includes('date_of_birth_conflict'));

  // A third record that conflicts blocks the automatic link between the two that agree.
  const g = rec('NITM', { id: '930000000104', name: 'Ira Vyas', dob: '01/01/2004' }); const h = rec('RCA', { id: '930000000104', name: 'Ira Vyas', dob: '01/01/2004' }); const i = rec('SVU', { id: '930000000104', name: 'Ira Vyas', dob: '09/09/2004' });
  assert.equal(linkBetween(buildIdentityLinks([g, h, i]), g, h).outcome, 'needs_investigation');

  const j = rec('NITM', { id: '930000000105', name: 'Neel Jain', dob: '01/01/2004' }); const k = rec('RCA', { id: '930000000105', name: 'Neel Jain' });
  assert.equal(linkBetween(buildIdentityLinks([j, k]), j, k).outcome, 'candidate_for_review', 'a missing date of birth is never treated as agreement');
  const l1 = rec('NITM', { id: '930000000106', name: 'Arun Kumar', dob: '01/01/2004' }); const l2 = rec('RCA', { id: '930000000106', name: 'A. Kumar', dob: '01/01/2004' });
  assert.equal(linkBetween(buildIdentityLinks([l1, l2]), l1, l2).outcome, 'candidate_for_review', 'an initial is never enough for an automatic link');
});

test('pairs without a shared identifier are proposed only with a matching date of birth, never linked, and ambiguity is flagged', () => {
  const a = rec('NITM', { name: 'Kavya Bose', dob: '01/01/2004' }); const b = rec('RCA', { name: 'Kavya Bose', dob: '01/01/2004' }); const c = rec('SVU', { id: '930000000201', name: 'Kavya Bose', dob: '01/01/2004' });
  const links = buildIdentityLinks([a, b, c]);
  [linkBetween(links, a, b), linkBetween(links, a, c)].forEach(l => { assert.equal(l.outcome, 'candidate_for_review'); assert.ok(l.competing_candidates >= 2); assert.ok(l.disqualifiers.includes('competing_candidates')); });
  assert.ok(!links.some(l => l.outcome === 'auto_linked'), 'name evidence never links automatically');

  const d = rec('NITM', { name: 'Aditya Hegde' }); const e = rec('RCA', { name: 'Aditya Hegde' });
  assert.equal(linkBetween(buildIdentityLinks([d, e]), d, e).outcome, 'insufficient_evidence');
  const f = rec('NITM', { name: 'Myra Pillai', dob: '01/01/2004' }); const g = rec('RCA', { name: 'Myra Pillai', dob: '02/02/2004' });
  assert.equal(linkBetween(buildIdentityLinks([f, g]), f, g).outcome, 'not_linked');
  const h = rec('NITM', { name: 'Zoya Ghosh', dob: '01/01/2004' }); const i = rec('NITM', { name: 'Zoya Ghosh', dob: '01/01/2004' });
  assert.equal(linkBetween(buildIdentityLinks([h, i]), h, i), undefined, 'records of one institution without a shared identifier are not proposed (resubmissions)');

  const cmp = compareRecords(a, b);
  assert.equal(cmp.factors.reduce((n, x) => n + x.weight, 0), cmp.score, 'the score is exactly the sum of the recorded factors');
  assert.ok(cmp.factors.every(x => x.field && x.result && x.note));
  assert.doesNotMatch(JSON.stringify(cmp), /Kavya|2004-01-01/, 'comparisons record results, never values');
});

test('candidate findings and identity links are one source of truth', () => {
  const { records } = buildPairDataset();
  const findings = reconcile({ sourceRecords: records, capacityRules: [] }).filter(f => f.rule_code === 'CANDIDATE_IDENTITY_MATCH');
  const links = buildIdentityLinks(records).filter(l => l.method === 'name_dob_similarity' && l.outcome === 'candidate_for_review');
  assert.deepEqual(findings.map(f => [...f.evidence].sort().join('|')).sort(), links.map(l => l.records.join('|')).sort());
});

test('benchmark guard: no false or contradictory automatic links on the labelled synthetic set', () => {
  const { records, pairs } = buildPairDataset();
  const score = scorePairs(buildIdentityLinks(records), pairs);
  assert.equal(score.overall.false_positive_auto_links, 0);
  assert.equal(score.overall.contradictory_pairs_auto_linked, 0);
  assert.equal(score.overall.candidate_generation_recall, 1);
  assert.equal(score.unexpected_surfaced_pairs, 0);
});

test('pipeline: decisions persist across unchanged re-imports, contradicted automatic links are withdrawn, re-imports are idempotent', () => {
  const results = runPipelineScenarios();
  for (const r of results) assert.equal(r.passed, true, `${r.scenario}: ${JSON.stringify(r.observed)}`);
});

/* ── Model explanation of a pair: validation and fallback ── */
const stubDb = () => {
  const a = rec('NITM', { id: '930000000301', name: 'Rohan Desai', dob: '01/01/2004' }); const b = rec('RCA', { id: '930000000301', name: 'Rohan Desai', dob: '02/02/2004' });
  return { institutions: [], importBatches: [], findings: [], sourceRecords: [a, b], identityLinks: buildIdentityLinks([a, b]) };
};
const REG = { role: 'regulator', name: 'Test reviewer' };
const reply = output => ({ model: 'stub-model', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 10, output_tokens: 10 } });
const good = { summary: 'The records share an identifier but their dates of birth differ, so the policy keeps them for review.', agreeing_fields: ['identifier', 'student_name'], conflicting_fields: ['date_of_birth'], missing_fields: [], limitations: ['Which date of birth is correct is not established.'], recommended_action: 'confirm_conflicting_attribute_with_institutions' };

test('match explanations: only field results are sent, and invented, misplaced, hidden or conclusive answers are rejected', async () => {
  let sent;
  const db = stubDb();
  const link = db.identityLinks[0];
  const ok = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'ollama' }, transport: async body => { sent = body; return reply(good); } });
  const result = (await explainMatch(db, REG, link.id, ok)).result;
  assert.equal(result.source, 'model'); assert.equal(result.provenance.model, 'stub-model');
  assert.doesNotMatch(sent.messages[0].content, /Rohan|Desai|2004|930000000301/, 'no names, dates or identifiers reach the model');
  assert.equal(link.outcome, 'needs_investigation', 'an explanation never changes the outcome');

  const bad = [
    [{ ...good, agreeing_fields: ['identifier', 'mother_name'] }, /schema validation/],
    [{ ...good, agreeing_fields: ['identifier', 'date_of_birth'], conflicting_fields: [] }, /date_of_birth, whose result is conflict/],
    [{ ...good, conflicting_fields: [] }, /omits the conflicting date_of_birth/],
    [{ ...good, summary: 'These records are confirmed to be the same student.' }, /confirmed or certain/],
    [{ ...good, summary: 'The identifier is verified for both.' }, /prohibited/],
    [{ ...good, summary: 'Records from 23 institutions agree.' }, /mentions 23/]
  ];
  for (const [output, reason] of bad) {
    const p = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'ollama' }, transport: async () => reply(output) });
    const fresh = stubDb();
    const r = (await explainMatch(fresh, REG, fresh.identityLinks[0].id, p)).result;
    assert.equal(r.source, 'deterministic', JSON.stringify(output).slice(0, 60)); assert.match(r.model_unavailable_reason, reason);
    assert.ok(r.summary && r.recommended_action_label, 'the deterministic explanation is always available');
  }
  const offDb = stubDb();
  const off = (await explainMatch(offDb, REG, offDb.identityLinks[0].id, createProvider({ env: {} }))).result;
  assert.equal(off.source, 'deterministic'); assert.match(off.model_unavailable_reason, /No model provider is configured/);
  assert.ok(TASKS.match_explanation && !TASKS.match_explanation.requiresNames);
});

test('match explanations are cached per evidence and model, and a stale one is withheld when the model fails', async () => {
  const db = stubDb(); const link = db.identityLinks[0];
  let calls = 0;
  const p = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'ollama' }, transport: async () => { calls++; return reply(good); } });
  assert.equal((await explainMatch(db, REG, link.id, p)).changed, true);
  const again = await explainMatch(db, REG, link.id, p);
  assert.equal(again.changed, false); assert.equal(again.result.cached, true); assert.equal(calls, 1);
  const otherModel = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'ollama', EDUTRACE_AI_MODEL: 'qwen2.5-coder:7b' }, transport: async () => ({ status: 503, json: { error: { type: 'overloaded', message: 'busy' } }, retry_after: null, raw_is_json: true }), sleep: async () => {} });
  const stale = await explainMatch(db, REG, link.id, otherModel);
  assert.equal(stale.result.source, 'deterministic'); assert.equal(stale.result.stale_model_explanation_withheld, true);
  assert.equal(Object.keys(db.matchAssist).length, 0, 'the stale explanation is removed, not shown as current');
  assert.ok(matchExplanationInput(link, []).authoritative_verification === 'not available');
});

test('local and remote name sharing are separate settings, both off by default', () => {
  const avail = env => createProvider({ env: { ...env, ANTHROPIC_API_KEY: 'sk-test', EDUTRACE_AI_HOSTED_ENABLED: 'true' } }).status().tasks.candidate_assessment;
  assert.equal(avail({ EDUTRACE_AI_PROVIDER: 'ollama' }).available, false);
  assert.match(avail({ EDUTRACE_AI_PROVIDER: 'ollama' }).reason, /EDUTRACE_AI_LOCAL_NAMES/);
  assert.equal(avail({ EDUTRACE_AI_PROVIDER: 'ollama', EDUTRACE_AI_SHARE_NAMES: 'true' }).available, false, 'the remote setting does not open local sharing');
  assert.equal(avail({ EDUTRACE_AI_PROVIDER: 'ollama', EDUTRACE_AI_LOCAL_NAMES: 'true' }).available, true);
  assert.equal(avail({ EDUTRACE_AI_PROVIDER: 'anthropic', EDUTRACE_AI_LOCAL_NAMES: 'true' }).available, false, 'the local setting does not open remote sharing');
  assert.equal(avail({ EDUTRACE_AI_PROVIDER: 'anthropic', EDUTRACE_AI_SHARE_NAMES: 'true' }).available, true);
  assert.equal(createProvider({ env: { EDUTRACE_AI_PROVIDER: 'ollama' } }).status().tasks.match_explanation.available, true, 'match explanations need no names');
});

/* ── API ── */
function call({ method = 'GET', url, headers = {}, json }) {
  return new Promise(resolve => {
    const request = Readable.from(json === undefined ? [] : [JSON.stringify(json)]);
    request.method = method; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator', ...headers };
    const response = new EventEmitter(); let status = 200; let h = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; h = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, json: h['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    server.emit('request', request, response);
  });
}

test('API: resolution, evidence and session filter in the queue; decisions record states and evidence; explain respects scope', async () => {
  resetDemo();
  const list = (await call({ url: '/api/v1/matches' })).json;
  assert.ok(list.data.every(m => m.resolution && m.recommended_action && m.matching_field_count >= 0 && Array.isArray(m.disqualifiers)));
  assert.ok(list.filter_options.sessions.length >= 1);
  const session = list.filter_options.sessions[0];
  assert.deepEqual((await call({ url: `/api/v1/matches?session=${session}` })).json.data.map(m => m.id).sort(), list.data.filter(m => m.sessions.includes(session)).map(m => m.id).sort());
  const detail = (await call({ url: `/api/v1/matches/${list.data[0].id}` })).json.data;
  assert.ok(detail.explanation.policy.conditions.length && detail.explanation.limitations.length && detail.explanation.factors.length);
  assert.match(detail.explanation.score.note, /not a calibrated probability/);

  const candidate = list.data.find(m => m.method === 'name_dob_similarity');
  const explained = await call({ method: 'POST', url: `/api/v1/matches/${candidate.id}/explain` });
  assert.equal(explained.status, 200); assert.equal(explained.json.data.source, 'deterministic', 'no provider configured in tests');
  const outside = list.data.find(m => m.sources.some(s => s.institution_code !== 'NITM'));
  assert.equal((await call({ method: 'POST', url: `/api/v1/matches/${outside.id}/explain`, headers: { 'x-demo-role': 'institution' } })).status, 404);

  const decided = await call({ method: 'POST', url: `/api/v1/matches/${candidate.id}/decision`, json: { decision: 'different_person', note: 'Different guardians on the admission forms.' } });
  assert.equal(decided.status, 200); assert.equal(decided.json.data.match.resolution, 'DIFFERENT_PERSON');
  const stored = Object.values(loadDemo().matchDecisions)[0];
  assert.equal(stored.previous_state, 'POTENTIAL_MATCH'); assert.equal(stored.new_state, 'DIFFERENT_PERSON');
  assert.ok(stored.evidence.agreeing_fields && stored.sources.length === 2 && stored.evidence_key);
  const event = loadDemo().auditEvents.find(e => e.action === 'match_different_person');
  assert.equal(event.from_state, 'POTENTIAL_MATCH'); assert.equal(event.to_state, 'DIFFERENT_PERSON'); assert.equal(event.source_records.length, 2);
});
