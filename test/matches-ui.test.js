const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { createApp } = require('../server');
const { createDemoStore } = require('../src/demo-data');
const { hostedDemoAuthenticator } = require('../src/auth');
const { hashPassword } = require('../src/accounts');
const { createProvider } = require('../src/ai-provider');

const TEST_PASSWORD = 'matches-ui-hosted-test-password';
const TEST_HASH = hashPassword(TEST_PASSWORD);

function browserHarness({ auth, response, failRendering = false }) {
  const matchesSource = fs.readFileSync(require.resolve('../public/matches.js'), 'utf8');
  const appSource = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
  const queueStatusBadge = matchesSource.slice(matchesSource.indexOf('const mxQueueStatusBadge ='), matchesSource.indexOf('const mxMethodBadge ='));
  const matchFunctions = matchesSource.slice(matchesSource.indexOf('function mxParams()'), matchesSource.indexOf('function mxSyncUrl()'))
    + matchesSource.slice(matchesSource.indexOf('async function mxLoadList()'), matchesSource.indexOf('function mxSelect('));
  const countFunction = appSource.slice(appSource.indexOf('async function refreshMatchCount('), appSource.indexOf('async function resetDemo('));
  const fields = ['institution', 'status', 'conflict', 'evidence', 'method', 'session'].map(param => ({
    dataset: { param }, value: '', hidden: false, options: [{ outerHTML: '<option value="">Any</option>' }],
    innerHTML: '', closest: () => fieldWrappers[param]
  }));
  const fieldWrappers = Object.fromEntries(fields.map(field => [field.dataset.param, { hidden: false }]));
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', dataset: {}, hidden: false, textContent: '', innerHTML: '', options: [{ outerHTML: '<option value="">Any</option>' }],
      attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; }, addEventListener() {},
      closest() { return fieldWrappers[id.slice(1)]; }
    });
    return elements.get(id);
  };
  const apiCalls = [];
  const context = {
    state: { auth },
    mx: { data: null, selected: null, detail: null, listToken: 0 },
    MX_PARAMS: ['q', 'institution', 'status', 'method', 'conflict', 'evidence', 'session'],
    MX_NARROW: { matches: true },
    MX_STATUS: { needs_review: { label: 'Needs review', icon: 'clock', cls: 'st-pending' }, needs_more_evidence: { label: 'Needs more evidence', icon: 'hourglass', cls: 'st-awaiting_verification' } },
    MX_FIELD: {}, MX_METHOD: { protected_identifier_exact: 'Shared identifier' },
    $: selector => selector === '#mxFilters [data-param]' ? null
      : selector === '#mxStatus' ? fields[1]
        : selector === '#mxInstitution' ? fields[0]
          : selector === '#mxConflict' ? fields[2]
            : selector === '#mxEvidence' ? fields[3]
              : selector === '#mxMethod' ? fields[4]
                : selector === '#mxSession' ? fields[5]
                  : element(selector),
    $$: selector => selector === '#mxFilters [data-param]' ? fields : [],
    api: async path => { apiCalls.push(path); return response; },
    refreshMatchCount: undefined,
    skeletonLines: () => '<span class="skeleton"></span>',
    errorState: message => `<div class="error">${message}</div>`,
    plural: (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`,
    esc: value => failRendering ? (() => { throw new Error('simulated renderer failure'); })() : String(value ?? '').replace(/[&<>"']/g, ''),
    icon: name => `<i>${name}</i>`,
    mxStatusBadge: status => `<b>${({ needs_review: 'Needs review', needs_more_evidence: 'Needs more evidence' })[status] || status || 'Unknown status'}</b>`,
    mxMethodBadge: (_kind, label) => `<b>${label}</b>`,
    mxSourceLine: sources => sources.map(source => source.institution_code).join(' ↔ '),
    mxFieldTags: () => '',
    emptyState: () => '<div>empty</div>',
    mxRenderDetail() {}, mxLoadDetail() {}, mxLayoutMode() {},
    URLSearchParams, encodeURIComponent
  };
  vm.createContext(context);
  vm.runInContext(`${queueStatusBadge}\n${matchFunctions}\n${countFunction}\nfunction mxRenderDetail() {}\nfunction mxLoadDetail() {}\nfunction mxLayoutMode() {}\nfor (const name of ['mxParams', 'mxFillFilters', 'mxRenderChips', 'mxRenderList', 'refreshMatchCount']) { const original = globalThis[name]; globalThis[name] = (...args) => { try { return original(...args); } catch (error) { globalThis.renderFailure = error.stack; throw error; } }; }\nglobalThis.load = mxLoadList; globalThis.renderList = mxRenderList;`, context);
  // Use the real count-refresh implementation, while retaining a call log for fallback detection.
  context.api = async path => { apiCalls.push(path); return response; };
  return { context, apiCalls, fields, fieldWrappers, element };
}

async function withHostedApp(run) {
  const auth = hostedDemoAuthenticator({ passwordHash: TEST_HASH, secureCookies: false });
  const app = createApp({ mode: 'demo', store: createDemoStore(), auth, getProvider: () => createProvider({ env: {}, disabled: 'disabled in hosted Demo' }) });
  const login = auth.login({ headers: {}, socket: { remoteAddress: 'hosted-ui-test' } }, { password: TEST_PASSWORD });
  assert.equal(login.status, 200);
  const cookie = login.setCookie.split(';')[0];
  const matchesResponse = await new Promise(resolve => {
    const request = Readable.from([]);
    request.method = 'GET'; request.url = '/api/v1/matches'; request.headers = { host: 'localhost', cookie };
    request.socket = { remoteAddress: 'hosted-ui-test' };
    const response = new EventEmitter(); let status = 200; let headers = {}; const chunks = [];
    response.writeHead = (code, values) => { status = code; headers = values; };
    response.end = value => { if (value) chunks.push(value); const text = chunks.join(''); resolve({ status, text, json: headers['Content-Type']?.includes('json') ? JSON.parse(text) : undefined }); };
    app.emit('request', request, response);
  });
  assert.equal(matchesResponse.status, 200);
  await run({ response: matchesResponse.json });
}

test('hosted-safe matches response renders through the list flow without status data or fallback count request', async () => {
  await withHostedApp(async ({ response }) => {
    assert.equal(Object.hasOwn(response, 'counts'), false);
    assert.equal(Object.hasOwn(response.filter_options, 'statuses'), false);
    assert.ok(response.data.length > 0);
    assert.equal(Object.hasOwn(response.data[0], 'status'), false);

    const harness = browserHarness({ auth: 'hosted_demo', response });
    await harness.context.load();
    const list = harness.element('#mxList');
    assert.equal(list.attributes['aria-busy'], undefined, 'list loading state is always cleared');
    assert.match(list.innerHTML, /mx-item-label/, harness.context.renderFailure);
    assert.match(list.innerHTML, /Potential match/);
    assert.doesNotMatch(list.innerHTML, /undefined|Needs review|Same person|Different people/);
    assert.equal(harness.element('#mxCount').textContent, `${response.total} potential matches`);
    assert.equal(harness.apiCalls.length, 1, 'the list request is the only API request; absent counts do not trigger a fallback');
    assert.equal(harness.fieldWrappers.status.hidden, true, 'decision status filter is hidden in hosted mode');
    assert.equal(harness.fields[1].value, '', 'a stale status selection is cleared');
  });
});

test('matches loading failure clears busy state and shows a useful retry error', async () => {
  const response = { data: [{ id: 'synthetic-1' }], total: 1, filter_options: {} };
  const harness = browserHarness({ auth: 'hosted_demo', response, failRendering: true });
  await harness.context.load();
  assert.equal(harness.element('#mxList').attributes['aria-busy'], undefined);
  assert.match(harness.element('#mxList').innerHTML, /could not be displayed/);
  assert.equal(harness.element('#mxCount').textContent, '');
});

test('non-hosted matches retain status filters, decision badges and aggregate counts', async () => {
  const response = {
    total: 2, counts: { needs_review: 1, needs_more_evidence: 1 },
    filter_options: { institutions: [], statuses: ['needs_review'], conflicts: [], evidence: [], methods: [], sessions: [] },
    data: [{ id: 'synthetic-1', display_label: 'Synthetic pair', status: 'needs_review', method: 'protected_identifier_exact', method_kind: 'exact', sources: [], agreeing_fields: [], conflicting_fields: [], missing_fields: [], disqualifiers: [], matching_field_count: 3, why: 'Synthetic explanation', recommended_action: 'Review evidence', copies: 1 }]
  };
  const harness = browserHarness({ auth: 'demo_header', response });
  await harness.context.load();
  assert.equal(harness.fieldWrappers.status.hidden, false);
  assert.match(harness.fields[1].innerHTML, /needs_review/);
  assert.match(harness.element('#mxList').innerHTML, /Needs review/);
  assert.match(harness.element('#mxCount').textContent, /1 need review, 1 waiting for evidence/);
});
