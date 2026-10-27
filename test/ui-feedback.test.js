require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { server } = require('../server');

function get(url) {
  return new Promise(resolve => {
    const request = Readable.from([]); request.method = 'GET'; request.url = url; request.headers = { host: 'localhost', 'x-demo-role': 'regulator' };
    const response = new EventEmitter(); let status = 200; const chunks = [];
    response.writeHead = code => { status = code; };
    response.end = value => { if (value) chunks.push(value); resolve({ status, text: chunks.join('') }); };
    server.emit('request', request, response);
  });
}

test('sign-in links to generic account creation and registration returns to sign-in', async () => {
  const html = (await get('/')).text;
  const app = (await get('/app.js')).text;
  const loginStart = html.indexOf('<dialog class="modal login-dialog"');
  const registrationStart = html.indexOf('<dialog class="modal registration-dialog"');
  const registrationEnd = html.indexOf('</dialog>', registrationStart) + '</dialog>'.length;
  const authMarkup = html.slice(loginStart, registrationEnd);
  assert.match(authMarkup, />New user\? Create account</);
  assert.match(authMarkup, /<h2 id="registrationTitle">Create account<\/h2>/);
  assert.match(authMarkup, /id="registrationInstitution"/);
  for (const id of ['registrationName', 'registrationUser', 'registrationPass', 'registrationConfirm']) assert.match(authMarkup, new RegExp(`id="${id}"`));
  assert.match(authMarkup, />Back to sign in</);
  assert.doesNotMatch(authMarkup, /\b(?:judge|reviewer)\b/i);
  assert.doesNotMatch(authMarkup, /type="email"|id="registrationEmail"/i, 'registration collects no unsupported email field');
  const registrationFlow = app.slice(app.indexOf('async function openRegistration'), app.indexOf('/* ── Domain Vocabulary'));
  assert.match(registrationFlow, /api\('\/api\/v1\/institutions'\)/);
  assert.match(registrationFlow, /api\('\/api\/v1\/auth\/register'/);
  assert.match(registrationFlow, /institution, full_name: fullName, username, password, confirm_password: confirmPassword/);
  assert.match(app, /registrationLink\.hidden = state\.runtime\?\.registration_enabled !== true/);
  assert.match(registrationFlow, /if \(!state\.runtime\?\.registration_enabled\) return;/);
  assert.doesNotMatch(registrationFlow, /state\.auth\s*!==\s*'local'/, 'the explicit server flag controls link and form visibility');
  assert.doesNotMatch(registrationFlow, /\b(?:judge|reviewer)\b/i);
});

test('registration link has theme-aware contrast and visible hover, focus and active states', async () => {
  const css = (await get('/styles.css')).text;
  const light = css.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
  const dark = css.match(/:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(light && dark, 'light and dark theme token blocks exist');
  const color = (block, name) => {
    const value = block.match(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})\\s*;`))?.[1];
    assert.ok(value, `--${name} is a six-digit theme token`);
    return value;
  };
  const luminance = hex => {
    const channels = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + 0.05) / (values[1] + 0.05); };
  for (const theme of [light, dark]) {
    const surface = color(theme, 'surface');
    assert.ok(contrast(color(theme, 'info-ink'), surface) >= 4.5, 'normal and keyboard-focus text meet WCAG AA');
    assert.ok(contrast(color(theme, 'info'), surface) >= 4.5, 'hover text meets WCAG AA');
  }
  assert.match(css, /\.registration-link\s*\{[^}]*color:\s*var\(--info-ink\)/s);
  assert.match(css, /\.registration-link:hover\s*\{[^}]*color:\s*var\(--info\)[^}]*background-color:\s*var\(--info-soft\)/s);
  assert.match(css, /\.registration-link:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/s);
  assert.match(css, /\.registration-link:active\s*\{[^}]*background-color:\s*var\(--info-soft\)[^}]*transform:\s*translateY\(1px\)/s);
  assert.doesNotMatch(css, /\.registration-link\s*\{[^}]*color:\s*#[0-9A-Fa-f]{3,8}/s, 'link color follows theme tokens without a fixed color override');
});

/* A static UI contract: what the browser checks relied on must stay in the shipped files. */
test('shared button feedback shows success only after the awaited operation and has failed and busy states', async () => {
  const app = (await get('/app.js')).text;
  const fn = app.slice(app.indexOf('async function withFeedback'), app.indexOf('/* ── CSV Export'));
  assert.ok(fn.length > 200, 'withFeedback exists');
  assert.ok(fn.indexOf('await run()') < fn.indexOf("dataset.state = 'done'"), 'done is set only after the server answered');
  assert.match(fn, /dataset\.state = 'failed'/); assert.match(fn, /throw error/, 'a failure is never swallowed as success');
  assert.match(fn, /minWidth/, 'the button keeps its width, so the layout does not shift');
  assert.match(app, /withFeedback\(button, async \(\) => \{\s*const response = await fetch\(`\$\{APP_BASE\}\/api\/v1\/reports\/findings\.csv`/, 'export uses the active mode mount');
});

test('interaction styles cover focus, press, busy, done, failed and reduced motion', async () => {
  const css = (await get('/styles.css')).text;
  const shared = css.slice(css.indexOf('Interaction feedback (shared)'));
  for (const rule of ['summary:focus-visible', '[data-state="busy"]', '[data-state="done"]', '[data-state="failed"]', '@media (hover: none)', 'theme-turn']) assert.ok(shared.includes(rule), rule);
  const reduced = shared.slice(shared.indexOf('@media (prefers-reduced-motion: reduce)'));
  for (const animated of ['#themeToggle.is-switching .icon', '[data-state="busy"] .icon', 'dialog.record-dialog[open]', '.g-node:active .g-dot']) assert.ok(reduced.includes(animated), `${animated} stops under reduced motion`);
  for (const style of ['.legend-line.confirmed', '.legend-line.rejected', '.legend-line.withdrawn', '.g-edge.confirmed', '.g-edge.withdrawn']) assert.ok(css.includes(style), style);
});

test('the student history view ships its filters, as-of control, record dialog and accessible structure', async () => {
  const html = (await get('/')).text;
  assert.match(html, /id="gHistory"/); assert.match(html, /<dialog class="modal record-dialog" id="recordDialog"/);
  assert.match(html, /<script src="history\.js"><\/script>/, 'assets resolve under either mode mount');
  const js = await get('/history.js');
  assert.equal(js.status, 200);
  for (const hook of ['id="hxFInst"', 'id="hxFCat"', 'id="hxFFrom"', 'id="hxFTo"', 'id="hxAsOf"', 'id="hxReset"', 'id="hxNextDecision"', 'id="hxPrevDecision"', 'Filtered: ', '<details class="hx-ev-more">', 'data-record-detail']) assert.ok(js.text.includes(hook), hook);
  assert.match(js.text, /hx\.limit/, 'long timelines are paged, not rendered all at once');
  assert.match(js.text, /hx\.dialogOpener\.focus\(\)/, 'focus returns to the opener when the record dialog closes');
  assert.doesNotMatch(js.text, /innerHTML = [^`]*\$\{(?!esc\(|icon\(|hx|plural|routeHash|skeletonLines|errorState|outcomeLabel|statusLabel|fmtDate)/, 'interpolated values in innerHTML are escaped');
  const graph = (await get('/graph.js')).text;
  assert.match(graph, /\['source', 'rejected', 'withdrawn'(, 'simulated')?\]\.includes\(e\.type\)/, 'rejected and withdrawn (and simulated) edges never group records in the layout');
});

test('visual system 2.0: motion runs once per cause, never fakes state and stops under reduced motion', async () => {
  const app = (await get('/app.js')).text;
  const css = (await get('/styles.css')).text;
  const graph = (await get('/graph.js')).text;
  const history = (await get('/history.js')).text;
  // Ripple only on primary and destructive buttons, one at a time, removed after its animation.
  assert.match(app, /closest\('\.btn-primary, \.btn-danger'\)/);
  assert.match(app, /querySelector\(':scope > \.ripple-host'\)\?\.remove\(\)/);
  assert.match(app, /addEventListener\('animationend', \(\) => host\.remove\(\), \{ once: true \}\)/);
  assert.match(app, /resting\.querySelectorAll\('\.ripple-host'\)/, 'a ripple is never saved into the restored button HTML');
  // The count-up from zero happens once per page load; later renders animate only a real change.
  assert.match(app, /if \(from == null && !metricsIntroShown\) countTo\(metric, 0, to, \{ intro: true \}\)/);
  assert.match(app, /else if \(from != null && from !== to\) countTo\(metric, from, to\)/);
  // Every JS-driven motion checks the reduced-motion preference.
  for (const fn of ['function enterView', "document.addEventListener('pointerdown'", 'function themeReveal']) {
    const body = app.slice(app.indexOf(fn), app.indexOf(fn) + 600);
    assert.match(body, /motionOff\(\)/, `${fn} respects reduced motion`);
  }
  // The graph entrance runs only when new data arrives, not on selection, search or resize.
  assert.match(graph, /gRenderAll\(\{ animate: true \}\)/);
  assert.equal((graph.match(/animate: true/g) || []).length, 1, 'only gLoad requests the entrance');
  assert.match(graph, /G_SOLID\.has\(edge\.type\) \? ' pathLength="1"' : ''/, 'dashed relationship patterns are never replaced by the draw animation');
  // Timeline: distinct markers and a labelled before/after comparison, so colour is not the only cue.
  for (const hook of ['hxMark(e)', '<span class="hx-change-cap">Before</span>', '<span class="hx-change-cap">After</span>', 'hx-kind kind-']) assert.ok(history.includes(hook), hook);
  // Reduced-motion block covers the new animations.
  const reduced = css.slice(css.indexOf('Reduced motion: no decorative movement'));
  for (const sel of ['.view.is-entering > *', '.graph-canvas.is-entering .g-node', '.graph-canvas.is-entering .g-edge', '.g-node.is-selected .g-halo', '.hx-ev.is-new', '.ripple', 'dialog.modal, dialog.drawer']) assert.ok(reduced.includes(sel), `${sel} stops under reduced motion`);
  assert.doesNotMatch(css.slice(css.indexOf('Visual system 2.0')), /backdrop-filter:(?!\s*none)/, 'no glassmorphism');
});

test('the Overview headline describes the account\'s scope, never a role name', async () => {
  const app = (await get('/app.js')).text;
  const start = app.indexOf('const plural = '); const end = app.indexOf('\n', app.indexOf('const scopeLabel = '));
  const run = (state, institutions) => new Function('state', `${app.slice(start, end)}\nreturn scopeLabel(scopeInstitution(), ${institutions});`)(state);
  assert.equal(run({ auth: 'local', user: { institution_code: null }, role: 'regulator' }, 3), 'All-institution scope, 3 institutions', 'an account with no institution sees all of them');
  assert.equal(run({ auth: 'local', user: { institution_code: 'RCA' }, role: 'institution', institution: 'NITM' }, 1), 'RCA scope, 1 institution', 'the account\'s own institution, not a hard-coded one');
  assert.equal(run({ auth: 'demo_header', role: 'regulator', institution: 'NITM' }, 3), 'All-institution scope, 3 institutions');
  assert.equal(run({ auth: 'demo_header', role: 'institution', institution: 'NITM' }, 1), 'NITM scope, 1 institution');
  assert.doesNotMatch(app.slice(app.indexOf("$('#ovScope')"), app.indexOf('\n', app.indexOf("$('#ovScope')"))), /Regulator/);
});
