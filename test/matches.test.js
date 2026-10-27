require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server, setProvider } = require('../server');
const { resetDemo, loadDemo } = require('../src/seed');
const { createProvider } = require('../src/ai-provider');

/* Every request goes through the real request handler on a throwaway database; no model is called. */
setProvider(createProvider({ env: {} }));
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
const institution = { 'x-demo-role': 'institution' };
// A leaked identifier is a standalone 12-digit value; random UUID segments inside ids are not.
const FULL_ID = /(?<![\w-])\d{12}(?![\w-])/;

test('the potential-matches queue lists real reviewable links only, scoped to the principal, with masked labels', async () => {
  resetDemo();
  const db = loadDemo();
  const reviewable = db.identityLinks.filter(l => ['candidate_for_review', 'needs_investigation'].includes(l.outcome));
  const regulator = (await call({ url: '/api/v1/matches' })).json;
  assert.equal(regulator.total, reviewable.length);
  assert.deepEqual(regulator.data.map(m => m.id).sort(), reviewable.map(l => l.id).sort());
  assert.ok(regulator.data.every(m => m.status === 'needs_review' && m.sources.length === 2 && m.why));
  for (const m of regulator.data) {
    const names = m.sources.map(s => db.sourceRecords.find(r => r.id === s.record_id).student_name);
    assert.ok(!names.some(name => m.display_label.includes(name)), 'queue labels never show a full name');
  }
  assert.doesNotMatch(JSON.stringify(regulator), FULL_ID, 'no full identifier anywhere in the queue');

  const nitm = (await call({ url: '/api/v1/matches', headers: institution })).json;
  assert.ok(nitm.total < regulator.total, 'cross-institution pairs are hidden from an institution user');
  assert.ok(nitm.data.every(m => m.sources.every(s => s.institution_code === 'NITM')));
  const hidden = regulator.data.find(m => m.sources.some(s => s.institution_code !== 'NITM'));
  assert.equal((await call({ url: `/api/v1/matches/${hidden.id}`, headers: institution })).status, 404);
  assert.equal((await call({ method: 'POST', url: `/api/v1/matches/${hidden.id}/decision`, headers: institution, json: { decision: 'different_person', note: 'x' } })).status, 404);
});

test('queue filters by institution, status, conflict type, matching evidence, method and search', async () => {
  resetDemo();
  const all = (await call({ url: '/api/v1/matches' })).json.data;
  const get = async query => (await call({ url: `/api/v1/matches?${query}` })).json.data.map(m => m.id).sort();
  const ids = list => list.map(m => m.id).sort();
  assert.deepEqual(await get('institution=SVU'), ids(all.filter(m => m.sources.some(s => s.institution_code === 'SVU'))));
  assert.deepEqual(await get('conflict=date_of_birth'), ids(all.filter(m => m.conflicting_fields.includes('date_of_birth'))));
  assert.deepEqual(await get('conflict=missing'), ids(all.filter(m => m.conflicting_fields.includes('missing') || m.missing_fields.length)));
  assert.deepEqual(await get('evidence=identifier'), ids(all.filter(m => m.agreeing_fields.includes('identifier'))));
  assert.deepEqual(await get('method=name_dob_similarity'), ids(all.filter(m => m.method === 'name_dob_similarity')));
  assert.deepEqual(await get('status=same_person'), []);
  const candidate = all.find(m => m.method === 'name_dob_similarity');
  const name = loadDemo().sourceRecords.find(r => r.id === candidate.sources[0].record_id).student_name;
  assert.deepEqual(await get(`q=${encodeURIComponent(name.toUpperCase())}`), [candidate.id], 'authorised search by name');
  assert.deepEqual(await get(`q=${encodeURIComponent(candidate.sources[1].source_file)}`).then(r => r.includes(candidate.id)), true);
  assert.deepEqual(await get('q=nobody-matches-this'), []);
});

