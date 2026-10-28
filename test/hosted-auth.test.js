const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp, hostedDemoResponse } = require('../server');
const { createDemoStore } = require('../src/demo-data');
const { createProvider } = require('../src/ai-provider');
const { hostedDemoAuthenticator, authFromEnv, routeRule, ROLES, AuthError } = require('../src/auth');
const { hashPassword, validScryptPasswordHash, LIMITS } = require('../src/accounts');
const { RESOLUTIONS, decideMatch } = require('../src/matches');
const { decideCorrection } = require('../src/lineage');
const { processAll } = require('../src/pipeline');

const TEST_PASSWORD = 'test-only-hosted-viewer-password-2026';
const TEST_HASH = hashPassword(TEST_PASSWORD);
const hostedAuth = options => hostedDemoAuthenticator({ passwordHash: TEST_HASH, secureCookies: true, ...options });
function storeWithReviewStatus(status) {
  const db = createDemoStore().load();
  db.findings.forEach(finding => { finding.review_status = status; });
  return createDemoStore(db);
}

async function withHostedServer(run, options = {}) {
  const auth = hostedAuth(options);
  const app = createApp({ mode: 'demo', store: options.store || createDemoStore(), auth, getProvider: options.getProvider || (() => createProvider({ env: {}, disabled: 'disabled in hosted Demo' })) });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await run({ app, auth, base }); }
  finally { await new Promise(resolve => app.close(resolve)); }
}

test('hosted password configuration accepts only the expected scrypt format and role', () => {
  assert.equal(validScryptPasswordHash(TEST_HASH), true);
  assert.equal(validScryptPasswordHash('not-a-hash'), false);
  assert.equal(validScryptPasswordHash(TEST_HASH.replace('32768', '999999999')), false);
  assert.throws(() => hostedDemoAuthenticator(), /valid configured scrypt password hash/);
  assert.throws(() => authFromEnv({ EDUTRACE_AUTH: 'hosted_demo' }, 'demo'), /EDUTRACE_HOSTED_DEMO_PASSWORD_HASH/);
  assert.throws(() => authFromEnv({ EDUTRACE_AUTH: 'hosted_demo', EDUTRACE_HOSTED_DEMO_PASSWORD_HASH: 'wrong' }, 'demo'), /valid scrypt hash/);
  assert.throws(() => authFromEnv({ EDUTRACE_AUTH: 'hosted_demo', EDUTRACE_HOSTED_DEMO_PASSWORD_HASH: TEST_HASH }, 'development'), /only available with EDUTRACE_MODE=demo/);
  assert.deepEqual(ROLES.hosted_demo_viewer, ['records.read']);
  assert.deepEqual(routeRule('GET', '/api/v1/institutions', { hostedDemo: true }), { public: false, capability: 'records.read' });
  assert.deepEqual(routeRule('POST', '/api/v1/auth/logout', { hostedDemo: true }), { public: false, capability: null });
  assert.deepEqual(routeRule('POST', '/api/v1/runtime'), { public: false, capability: null });
  assert.deepEqual(routeRule('POST', '/api/v1/auth/session'), { public: false, capability: null });
});

test('hosted app construction rejects persistent and unrecognized stores', () => {
  const auth = hostedAuth();
  const persistentStore = { kind: 'json-file', readOnly: false, load() { throw new Error('must not load'); } };
  const forgedMemoryStore = { kind: 'memory', readOnly: true, load() { throw new Error('must not load'); } };
  assert.throws(() => createApp({ mode: 'demo', store: persistentStore, auth }), /recognized synthetic in-memory store/);
  assert.throws(() => createApp({ mode: 'demo', store: forgedMemoryStore, auth }), /recognized synthetic in-memory store/);
  assert.throws(() => createApp({ mode: 'development', store: createDemoStore(), auth }), /requires demo mode/);
  assert.doesNotThrow(() => createApp({ mode: 'demo', store: createDemoStore(), auth }));
});

test('hosted login failures are generic, rate-limited in memory, and recover after the window', () => {
  let time = 1000;
  const auth = hostedAuth({ now: () => time });
  const req = { headers: {}, socket: { remoteAddress: '198.51.100.15' } };
  for (let i = 0; i < 5; i++) {
    const result = auth.login(req, { password: 'wrong password' });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: 'The demo password is not correct.', code: 'invalid_credentials' });
    assert.equal(result.setCookie, undefined);
  }
  const limited = auth.login(req, { password: TEST_PASSWORD });
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, 900);
  time += 15 * 60 * 1000;
  assert.equal(auth.login(req, { password: TEST_PASSWORD }).status, 200);
});