test('the comparison never shows a missing value as a match, masks identifiers and never claims verification', async () => {
  resetDemo();
  const all = (await call({ url: '/api/v1/matches' })).json.data;
  for (const m of all) {
    const detail = (await call({ url: `/api/v1/matches/${m.id}` })).json.data;
    assert.doesNotMatch(JSON.stringify(detail), FULL_ID);
    assert.doesNotMatch(JSON.stringify(detail), /"verification":"verified"|authentically verified/i);
    for (const field of detail.fields) {
      const a = field.reference.value; const b = field.incoming.value;
      if (!a || !b) assert.match(field.state, /^missing_/, `${field.key} with a missing side is not a match`);
      if (field.state === 'agree') assert.ok(a && b);
      assert.ok(field.reference.source.source_row && field.incoming.source.source_file, 'every value carries its source');
    }
    const apaar = detail.fields.find(f => f.key === 'apaar_id');
    assert.equal(apaar.reference.verification, 'not_verified'); assert.equal(apaar.incoming.verification, 'not_verified');
    assert.match(apaar.note, /never verified/);
    // Field states agree with the persisted link.
    for (const conflict of m.conflicting_fields) assert.equal(detail.fields.find(f => f.key === (conflict === 'identifier' ? 'apaar_id' : conflict)).state, 'conflict');
    if (m.missing_fields.includes('identifier')) assert.match(apaar.state, /^missing_/);
    assert.match(detail.explanation.score.note, /not a calibrated probability/);
    assert.ok(detail.explanation.recommendation && detail.explanation.method_label);
    assert.match(detail.ai.effect, /Advisory only/);
    assert.equal(detail.fields.find(f => f.key === 'institution_code').state === 'conflict', false, 'a different institution is context, not a conflict');
  }
});

test('review decisions: validated transitions, confirmation for "same person", audit history and finding status', async () => {
  resetDemo();
  const candidate = (await call({ url: '/api/v1/matches?method=name_dob_similarity' })).json.data[0];
  const url = `/api/v1/matches/${candidate.id}/decision`;
  assert.equal((await call({ method: 'POST', url, json: { decision: 'merge', note: 'x' } })).status, 400);
  assert.equal((await call({ method: 'POST', url, json: { decision: 'different_person', note: '  ' } })).status, 400);
  const unconfirmed = await call({ method: 'POST', url, json: { decision: 'same_person', note: 'Same transcript.' } });
  assert.equal(unconfirmed.status, 400); assert.match(unconfirmed.json.error, /explicit confirmation/);

  const evidence = await call({ method: 'POST', url, json: { decision: 'needs_more_evidence', note: 'Asked both institutions for identifiers.' } });
  assert.equal(evidence.status, 200); assert.equal(evidence.json.data.match.status, 'needs_more_evidence');
  assert.equal(evidence.json.data.explanation.finding.review_status, 'awaiting_verification');

  const same = await call({ method: 'POST', url, json: { decision: 'same_person', note: 'Both institutions supplied the same transfer certificate.', confirm: true } });
  assert.equal(same.status, 200);
  assert.equal(same.json.data.match.status, 'same_person');
  assert.equal(same.json.data.explanation.finding.review_status, 'resolved');
  assert.equal(same.json.data.decision.history.length, 1, 'the earlier decision is kept');

  const blocked = await call({ method: 'POST', url, json: { decision: 'different_person', note: 'Changed my mind.' } });
  assert.equal(blocked.status, 400); assert.match(blocked.json.error, /Reopen it with "Needs more evidence"/);

  const db = loadDemo();
  const events = db.auditEvents.filter(e => e.link_id === candidate.id);
  assert.deepEqual(events.map(e => e.action), ['match_needs_more_evidence', 'match_same_person']);
  assert.ok(events.every(e => e.actor === 'Demo Regulator Reviewer' && e.finding_id === candidate.finding_id && e.note));
  const feed = (await call({ url: '/api/v1/audit?limit=20' })).json.data;
  assert.ok(feed.some(item => (item.event || item).action === 'match_same_person'), 'decision appears in the audit feed');

  // Nothing was merged: both source records are unchanged and still separate.
  assert.deepEqual(candidate.sources.map(s => db.sourceRecords.filter(r => r.id === s.record_id).length), [1, 1]);
  // The decision survives revalidation, which rebuilds links with stable ids.
  assert.equal((await call({ method: 'POST', url: '/api/v1/automation/revalidate' })).status, 200);
  assert.equal((await call({ url: `/api/v1/matches/${candidate.id}` })).json.data.match.status, 'same_person');
  assert.equal((await call({ url: '/api/v1/matches?status=same_person' })).json.data.length, 1);
});