test('hosted HTTP login applies the failure limit and returns Retry-After', async () => {
  await withHostedServer(async ({ base }) => {
    const origin = base;
    const attempt = () => fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'wrong-http-test-password' }) });
    for (let i = 0; i < 5; i++) assert.equal((await attempt()).status, 401);
    const locked = await attempt();
    assert.equal(locked.status, 429);
    const retryAfter = Number(locked.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 900, 'Retry-After reports the remaining part of the 15-minute window');
    assert.equal((await locked.json()).code, 'rate_limited');
  });
});

test('hosted sessions use secure cookies, require CSRF on logout, expire, and can be invalidated', () => {
  let time = 1000;
  const auth = hostedAuth({ now: () => time, limits: { ...LIMITS, idleMs: 1000, absoluteMs: 5000 } });
  const req = { headers: {}, socket: { remoteAddress: 'test-session' } };
  const result = auth.login(req, { password: TEST_PASSWORD });
  assert.equal(result.status, 200);
  assert.match(result.setCookie, /HttpOnly/);
  assert.match(result.setCookie, /SameSite=Strict/);
  assert.match(result.setCookie, /Secure/);
  assert.match(result.setCookie, /Max-Age=5/);
  const cookie = result.setCookie.split(';')[0];
  assert.match(cookie, /^edutrace_session=[A-Za-z0-9_-]{43}$/);
  assert.equal(auth.authenticate({ method: 'GET', headers: { cookie: `edutrace_session=${'A'.repeat(43)}` } }), null, 'a forged random session ID is not recognized');
  const sessionReq = { method: 'GET', headers: { cookie } };
  const principal = auth.authenticate(sessionReq);
  assert.equal(principal.authenticated, true);
  assert.equal(principal.role, 'hosted_demo_viewer');
  assert.deepEqual(principal.capabilities, ['records.read']);
  assert.throws(() => auth.authenticate({ method: 'POST', headers: { cookie } }), error => error instanceof AuthError && error.status === 403 && error.code === 'csrf_failed');
  const session = auth.session(sessionReq);
  assert.ok(session.csrf_token);
  assert.throws(() => auth.authenticate({ method: 'POST', headers: { cookie, 'x-csrf-token': 'incorrect-token' } }), error => error instanceof AuthError && error.status === 403 && error.code === 'csrf_failed');
  const logoutReq = { method: 'POST', headers: { cookie, 'x-csrf-token': session.csrf_token } };
  assert.match(auth.logout(logoutReq), /Max-Age=0/);
  assert.equal(auth.sessionCount(), 0);
  assert.equal(auth.authenticate(sessionReq), null);

  const second = auth.login(req, { password: TEST_PASSWORD });
  const secondReq = { method: 'GET', headers: { cookie: second.setCookie.split(';')[0] } };
  time += 1001;
  assert.equal(auth.authenticate(secondReq), null, 'idle expiry removes the session');
  assert.equal(auth.sessionCount(), 0);

  let absoluteTime = 1000;
  const absoluteAuth = hostedAuth({ now: () => absoluteTime, limits: { ...LIMITS, idleMs: 10000, absoluteMs: 1000 } });
  const absoluteLogin = absoluteAuth.login(req, { password: TEST_PASSWORD });
  const absoluteReq = { method: 'GET', headers: { cookie: absoluteLogin.setCookie.split(';')[0] } };
  absoluteTime += 900;
  assert.ok(absoluteAuth.session(absoluteReq), 'activity before the absolute limit keeps the session alive');
  absoluteTime += 101;
  assert.equal(absoluteAuth.authenticate(absoluteReq), null, 'absolute expiry is not extended by activity');
});

test('hosted HTTP flow gates every protected API, exposes only minimal runtime, and keeps writes forbidden', async () => {
  await withHostedServer(async ({ auth, base }) => {
    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const runtimeResponse = await fetch(`${base}/api/v1/runtime`);
    assert.equal(runtimeResponse.status, 200);
    const runtime = (await runtimeResponse.json()).data;
    assert.deepEqual(Object.keys(runtime).sort(), ['ai_enabled', 'auth', 'data_source', 'mode', 'read_only', 'registration_enabled']);
    assert.deepEqual(runtime, { mode: 'demo', read_only: true, registration_enabled: false, data_source: 'synthetic_in_memory', auth: 'hosted_demo', ai_enabled: false });
    assert.equal(runtimeResponse.headers.get('cache-control'), 'no-store');

    for (const url of ['/api/v1/dashboard/summary', '/api/v1/records', '/api/v1/imports', '/api/v1/ai/status', '/api/v1/institutions', '/api/v1/unknown']) {
      const response = await fetch(`${base}${url}`, { headers: { 'x-demo-role': 'regulator', authorization: 'Bearer forged', cookie: 'role=regulator' } });
      assert.equal(response.status, 401, `${url} requires a server session`);
      assert.equal((await response.json()).code, 'unauthenticated');
    }
    assert.equal((await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);

    const origin = base;
    let serverOutput = '';
    const oldLog = console.log; const oldError = console.error;
    console.log = (...args) => { serverOutput += args.join(' '); };
    console.error = (...args) => { serverOutput += args.join(' '); };
    let wrong;
    const failedAttempt = 'incorrect-password-for-test-only';
    try { wrong = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: failedAttempt }) }); }
    finally { console.log = oldLog; console.error = oldError; }
    assert.equal(wrong.status, 401);
    const wrongBody = await wrong.text();
    assert.equal(wrongBody.includes(failedAttempt), false);
    assert.equal(wrongBody.includes(TEST_HASH), false);
    assert.equal(serverOutput.includes(failedAttempt), false);
    assert.equal(serverOutput.includes(TEST_HASH), false);
    assert.equal(wrong.headers.get('set-cookie'), null);

    const crossOrigin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    assert.equal(crossOrigin.status, 403);
    const extraField = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ username: 'admin', password: TEST_PASSWORD }) });
    assert.equal(extraField.status, 400);
    const wrongType = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'text/plain', origin }, body: TEST_PASSWORD });
    assert.equal(wrongType.status, 415);

    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    assert.equal(login.status, 200);
    assert.equal(login.headers.get('cache-control'), 'no-store');
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const sessionResponse = await fetch(`${base}/api/v1/auth/session`, { headers: { cookie } });
    const session = (await sessionResponse.json()).data;
    assert.equal(session.authenticated, true);
    assert.equal(session.method, 'hosted_demo');
    assert.deepEqual(session.viewer, { display_name: 'Public Synthetic Demo Viewer', role: 'hosted_demo_viewer' });
    assert.ok(session.csrf_token);

    const summary = await fetch(`${base}/api/v1/dashboard/summary`, { headers: { cookie, 'x-demo-role': 'regulator', 'x-demo-institution': 'RCA' } });
    assert.equal(summary.status, 200);
    const body = await summary.json();
    assert.equal(body.principal.authenticated, true);
    assert.equal(body.principal.role, 'hosted_demo_viewer');
    assert.deepEqual(body.principal.capabilities, ['records.read']);
    assert.equal(body.data.institutions, 3);
    assert.equal((await fetch(`${base}/api/v1/ai/status`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/v1/reports/findings.csv`, { headers: { cookie } })).status, 403);

    for (const url of ['/api/v1/demo/reset', '/api/v1/imports/confirm', '/api/v1/auth/register']) {
      for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', cookie, 'x-csrf-token': session.csrf_token }]) {
        const response = await fetch(`${base}${url}`, { method: 'POST', headers, body: '{}' });
        assert.equal(response.status, 403, `${url} stays forbidden with and without a session`);
        assert.equal((await response.json()).code, 'read_only_demo');
      }
    }

    const badLogout = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' });
    assert.equal(badLogout.status, 403);
    assert.equal((await badLogout.json()).code, 'csrf_failed');
    const logout = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': session.csrf_token }, body: '{}' });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal(auth.sessionCount(), 0);
    assert.equal((await (await fetch(`${base}/api/v1/auth/session`, { headers: { cookie } })).json()).data.authenticated, false);
    assert.equal((await fetch(`${base}/api/v1/dashboard/summary`, { headers: { cookie } })).status, 401);
  });
});

test('hosted viewer response filtering recursively removes audit, decision and AI metadata while retaining synthetic records', async () => {
  const markers = [
    'HOSTED_AUDIT_ACTOR_MARKER', 'HOSTED_REVIEWER_NOTE_MARKER', 'HOSTED_DECISION_MARKER',
    'HOSTED_RECEIPT_MARKER', 'HOSTED_AI_OUTPUT_MARKER', 'HOSTED_MODEL_MARKER', 'HOSTED_PROVIDER_MARKER'
  ];
  const db = createDemoStore().load();
  for (const event of db.auditEvents || []) Object.assign(event, {
        actor: markers[0], reviewer: markers[0], note: markers[1], reviewer_note: markers[1],
        receipt_id: markers[3], internal_comment: markers[1]
      });
      for (const finding of db.findings || []) {
        finding.decision = { outcome: markers[2], decision: markers[2], reviewer: markers[0], note: markers[1], receipt_id: markers[3], history: [{ note: markers[1] }] };
        finding.assist = { explanation: { text: markers[4], provenance: { model: markers[5] }, cache_key: markers[5] }, candidate_assessment: { assessment: markers[4], provenance: { model: markers[5] } } };
      }
      for (const decision of Object.values(db.matchDecisions || {})) Object.assign(decision, { decision: 'different_person', decision_marker: markers[2], reviewer: markers[0], note: markers[1], receipt_id: markers[3], history: [{ note: markers[1] }] });
      const reviewableLink = db.identityLinks.find(item => ['candidate_for_review', 'needs_investigation'].includes(item.outcome));
      if (reviewableLink) db.matchDecisions[reviewableLink.evidence_key || reviewableLink.key] = {
        decision: 'same_person', reviewer: 'HOSTED_PROFILE_DECISION_MARKER', note: 'HOSTED_MATCH_EXPLANATION_DECISION_MARKER',
        at: '2026-01-01T00:00:00.000Z', evidence_key: reviewableLink.evidence_key, records: [...reviewableLink.records]
      };
      for (const history of db.identityLinkEvents || []) history.basis = 'HOSTED_REVIEWER_HISTORY_BASIS_MARKER';
      for (const event of db.lineageEvents || []) Object.assign(event, { actor: markers[0], note: markers[1], reviewer_note: markers[1] });
  const store = createDemoStore(db);
  const provider = {
    status: () => ({ provider: markers[6], model: markers[5], configured: true, health: { detail: markers[4] }, data_policy: markers[5], tasks: {} }),
    check: async () => ({ provider: markers[6], model: markers[5] })
  };
  const initial = store.load();
  const finding = initial.findings.find(item => item.evidence?.length);
  const recordId = finding.evidence[0];
  const match = initial.identityLinks.find(item => ['candidate_for_review', 'needs_investigation'].includes(item.outcome));
  assert.ok(match, 'fixture has a reviewable synthetic match');

  await withHostedServer(async ({ base }) => {
    const origin = base;
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const spoof = { cookie, 'x-csrf-token': 'irrelevant-for-GET', 'x-demo-role': 'regulator', 'x-demo-institution': 'FORGED', authorization: 'Bearer forged' };
    const originalResolutionLabel = RESOLUTIONS.SAME_PERSON_CONFIRMED;
    RESOLUTIONS.SAME_PERSON_CONFIRMED = 'HOSTED_RESOLUTION_LABEL_MARKER';
    const paths = [
      '/api/v1/dashboard/summary', '/api/v1/imports', '/api/v1/records',
      `/api/v1/findings/${finding.id}`, `/api/v1/records/${recordId}`,
      `/api/v1/identities/${recordId}/history`, `/api/v1/matches/${match.id}`,
      `/api/v1/profiles/${recordId}`, `/api/v1/matches`, `/api/v1/findings`,
      `/api/v1/findings/${finding.id}/explanation`, `/api/v1/records/${recordId}/lineage`,
      `/api/v1/records/${recordId}/verification`, `/api/v1/evidence/checklist?finding=${finding.id}`,
      '/api/v1/corrections', '/api/v1/notifications', '/api/v1/graph', '/api/v1/integrations', '/api/v1/automation'
    ];
    const decisionMarkers = [
      'HOSTED_RESOLUTION_OUTCOME_MARKER', 'HOSTED_RESOLUTION_LABEL_MARKER', 'HOSTED_RECOMMENDED_ACTION_MARKER',
      'HOSTED_RECOMMENDATION_MARKER', 'HOSTED_REVIEWER_HISTORY_BASIS_MARKER', 'HOSTED_PROFILE_DECISION_MARKER',
      'HOSTED_MATCH_EXPLANATION_DECISION_MARKER'
    ];
    const projected = hostedDemoResponse({
      safe: { record_id: 'SYNTHETIC-RECORD-1', neutral_explanation: 'Names are similar and dates of birth agree.' },
      findings: [{ resolution: decisionMarkers[0], resolution_label: decisionMarkers[1], recommended_action: decisionMarkers[2], recommendation: decisionMarkers[3], basis: decisionMarkers[4], explanation: `A reviewer recorded ${decisionMarkers[6]} as the same person.` }],
      nested: [[{ current_status: 'resolved', text: 'A reviewer recorded these records as the same person.' }]]
    });
    const projectedText = JSON.stringify(projected);
    for (const marker of decisionMarkers) assert.equal(projectedText.includes(marker), false, `nested projection omits ${marker}`);
    assert.equal(projectedText.includes('reviewer recorded'), false, 'reviewer decision prose is replaced with neutral text');
    assert.equal(projected.safe.record_id, 'SYNTHETIC-RECORD-1', 'safe synthetic fields are retained');
    assert.equal(projected.safe.neutral_explanation, 'Names are similar and dates of birth agree.', 'neutral matching explanation is retained');
    try {
    for (const path of paths) {
      const response = await fetch(`${base}${path}`, { headers: spoof });
      assert.equal(response.status, 200, `${path} remains available for safe demo reads`);
      const text = await response.text();
      for (const marker of [...markers, ...decisionMarkers]) assert.equal(text.includes(marker), false, `${path} omits ${marker}`);
      const payload = JSON.parse(text);
      assert.ok(payload.data, `${path} retains useful synthetic data`);
      for (const key of ['audit', 'audit_events', 'decision', 'decision_marker', 'decisions', 'history', 'timeline', 'reviewer', 'actor', 'note', 'receipt_id', 'ai', 'assist', 'provenance', 'model', 'provider']) {
        assert.equal(hasKey(payload, key), false, `${path} omits nested ${key}`);
      }
    }
    const record = await (await fetch(`${base}/api/v1/records/${recordId}`, { headers: spoof })).json();
    assert.ok(record.data.original, 'record detail remains useful after private fields are removed');
    const matchResponse = await (await fetch(`${base}/api/v1/matches/${match.id}`, { headers: spoof })).json();
    assert.ok(matchResponse.data.explanation.why, 'neutral matching explanation remains available');
    assert.match(matchResponse.data.explanation.why, /records|identifier|name/i);
    assert.equal(Object.hasOwn(matchResponse.data.explanation, 'recommendation'), false, 'decision-sensitive recommendation is projected out');
    assert.ok((await (await fetch(`${base}/api/v1/records`, { headers: spoof })).json()).data.length, 'synthetic record list remains available');
    const automation = await (await fetch(`${base}/api/v1/automation`, { headers: spoof })).json();
    assert.equal(Object.hasOwn(automation.data, 'ai'), false);
    assert.equal(Object.hasOwn(automation.data, 'assistance'), false);
    const institutions = await fetch(`${base}/api/v1/institutions`, { headers: spoof });
    assert.equal(institutions.status, 404, 'a valid hosted session reaches the route, which remains unavailable while registration is disabled');
    for (const path of ['/api/v1/audit', '/api/v1/receipts/RCPT-marker', '/api/v1/reports/findings.csv', '/api/v1/ai/status']) {
      assert.equal((await fetch(`${base}${path}`, { headers: spoof })).status, 403, `${path} remains denied`);
    }
    const reset = await fetch(`${base}/api/v1/demo/reset`, { method: 'POST', headers: { ...spoof, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(reset.status, 403, 'mutations remain blocked despite spoofed privilege headers');
    } finally { RESOLUTIONS.SAME_PERSON_CONFIRMED = originalResolutionLabel; }
  }, { store, getProvider: () => provider });
});

test('hosted status filters and aggregates are invariant to decision state', async () => {
  const statusA = storeWithReviewStatus('resolved');
  const statusB = storeWithReviewStatus('pending');
  let baselineDashboard; let baselineAutomation;
  await withHostedServer(async ({ base }) => {
    const origin = base;
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const headers = { cookie, 'x-demo-role': 'regulator', 'x-demo-institution': 'RCA', authorization: 'Bearer forged', 'x-http-method-override': 'POST' };
    const get = async path => { const response = await fetch(`${base}${path}`, { headers }); assert.equal(response.status, 200, path); return response.text(); };

    const baselineFindings = JSON.parse(await get('/api/v1/findings'));
    assert.ok(baselineFindings.total > 0);
    assert.equal(baselineFindings.total, baselineFindings.data.length);
    assert.ok(baselineFindings.data.some(finding => finding.title && finding.severity), 'safe finding data remains available');
    assert.equal(Object.hasOwn(baselineFindings.filter_options, 'statuses'), false, 'review state choices are not exposed');
    const findingIds = baselineFindings.data.map(finding => finding.id);
    const statusQueries = [
      '?status=resolved', '?status=RESOLVED', '?status=awaiting_verification', '?status=pending',
      '?status=resolved&status=pending', '?status=pending&status=resolved', '?review_status=resolved',
      '?status=resolved&severity=high&offset=0&limit=1'
    ];
    for (const query of statusQueries) {
      const result = JSON.parse(await get(`/api/v1/findings${query}`));
      const expected = query.includes('severity=high') ? JSON.parse(await get('/api/v1/findings?severity=high')) : baselineFindings;
      assert.deepEqual(result, expected, `status cannot change response totals or subsets: ${query}`);
      assert.deepEqual(result.data.map(finding => finding.id), query.includes('severity=high') ? expected.data.map(finding => finding.id) : findingIds);
    }

    const baselineMatches = JSON.parse(await get('/api/v1/matches'));
    assert.ok(baselineMatches.total > 0);
    assert.equal(Object.hasOwn(baselineMatches, 'counts'), false);
    assert.equal(Object.hasOwn(baselineMatches.filter_options, 'statuses'), false);
    for (const query of ['?status=needs_review', '?status=needs_more_evidence', '?status=same_person', '?status=different_person', '?status=DIFFERENT_PERSON&status=needs_review']) {
      assert.deepEqual(JSON.parse(await get(`/api/v1/matches${query}`)), baselineMatches, `match status cannot alter the hosted response: ${query}`);
    }

    const baselineGraph = JSON.parse(await get('/api/v1/graph'));
    assert.equal(Object.hasOwn(baselineGraph.data.filters, 'statuses'), false);
    assert.equal(baselineGraph.data.edges.some(edge => ['confirmed', 'rejected'].includes(edge.type)), false);
    assert.deepEqual(JSON.parse(await get('/api/v1/graph?status=resolved')), baselineGraph);

    const baselineCorrections = JSON.parse(await get('/api/v1/corrections'));
    assert.equal(Object.hasOwn(baselineCorrections, 'pending'), false);
    assert.ok(baselineCorrections.data.every(candidate => !Object.hasOwn(candidate, 'status') && !Object.hasOwn(candidate, 'decided_by')));
    assert.deepEqual(JSON.parse(await get('/api/v1/corrections?status=all&status=pending')), baselineCorrections);

    baselineDashboard = JSON.parse(await get('/api/v1/dashboard/summary'));
    const dashboardText = JSON.stringify(baselineDashboard);
    for (const key of ['by_status', 'open_findings', 'pending_decisions']) assert.equal(Object.hasOwn(baselineDashboard.data, key), false, `dashboard omits ${key}`);
    assert.equal(Object.hasOwn(baselineDashboard.data.automation, 'open_exceptions'), false, 'status-derived exception aggregates are omitted');
    for (const key of ['automatic_rate', 'rate_definition', 'automatically_resolved']) assert.equal(Object.hasOwn(baselineDashboard.data.automation, key), false, `dashboard omits decision-sensitive automation field ${key}`);
    assert.ok(baselineDashboard.data.imported_records > 0, 'safe dashboard metrics remain available');
    assert.ok(baselineDashboard.data.automation?.by_status && typeof baselineDashboard.data.automation.by_status === 'object', `record-processing chart remains available (${JSON.stringify(Object.keys(baselineDashboard.data.automation || {}))})`);
    assert.ok(dashboardText.includes('accessible_findings'), 'safe current finding total remains available');
    baselineAutomation = JSON.parse(await get('/api/v1/automation'));
    for (const key of ['open_exceptions', 'automatic_rate', 'rate_definition', 'automatically_resolved']) assert.equal(Object.hasOwn(baselineAutomation.data, key), false, `standalone automation omits decision-sensitive field ${key}`);
  }, { store: statusA });

  await withHostedServer(async ({ base }) => {
    const origin = base;
    const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await fetch(`${base}/api/v1/dashboard/summary`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), baselineDashboard, 'dashboard is invariant when every finding changes review state');
    const automation = await fetch(`${base}/api/v1/automation`, { headers: { cookie } });
    assert.deepEqual(await automation.json(), baselineAutomation, 'automation aggregates are invariant when every finding changes review state');
  }, { store: statusB });
});

test('hosted read responses are invariant to identity and correction decisions', async () => {
  const principal = { role: 'regulator', scope: 'all', institution_code: null, name: 'Synthetic regression reviewer' };
  const base = createDemoStore().load();
  const undecidedLink = base.identityLinks.find(link =>
    ['candidate_for_review', 'needs_investigation'].includes(link.outcome) &&
    !base.matchDecisions[link.evidence_key || link.key]
  );
  const pendingCorrection = base.correctionCandidates.find(candidate => candidate.status === 'pending');
  assert.ok(undecidedLink, 'fixture contains a reviewable identity link without a decision');
  assert.ok(pendingCorrection, 'fixture contains an unconfirmed correction');
  const paths = [
    `/api/v1/profiles/${undecidedLink.records[0]}`,
    `/api/v1/identities/${undecidedLink.records[0]}/history`,
    '/api/v1/corrections',
    '/api/v1/records?versions=all&offset=0&limit=200',
    `/api/v1/records/${pendingCorrection.earlier}`,
    `/api/v1/records/${pendingCorrection.earlier}/lineage`,
    '/api/v1/dashboard/summary', '/api/v1/automation', '/api/v1/findings',
    '/api/v1/matches', '/api/v1/graph', '/api/v1/notifications', '/api/v1/imports'
  ];
  async function readHostedResponses(store) {
    const responses = {};
    await withHostedServer(async ({ base: origin }) => {
      const login = await fetch(`${origin}/api/v1/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ password: TEST_PASSWORD })
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const headers = {
        cookie, 'x-demo-role': 'regulator', 'x-demo-institution': 'FORGED',
        authorization: 'Bearer forged', 'x-http-method-override': 'POST'
      };
      for (const path of paths) {
        const response = await fetch(`${origin}${path}`, { headers });
        assert.equal(response.status, 200, path);
        responses[path] = await response.text();
      }
    }, { store });
    return responses;
  }

  const baseResponses = await readHostedResponses(createDemoStore(base));

  const identityDecision = structuredClone(base);
  const chosenLink = identityDecision.identityLinks.find(link => link.id === undecidedLink.id);
  decideMatch(identityDecision, principal, chosenLink.id, {
    decision: 'same_person', confirm: true, note: 'Synthetic decision-isolation fixture'
  });
  processAll(identityDecision, { at: '2026-10-28T00:00:00.000Z', reason: 'synthetic fixture', origin: 'test' });
  assert.equal(identityDecision.matchDecisions[chosenLink.evidence_key || chosenLink.key].decision, 'same_person');
  assert.notDeepEqual(identityDecision.matchDecisions, base.matchDecisions, 'fixture changes the identity-decision state');
  assert.deepEqual(await readHostedResponses(createDemoStore(identityDecision)), baseResponses,
    'complete hosted responses do not reveal a same_person decision');

  const correctionDecision = structuredClone(base);
  const candidate = correctionDecision.correctionCandidates.find(item => item.id === pendingCorrection.id);
  decideCorrection(correctionDecision, principal, candidate.id, {
    decision: 'confirm', confirm: true, note: 'Synthetic correction-isolation fixture'
  });
  processAll(correctionDecision, { at: '2026-10-28T00:00:00.000Z', reason: 'after synthetic correction', origin: 'test' });
  assert.equal(candidate.status, 'confirmed');
  assert.ok(correctionDecision.sourceRecords.find(record => record.id === candidate.earlier).superseded_by,
    'fixture creates the active/superseded state that previously changed hosted responses');
  assert.deepEqual(await readHostedResponses(createDemoStore(correctionDecision)), baseResponses,
    'complete hosted responses do not reveal correction confirmation or its derived state');

  const hostedRecords = JSON.parse(baseResponses['/api/v1/records?versions=all&offset=0&limit=200']);
  assert.equal(hostedRecords.total, base.sourceRecords.length, 'all synthetic source rows remain available through pagination');
  assert.equal(hostedRecords.data.length, Math.min(200, hostedRecords.total), 'the records endpoint applies its documented page-size cap');
  const hostedProfile = JSON.parse(baseResponses[paths[0]]);
  assert.ok(hostedProfile.data.attributes.length > 0, 'hosted profile retains useful synthetic attributes');
});