test('the profile joins only automatic links and confirmed decisions, keeps sources separate and respects scope', async () => {
  resetDemo();
  const db = loadDemo();
  const auto = db.identityLinks.find(l => l.outcome === 'auto_linked');
  const profile = (await call({ url: `/api/v1/profiles/${auto.records[0]}` })).json.data;
  assert.deepEqual(profile.sources.map(s => s.record_id).sort(), [...auto.records].sort());
  assert.ok(profile.attributes.every(a => ['consistent', 'partial', 'conflict', 'missing'].includes(a.state)));
  assert.equal(profile.attributes.find(a => a.key === 'apaar_id').verification, 'not_verified');
  assert.doesNotMatch(JSON.stringify(profile), FULL_ID);
  assert.ok(profile.match_history.some(m => m.link_id === auto.id && m.outcome === 'auto_linked'));

  const candidate = (await call({ url: '/api/v1/matches?method=name_dob_similarity' })).json.data[0];
  const [a, b] = candidate.sources.map(s => s.record_id);
  const before = (await call({ url: `/api/v1/profiles/${a}` })).json.data;
  assert.deepEqual(before.sources.map(s => s.record_id), [a], 'a candidate is not joined before a decision');
  assert.ok(before.match_history.some(m => m.link_id === candidate.id && m.reviewable));
  await call({ method: 'POST', url: `/api/v1/matches/${candidate.id}/decision`, json: { decision: 'same_person', note: 'Confirmed from source documents.', confirm: true } });
  const after = (await call({ url: `/api/v1/profiles/${a}` })).json.data;
  assert.deepEqual(after.sources.map(s => s.record_id).sort(), [a, b].sort());
  assert.equal(after.match_history.find(m => m.link_id === candidate.id).decision.decision, 'same_person');

  const otherInstitution = db.sourceRecords.find(r => r.institution_code !== 'NITM');
  assert.equal((await call({ url: `/api/v1/profiles/${otherInstitution.id}`, headers: institution })).status, 404);
  assert.equal((await call({ url: '/api/v1/profiles/SRC-does-not-exist' })).status, 404);
});

test('the graph keeps relationships faithful to persisted findings and masks identifiers', async () => {
  resetDemo();
  const db = loadDemo();
  const graph = (await call({ url: '/api/v1/graph' })).json.data;
  assert.doesNotMatch(JSON.stringify(graph), FULL_ID);
  for (const edge of graph.edges.filter(e => e.type !== 'source')) {
    const finding = db.findings.find(f => f.id === edge.finding_id);
    assert.ok(finding, 'every relationship edge is backed by a persisted finding');
    const recordOf = id => graph.nodes.find(n => n.id === id)?.detail.id;
    assert.ok(finding.evidence.includes(recordOf(edge.source)) && finding.evidence.includes(recordOf(edge.target)));
    const expected = { CANDIDATE_IDENTITY_MATCH: 'candidate', IDENTIFIER_ATTRIBUTE_CONFLICT: 'conflict', DUPLICATE_IDENTIFIER: 'exact', POTENTIAL_CONCURRENT_ENROLMENT: 'exact' }[finding.rule_code];
    assert.equal(edge.type, expected);
  }
  const nitm = (await call({ url: '/api/v1/graph', headers: institution })).json.data;
  assert.ok(nitm.nodes.filter(n => n.type === 'record').every(n => n.institution_code === 'NITM'));
});

test('the automation summary separates rule findings from stored model explanations', async () => {
  resetDemo();
  const summary = (await call({ url: '/api/v1/automation' })).json.data.assistance;
  assert.ok(summary.rule_findings > 0);
  assert.equal(summary.model_explanations, 0, 'no model has been asked, so none is reported');
  assert.match(summary.note, /deterministic rule/);
});

test('UI contract: new views are served, labelled, keyboard-reachable and respect reduced motion', async () => {
  for (const file of ['/matches.js', '/profile.js']) {
    const res = await call({ url: file });
    assert.equal(res.status, 200); assert.match(res.text, /registerView\('(matches|profile)'/);
  }
  const html = (await call({ url: '/' })).text;
  for (const id of ['view-matches', 'view-profile', 'mxQuery', 'mxFilterSheet', 'mxDetail', 'navMatchCount', 'ovMetrics', 'ovNext', 'ovAttention', 'ovAutomation', 'ovNotices']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<h1 class="page-title" id="h-matches" tabindex="-1">/, 'route changes can move focus to the heading');
  assert.match(html, /<script src="matches.js"><\/script>\s*<script src="profile.js"><\/script>/, 'mode-mounted assets resolve beneath the selected route');
  const matchesJs = (await call({ url: '/matches.js' })).text;
  assert.match(matchesJs, /aria-expanded="false" aria-controls=/, 'field evidence uses a disclosure button');
  assert.match(matchesJs, /ArrowDown/, 'the queue supports arrow-key navigation');
  assert.match(matchesJs, /confirmDialog\(/, '"same person" asks for confirmation');
  assert.match(matchesJs, /mx\.filterOpener\.focus\(\)/, 'focus returns to the filter button when the sheet closes');
  assert.match(matchesJs, /setAttribute\('aria-invalid', 'true'\)/, 'inline errors mark the invalid control');
  assert.doesNotMatch(matchesJs, /innerHTML = [^`]*\$\{(?!esc\(|icon\(|mx|plural|routeHash|skeletonLines|emptyState|errorState)/, 'interpolated text in innerHTML goes through esc()');
  const profileJs = (await call({ url: '/profile.js' })).text;
  assert.match(profileJs, /role="tablist"/); assert.match(profileJs, /ArrowRight: i \+ 1/);
  const css = (await call({ url: '/styles.css' })).text;
  const reduced = css.split('@media (prefers-reduced-motion: reduce)').slice(1).join(' ');
  for (const animated of ['.g-edge-flow', '.mx-evidence', '.att-row']) assert.ok(reduced.includes(animated), `${animated} is stopped under reduced motion`);
  for (const width of ['1279px', '1023px', '767px']) assert.ok(css.includes(`@media (max-width: ${width})`), `breakpoint ${width}`);
});

test('overview metrics have distinct server definitions: open findings, pending review and validation issues', async () => {
  resetDemo();
  const summary = (await call({ url: '/api/v1/dashboard/summary' })).json.data;
  const current = (await call({ url: '/api/v1/findings' })).json.data;
  assert.equal(summary.open_findings, current.filter(f => f.review_status !== 'resolved').length);
  assert.equal(summary.pending_decisions, current.filter(f => f.review_status === 'pending').length);
  assert.equal(summary.validation_issues, current.filter(f => f.category === 'identifier').length);
  const defs = summary.metric_definitions;
  assert.ok(defs.open_findings && defs.pending_decisions && defs.validation_issues);
  assert.equal(new Set([defs.open_findings, defs.pending_decisions, defs.validation_issues]).size, 3, 'three different definitions');
  assert.match(defs.open_findings, /pending review or awaiting verification/);
  // After a "needs more evidence" decision the finding stays open but is no longer pending review.
  const candidate = (await call({ url: '/api/v1/matches?method=name_dob_similarity' })).json.data[0];
  await call({ method: 'POST', url: `/api/v1/matches/${candidate.id}/decision`, json: { decision: 'needs_more_evidence', note: 'Asked for identifiers.' } });
  const after = (await call({ url: '/api/v1/dashboard/summary' })).json.data;
  assert.equal(after.open_findings, summary.open_findings);
  assert.equal(after.pending_decisions, summary.pending_decisions - 1);
  const nitm = (await call({ url: '/api/v1/dashboard/summary', headers: institution })).json.data;
  assert.ok(nitm.open_findings <= summary.open_findings, 'scoped to the principal');
});

test('the findings category filter accepts a comma-separated list for grouped overview links', async () => {
  resetDemo();
  const all = (await call({ url: '/api/v1/findings' })).json.data;
  const ids = list => list.map(f => f.id).sort();
  const both = (await call({ url: '/api/v1/findings?category=capacity,enrolment' })).json.data;
  assert.deepEqual(ids(both), ids(all.filter(f => ['capacity', 'enrolment'].includes(f.category))));
  assert.ok(both.length >= 2);
  const single = (await call({ url: '/api/v1/findings?category=capacity' })).json.data;
  assert.deepEqual(ids(single), ids(all.filter(f => f.category === 'capacity')), 'a single value behaves as before');
});