test('hosted process restart invalidates sessions held by the previous authenticator', async () => {
  const firstAuth = hostedAuth();
  const firstApp = createApp({ mode: 'demo', store: createDemoStore(), auth: firstAuth });
  await new Promise(resolve => firstApp.listen(0, '127.0.0.1', resolve));
  const firstBase = `http://127.0.0.1:${firstApp.address().port}`;
  let cookie;
  try {
    const login = await fetch(`${firstBase}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: firstBase }, body: JSON.stringify({ password: TEST_PASSWORD }) });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${firstBase}/api/v1/dashboard/summary`, { headers: { cookie } })).status, 200);
  } finally { await new Promise(resolve => firstApp.close(resolve)); }

  const restartedApp = createApp({ mode: 'demo', store: createDemoStore(), auth: hostedAuth() });
  await new Promise(resolve => restartedApp.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${restartedApp.address().port}/api/v1/dashboard/summary`, { headers: { cookie } });
    assert.equal(response.status, 401, 'fresh process-local session state does not recognize the old cookie');
  } finally { await new Promise(resolve => restartedApp.close(resolve)); }
});

test('authorized non-hosted automation responses retain AI status and assistance details', async () => {
  const provider = { status: () => ({ provider: 'local-test-provider', configured: true }), check: async () => ({ ok: true }) };
  const app = createApp({ mode: 'development', store: createDemoStore(), getProvider: () => provider });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/automation`, { headers: { 'x-demo-role': 'regulator' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.ai, { provider: 'local-test-provider', configured: true });
    assert.ok(body.data.assistance);
    assert.equal(typeof body.data.assistance.rule_findings, 'number');
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test('authorized non-hosted match responses retain reviewer decision fields', async () => {
  const source = createDemoStore();
  const initial = source.load();
  const link = initial.identityLinks.find(item => ['candidate_for_review', 'needs_investigation'].includes(item.outcome));
  const store = {
    ...source,
    load() {
      const db = source.load();
      db.matchDecisions[link.evidence_key || link.key] = {
        decision: 'same_person', reviewer: 'Authorized Test Reviewer', note: 'Confirmed after reviewing source documents.',
        at: '2026-01-01T00:00:00.000Z', evidence_key: link.evidence_key, records: [...link.records]
      };
      return db;
    }
  };
  const app = createApp({ mode: 'development', store });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/matches/${link.id}`, { headers: { 'x-demo-role': 'regulator' } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.match.resolution, 'SAME_PERSON_CONFIRMED');
    assert.equal(body.data.match.resolution_label, 'Same person (reviewer)');
    assert.match(body.data.explanation.recommendation, /reviewer recorded/i);
    assert.equal(body.data.decision.reviewer, 'Authorized Test Reviewer');
  } finally { await new Promise(resolve => app.close(resolve)); }
});

test('authorized non-hosted findings status filtering and dashboard aggregates remain intact', async () => {
  const store = storeWithReviewStatus('resolved');
  const app = createApp({ mode: 'development', store });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${app.address().port}`;
    const headers = { 'x-demo-role': 'regulator' };
    const dashboard = await (await fetch(`${base}/api/v1/dashboard/summary`, { headers })).json();
    assert.ok(Array.isArray(dashboard.data.by_status));
    assert.ok(Object.hasOwn(dashboard.data, 'open_findings'));
    assert.ok(Object.hasOwn(dashboard.data.automation, 'open_exceptions'));
    const resolved = await (await fetch(`${base}/api/v1/findings?status=resolved`, { headers })).json();
    assert.ok(resolved.total > 0);
    assert.ok(resolved.data.every(finding => finding.review_status === 'resolved'));
    assert.ok(Object.hasOwn(resolved.filter_options, 'statuses'));
  } finally { await new Promise(resolve => app.close(resolve)); }
});

function hasKey(value, target) {
  if (Array.isArray(value)) return value.some(item => hasKey(item, target));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, item]) => key.toLowerCase() === target || hasKey(item, target));
}
