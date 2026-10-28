/* EduTrace AI — Core Application
   SIH 26263 · Shell, routing, API client, shared UI primitives,
   Overview dashboard and Audit history.
   ──────────────────────────────────────────────── */
'use strict';

/* ── Storage (per-viewer conveniences only) ───── */
function readStore(key, fallback, store = 'sessionStorage') {
  try { return window[store].getItem(key) ?? fallback; } catch { return fallback; }
}
function writeStore(key, value, store = 'sessionStorage') {
  try { window[store].setItem(key, value); } catch { /* storage unavailable: keep in memory only */ }
}

/* ── State ────────────────────────────────────── */
const state = {
  role: readStore('edutrace.role', 'regulator') === 'institution' ? 'institution' : 'regulator',
  institution: 'NITM',
  principal: null,
  summary: null,
  view: null,
  /* Set from /api/v1/runtime. The server enforces read-only demo mode itself; this only changes what the UI says. */
  runtime: null,
  readOnly: false
};
const APP_MOUNT = /^\/(demo|synthetic)(?:\/|$)/.exec(location.pathname)?.[1] || '';
const APP_BASE = APP_MOUNT ? `/${APP_MOUNT}` : '';

/* ── DOM Utilities ────────────────────────────── */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/* Overview headline scope. Describes what the account can see, not its role: a signed-in account's own institution,
   the demo's pinned NITM, or all institutions. */
const scopeInstitution = () => (state.auth === 'local' ? state.user?.institution_code || null : state.role === 'institution' ? state.institution : null);
const scopeLabel = (institutionCode, institutions) => (institutionCode ? `${institutionCode} scope, ${plural(institutions, 'institution')}` : `All-institution scope, ${plural(institutions, 'institution')}`);
const fmtNum = n => Number(n ?? 0).toLocaleString('en-IN');

/* ── API Client ───────────────────────────────── */
async function api(path, opts = {}) {
  let response;
  try {
    response = await fetch(`${APP_BASE}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        /* The simulated viewing scope exists only in the read-only demo; signed-in sessions ignore it anyway. */
        ...(state.auth === 'demo_header' ? { 'x-demo-role': state.role, 'x-demo-institution': state.institution } : {}),
        ...(state.auth === 'synthetic_test' ? { 'x-edutrace-test-institution': state.institution } : {}),
        ...(state.csrf && opts.method && opts.method !== 'GET' ? { 'x-csrf-token': state.csrf } : {}),
        ...opts.headers
      }
    });
  } catch {
    throw new Error('The EduTrace server could not be reached. Check that it is running (npm start), then try again.');
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) {
    const error = new Error(data.error || `The request failed with status ${response.status}.`);
    error.status = response.status;
    error.details = data;
    error.readOnly = data.code === 'read_only_demo';
    if (response.status === 401 && state.auth === 'local' && !path.startsWith('/api/v1/auth/')) showLogin('Your session has ended. Sign in again.');
    else if (response.status === 401) {
      const banner = $('#modeBanner');
      banner.hidden = false;
      banner.innerHTML = `${icon('shield', 'icon-sm')}<span><strong>Sign-in required.</strong> ${state.auth === 'oidc' ? 'This server accepts identity-provider tokens only; the browser sign-in flow is not configured in this build.' : 'Choose a simulated role; the server answered without one.'}</span>`;
    }
    throw error;
  }
  return data;
}

/* ── Operating mode ───────────────────────────── */
async function loadRuntime() {
  try { state.runtime = (await api('/api/v1/runtime')).data; }
  catch {
    showStartupError('EduTrace could not confirm the server configuration. Reload the page or contact the service operator.');
    return false;
  }
  if (!state.runtime?.mode || !state.runtime?.auth) {
    showStartupError('The server returned an incomplete configuration. Reload the page or contact the service operator.');
    return false;
  }
  if (state.runtime.auth === 'hosted_demo' && (state.runtime.mode !== 'demo' || state.runtime.read_only !== true || state.runtime.data_source !== 'synthetic_in_memory' || state.runtime.ai_enabled !== false)) {
    showStartupError('The hosted demo is not configured as a read-only synthetic experience.');
    return false;
  }
  state.readOnly = state.runtime?.read_only === true;
  document.documentElement.dataset.mode = state.runtime?.mode || 'unknown';
  /* With identity-provider tokens the simulated role controls mean nothing, so they are hidden. */
  state.auth = state.runtime.auth;
  if (state.runtime?.mode === 'synthetic-test') {
    state.role = 'institution';
    const institutions = (await api('/api/v1/institutions')).data;
    if (!institutions.length) throw new Error('No synthetic test institutions are available.');
    state.institution = institutions.some(item => item.code === state.institution) ? state.institution : institutions[0].code;
    renderSyntheticTestCard(institutions);
  }
  const registrationLink = $('#openRegistration');
  if (registrationLink) registrationLink.hidden = state.runtime?.registration_enabled !== true;
  if (state.auth !== 'demo_header') ['.scope-wrap', '#demoCompact'].forEach(sel => { const el = $(sel); if (el) el.hidden = true; });
  if (state.auth === 'oidc') $('.demo-card').hidden = true;
  if (state.auth === 'hosted_demo') {
    state.role = 'hosted_demo_viewer'; $('.demo-card').hidden = true;
    $('[data-route="audit"]').hidden = true;
    $('#exportAll').hidden = true;
    $('#rxExport').hidden = true;
    $('#tab-decisions').hidden = true;
    $('#loginTitle').textContent = 'Enter the demo password';
    $('#loginIntro').textContent = 'This read-only public walkthrough uses one fixed viewer identity. Your password is checked by the server and is never stored in this browser.';
    $('#loginUsernameField').hidden = true;
    $('#loginUser').required = false;
  }
  /* Institution sign-in: the role and institution come from the account on the server. */
  if (state.auth === 'local') {
    const session = await api('/api/v1/auth/session').then(r => r.data).catch(() => ({ authenticated: false }));
    if (session.authenticated) {
      state.user = session.user; state.csrf = session.csrf_token;
      state.role = session.user.institution_code ? 'institution' : 'regulator';
      renderSignedIn();
    } else {
      state.user = null; state.csrf = null;
      showLogin(); return false;
    }
  }
  if (state.auth === 'hosted_demo') {
    const session = await api('/api/v1/auth/session').then(r => r.data).catch(() => ({ authenticated: false }));
    if (!session.authenticated || !session.csrf_token || session.method !== 'hosted_demo') {
      state.user = null; state.csrf = null; showLogin(); return false;
    }
    state.user = session.viewer; state.csrf = session.csrf_token;
    $('#hostedSignOut').hidden = false;
  }
  const banner = $('#modeBanner');
  banner.hidden = !state.readOnly;
  if (state.readOnly) banner.innerHTML = `${icon('shield', 'icon-sm')}<span><strong>Read-only demo.</strong> Synthetic records only, held in memory. The server rejects imports, decisions, corrections and resets, and model assistance is off.</span>`;
  if (state.readOnly) $('#auditSub').textContent = state.auth === 'hosted_demo'
    ? 'Synthetic import batches are available for review. Decision history and exports are not available in the public walkthrough.'
    : 'Every user decision and import batch in your access scope, as recorded in the synthetic demo dataset. Nothing new can be recorded in this read-only demo.';
  if (state.runtime?.mode === 'synthetic-test') {
    banner.hidden = false;
    banner.innerHTML = `${icon('flask', 'icon-sm')}<span><strong>Ephemeral synthetic test environment.</strong> Generated synthetic data only. CSV imports are held in memory on this computer and are discarded when the server restarts.</span>`;
    $('#auditSub').textContent = 'Synthetic test audit history for the selected institution. All changes are held in memory and discarded when the server restarts.';
  }
  return true;
}

function showStartupError(message) {
  $('#entryTitle').textContent = 'EduTrace is unavailable';
  $('#entryStatus').textContent = message;
  $('#entryScreen').hidden = false;
  $('#shell').hidden = true;
}
function enterWorkspace({ render = true } = {}) {
  $('#entryScreen').hidden = true;
  $('#shell').hidden = false;
  if (render) {
    syncRoleControls();
    refreshPrincipal();
    renderRoute({ force: true });
  }
}
function handleEntryNavigation() {
  const route = location.hash.replace(/^#\/?/, '') || 'overview';
  const mountedMode = APP_MOUNT === 'demo' ? 'demo' : APP_MOUNT === 'synthetic' ? 'synthetic-test' : null;
  if (mountedMode && mountedMode !== state.runtime?.mode) {
    showStartupError(`This ${mountedMode} address is connected to a server running ${state.runtime?.mode || 'an unknown mode'}.`);
    return;
  }
  if (route === 'entry') {
    history.replaceState(null, '', `${APP_BASE}/#/overview`);
  }
  enterWorkspace({ render: false });
  renderRoute({ force: true });
}

function renderSyntheticTestCard(institutions) {
  const card = $('.demo-card');
  card.hidden = false;
  card.innerHTML = `<div class="demo-card-head"><span class="demo-dot is-live" aria-hidden="true"></span>Synthetic test mode</div>
    <label class="demo-label" for="testInstitutionSelect">Institutions available for testing · current records scope</label>
    <select id="testInstitutionSelect">${institutions.map(item => `<option value="${esc(item.code)}" ${item.code === state.institution ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}</select>
    <p class="demo-note">Generated synthetic records only. Imports are temporary and reset when the server restarts.</p>`;
  $('#testInstitutionSelect').addEventListener('change', async event => {
    state.institution = event.target.value;
    state.role = 'institution';
    lastMetrics.clear();
    await refreshPrincipal();
    renderRoute({ force: true });
  });
}

const ROLE_LABEL = { reviewer: 'Your account', auditor: 'Auditor', institution_admin: 'Institution administrator', platform_admin: 'Platform administrator' };
function renderSignedIn() {
  const u = state.user;
  $('.demo-card').innerHTML = `
    <div class="demo-card-head"><span class="demo-dot is-live" aria-hidden="true"></span>Signed in</div>
    <p class="signed-name">${esc(u.display_name)}</p>
    <p class="demo-note">${esc(ROLE_LABEL[u.role] || u.role)} · ${u.institution_code ? esc(u.institution_code) : 'All institutions'}. Role and institution come from your account on the server.</p>
    <button type="button" class="demo-reset" id="signOut">${icon('arrow-left', 'icon-xs')}Sign out</button>`;
  $('#signOut').addEventListener('click', async () => {
    try { await api('/api/v1/auth/logout', { method: 'POST', body: '{}' }); } catch { /* the session may already have ended */ }
    if (state.runtime?.mode !== 'demo') { location.reload(); return; }
    state.user = null; state.csrf = null;
    history.replaceState(null, '', `${APP_BASE}/#/overview`);
    showLogin();
  });
}

function showLogin(message = '') {
  $('#entryScreen').hidden = true;
  $('#shell').hidden = true;
  const dialog = $('#loginDialog');
  $('#loginError').hidden = !message; $('#loginError').textContent = message;
  if (!dialog.open) dialog.showModal();
  (state.auth === 'hosted_demo' ? $('#loginPass') : $('#loginUser')).focus();
}
$$('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
  const input = document.getElementById(button.dataset.passwordToggle);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Hide' : 'Show';
  button.setAttribute('aria-pressed', String(show));
}));
$('#loginDialog').addEventListener('cancel', event => event.preventDefault());
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#loginError'); error.hidden = true;
  const hosted = state.auth === 'hosted_demo';
  const username = $('#loginUser').value.trim(); const password = $('#loginPass').value;
  if ((!hosted && !username) || !password) { error.textContent = hosted ? 'Enter the demo password.' : 'Enter your username and password.'; error.hidden = false; return; }
  try {
    const credentials = hosted ? { password } : { username, password };
    await withFeedback($('#loginSubmit'), () => api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify(credentials) }), { done: 'Signed in', failed: 'Not signed in' });
    $('#loginPass').value = '';
    location.reload();
  } catch (err) { error.textContent = err.message; error.hidden = false; $('#loginPass').select(); }
});

$('#hostedSignOut').addEventListener('click', async () => {
  const button = $('#hostedSignOut'); button.disabled = true;
  try {
    await api('/api/v1/auth/logout', { method: 'POST', body: '{}' });
    state.csrf = null; state.user = null; location.reload();
  } catch (error) {
    toast(error.message || 'Sign-out could not be completed. Try again.', { title: 'Still signed in' });
  } finally { button.disabled = false; }
});

async function openRegistration() {
  const button = $('#openRegistration'); const error = $('#loginError'); const select = $('#registrationInstitution');
  if (!state.runtime?.registration_enabled) return;
  button.disabled = true;
  select.innerHTML = '<option value="">Loading institutions…</option>';
  try {
    const result = await api('/api/v1/institutions');
    if (!Array.isArray(result.data) || !result.data.length) throw new Error('No institutions are available for registration.');
    select.innerHTML = '<option value="">Choose an institution</option>' + result.data.map(item => `<option value="${esc(item.code)}">${esc(item.name)}</option>`).join('');
    error.hidden = true;
    $('#loginDialog').close();
    $('#registrationError').hidden = true;
    $('#registrationDialog').showModal();
    $('#registrationInstitution').focus();
  } catch (err) {
    error.textContent = err.message; error.hidden = false;
  } finally { button.disabled = false; }
}
$('#openRegistration').addEventListener('click', openRegistration);
$('#registrationBack').addEventListener('click', () => {
  $('#registrationDialog').close();
  showLogin();
});
$('#registrationDialog').addEventListener('cancel', event => {
  event.preventDefault();
  $('#registrationDialog').close();
  showLogin();
});
$('#registrationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const error = $('#registrationError'); const button = $('#registrationSubmit');
  const institution = $('#registrationInstitution').value;
  const fullName = $('#registrationName').value.trim();
  const username = $('#registrationUser').value.trim();
  const password = $('#registrationPass').value;
  const confirmPassword = $('#registrationConfirm').value;
  error.hidden = true;
  if (!institution) { error.textContent = 'Choose an institution.'; error.hidden = false; $('#registrationInstitution').focus(); return; }
  if (!fullName || fullName.length > 120) { error.textContent = 'Enter a full name up to 120 characters.'; error.hidden = false; $('#registrationName').focus(); return; }
  if (!username) { error.textContent = 'Enter a username.'; error.hidden = false; $('#registrationUser').focus(); return; }
  if (password.length < 12 || password.length > 256) { error.textContent = 'A password must be 12 to 256 characters.'; error.hidden = false; $('#registrationPass').focus(); return; }
  if (confirmPassword !== password) { error.textContent = 'Password confirmation must match exactly.'; error.hidden = false; $('#registrationConfirm').focus(); return; }
  button.disabled = true; button.textContent = 'Creating account…';
  try {
    await api('/api/v1/auth/register', { method: 'POST', body: JSON.stringify({ institution, full_name: fullName, username, password, confirm_password: confirmPassword }) });
    $('#registrationForm').reset();
    $('#registrationDialog').close();
    $('#loginUser').value = username;
    $('#loginPass').value = '';
    showLogin('Your account was created. Sign in to continue.');
  } catch (err) { error.textContent = err.message; error.hidden = false; }
  finally { button.disabled = false; button.textContent = 'Create account'; }
});

/* ── Domain Vocabulary ────────────────────────── */
const SEVERITY = {
  high: { label: 'High', icon: 'alert-octagon', rank: 3 },
  medium: { label: 'Medium', icon: 'alert-triangle', rank: 2 },
  low: { label: 'Low', icon: 'info', rank: 1 }
};

const STATUS = {
  pending: { label: 'Pending review', short: 'Pending', icon: 'clock', rank: 0 },
  awaiting_verification: { label: 'Awaiting verification', short: 'Awaiting', icon: 'hourglass', rank: 1 },
  resolved: { label: 'Resolved', short: 'Resolved', icon: 'check-circle', rank: 2 }
};

const CATEGORY = {
  identifier: 'Identifier validation',
  duplicate: 'Repeated identifier',
  conflict: 'Identity conflict',
  enrolment: 'Concurrent enrolment',
  candidate: 'Candidate match',
  capacity: 'Intake capacity'
};

const RULES = {
  APAAR_MISSING: {
    label: 'APAAR ID missing',
    checks: 'The source row supplied no APAAR identifier value.',
    means: 'This record was imported without an identifier, so it can only be compared using other attributes.',
    notMeans: 'It does not mean the student has no APAAR ID — only that this source file did not provide one.',
    field: 'apaar_id'
  },
  APAAR_MALFORMED: {
    label: 'APAAR ID format needs correction',
    checks: 'After removing spaces and hyphens, the identifier is not 12 digits (local format check).',
    means: 'The supplied value cannot be a well-formed APAAR identifier. Review the source record before attempting verification.',
    notMeans: 'A local format check is not authoritative verification. A well-formed value would not be "verified" either.',
    field: 'apaar_id'
  },
  REQUIRED_FIELD_MISSING: {
    label: 'Required value missing',
    checks: 'A canonical field required for reconciliation is empty in the source row.',
    means: 'The record is incomplete and cannot be fully reconciled.',
    notMeans: 'It does not indicate anything about the student, only about the completeness of the source data.'
  },
  DUPLICATE_IDENTIFIER: {
    label: 'Repeated identifier',
    checks: 'Two or more source records share the same protected identifier fingerprint, with the same name and date of birth.',
    means: 'The same identifier was submitted more than once. Compare the source rows to see whether the repeat is legitimate.',
    notMeans: 'Resubmissions and programme changes can produce legitimate repeats. This is not evidence of duplicate enrolment.',
    exactId: true
  },
  IDENTIFIER_ATTRIBUTE_CONFLICT: {
    label: 'Identity conflict on shared identifier',
    checks: 'Records share an exact protected identifier match but differ in student name and/or date of birth.',
    means: 'At least one record may carry an incorrect identifier or attribute. Compare the source records before taking action.',
    notMeans: 'It does not establish which record is correct, or that anyone acted improperly.',
    exactId: true
  },
  POTENTIAL_CONCURRENT_ENROLMENT: {
    label: 'Potential concurrent enrolment',
    checks: 'The same protected identifier appears in active enrolments at more than one institution in the same academic session.',
    means: 'The student may be recorded as active at two institutions at once.',
    notMeans: 'Transfers, approved dual programmes and reporting lag can all explain this. It is not proof of wrongdoing.',
    exactId: true
  },
  CANDIDATE_IDENTITY_MATCH: {
    label: 'Candidate identity match',
    checks: 'Records without identifiers, at different institutions, share a date of birth and at least 80% name-token similarity.',
    means: 'These records might describe the same person. They were not merged.',
    notMeans: 'A candidate match is inconclusive by design — similar names and shared birthdays are common.'
  },
  DEMO_INTAKE_LIMIT_EXCEEDED: {
    label: 'Configured intake limit exceeded',
    checks: 'Active enrolments for a programme and session (and seat category, if configured) exceed the configured prototype capacity. Each student identity is counted once, using its most recent source record.',
    means: 'More active records exist than the configured limit for this programme and session.',
    notMeans: 'Prototype capacity values are demonstration settings, not an official regulatory interpretation.'
  }
};

const OUTCOMES = {
  confirmed_discrepancy: {
    label: 'Confirm discrepancy',
    past: 'Confirmed discrepancy',
    desc: 'Evidence shows the records are inconsistent and need correction at source.',
    confirm: true
  },
  legitimate_exception: {
    label: 'Record legitimate exception',
    past: 'Legitimate exception',
    desc: 'A documented circumstance explains the signal, such as an approved transfer or dual programme.'
  },
  record_corrected: {
    label: 'Mark record corrected',
    past: 'Record corrected',
    desc: 'The source institution has corrected the underlying record.'
  },
  awaiting_verification: {
    label: 'Request further verification',
    past: 'Further verification requested',
    desc: 'Keep the finding open while authorised evidence is obtained.'
  },
  dismissed: {
    label: 'Dismiss with reason',
    past: 'Dismissed',
    desc: 'The signal does not warrant action. Your reason is kept in the audit history.',
    confirm: true
  }
};

const ruleLabel = code => RULES[code]?.label || String(code ?? '').replaceAll('_', ' ').toLowerCase();
const categoryLabel = code => CATEGORY[code] || ruleLabel(code);
const statusLabel = code => STATUS[code]?.label || String(code ?? '').replaceAll('_', ' ');
const SYSTEM_ACTIONS = {
  superseded: 'Superseded on recomputation',
  condition_cleared: 'Condition cleared on recomputation',
  resolved_by_correction: 'Resolved by a corrected source record',
  automatically_matched: 'Matched automatically under policy',
  automatic_match_withdrawn: 'Automatic match withdrawn',
  evidence_updated: 'Evidence extended by resubmission'
};
/* Reviewer decisions on potential matches (stored per identity link, audited on the finding). */
const MATCH_ACTIONS = {
  match_same_person: 'Recorded as the same person',
  match_different_person: 'Recorded as different people',
  match_needs_more_evidence: 'More evidence requested',
  match_reviewed: 'Identity pairs reviewed'
};
const LIFECYCLE = {
  superseded: { label: 'Superseded', icon: 'history' },
  cleared: { label: 'Condition cleared', icon: 'history' }
};
const isHistorical = finding => Boolean(finding.lifecycle_status) && finding.lifecycle_status !== 'current';
const outcomeLabel = code => OUTCOMES[code]?.past || MATCH_ACTIONS[code] || SYSTEM_ACTIONS[code] || String(code ?? '').replaceAll('_', ' ');
const isAwaitingAction = action => action === 'awaiting_verification' || action === 'match_needs_more_evidence';

function lifecycleBadge(finding) {
  if (!isHistorical(finding)) return '';
  const meta = LIFECYCLE[finding.lifecycle_status] || { label: finding.lifecycle_status, icon: 'history' };
  return `<span class="badge tone-neutral" title="Historical finding — kept for audit">${icon(meta.icon)}${esc(meta.label)}</span>`;
}

function auditBadge(event) {
  if (event.system) return `<span class="badge tone-neutral">${icon('rotate')}${esc(outcomeLabel(event.action))}</span>`;
  const awaiting = isAwaitingAction(event.action);
  return `<span class="badge ${awaiting ? 'st-awaiting_verification' : 'st-resolved'}">${icon(awaiting ? 'hourglass' : 'check')}${esc(outcomeLabel(event.action))}</span>`;
}

/* ── Formatting ───────────────────────────────── */
function fmtDate(iso, withTime = true) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', withTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

function relTime(iso) {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return plural(Math.round(seconds / 3600), 'hour') + ' ago';
  if (seconds < 86400 * 7) return plural(Math.round(seconds / 86400), 'day') + ' ago';
  return fmtDate(iso, false);
}

const shortId = id => String(id ?? '').slice(0, 8);

function institutionText(records) {
  const codes = [...new Set((records || []).map(r => r.institution_code))];
  return codes.join(' · ') || '—';
}

/* One readable line that distinguishes a finding from similar ones. */
function recordContext(finding) {
  const records = finding.records || [];
  if (!records.length) return 'Source records outside your access scope';
  const first = records[0];
  if (records.length > 4) {
    return `${first.institution_code} · ${first.programme} · ${first.academic_session} · ${plural(records.length, 'source record')}`;
  }
  const base = `${first.institution_code} · ${first.programme || 'Programme not set'} · Row ${first.source_row}`;
  if (records.length === 1) return base;
  const others = records.slice(1).map(r => `${r.institution_code} row ${r.source_row}`).join(', ');
  return `${base} ↔ ${others}`;
}

/* ── UI Primitives ────────────────────────────── */
function sevBadge(severity) {
  const meta = SEVERITY[severity] || { label: severity, icon: 'info' };
  return `<span class="badge sev-${esc(severity)}">${icon(meta.icon)}${esc(meta.label)}</span>`;
}

function statusBadge(status) {
  const meta = STATUS[status] || { label: status, icon: 'info' };
  return `<span class="badge st-${esc(status)}">${icon(meta.icon)}${esc(meta.label)}</span>`;
}

function emptyState({ iconName = 'inbox', title, text = '', action = '', compact = false, error = false }) {
  return `<div class="empty-state${compact ? ' compact' : ''}${error ? ' is-error' : ''}"${error ? ' role="alert"' : ''}>
    <span class="empty-icon">${icon(error ? 'alert-triangle' : iconName)}</span>
    <strong>${esc(title)}</strong>
    ${text ? `<p>${text}</p>` : ''}
    ${action}
  </div>`;
}

function errorState(message, retryAttr = '') {
  return emptyState({
    error: true,
    title: 'This section could not be loaded',
    text: esc(message),
    action: retryAttr ? `<button type="button" class="btn btn-secondary btn-sm" ${retryAttr}>${icon('rotate')}Try again</button>` : ''
  });
}

function skeletonLines(count = 3) {
  return Array.from({ length: count }, (_, i) => `<span class="skel skel-line" style="width:${92 - i * 14}%"></span>`).join('');
}

/* ── Toasts ───────────────────────────────────── */
function toast(message, { tone = 'info', title = '', timeout } = {}) {
  const region = $('#toasts');
  const el = document.createElement('div');
  const iconName = { success: 'check-circle', error: 'alert-octagon', warning: 'alert-triangle', info: 'info' }[tone] || 'info';
  el.className = `toast ${tone}`;
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.innerHTML = `${icon(iconName)}<div>${title ? `<strong>${esc(title)}</strong>` : ''}${esc(message)}</div>
    <button type="button" aria-label="Dismiss notification">${icon('x', 'icon-sm')}</button>`;
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 170);
  };
  el.querySelector('button').onclick = remove;
  region.append(el);
  while (region.children.length > 4) region.firstElementChild.remove();
  setTimeout(remove, timeout ?? (tone === 'error' ? 9000 : 5500));
}

/* ── Confirmation Dialog ──────────────────────── */
function confirmDialog({ title, body, confirmLabel = 'Confirm', tone = 'warning' }) {
  const dialog = $('#confirmDialog');
  $('#confirmTitle').textContent = title;
  $('#confirmBody').innerHTML = body;
  const ok = $('#confirmOk');
  ok.textContent = confirmLabel;
  ok.className = `btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`;
  $('#confirmIcon').className = `modal-icon${tone === 'danger' ? ' danger' : ''}`;
  const opener = document.activeElement;
  return new Promise(resolve => {
    dialog.returnValue = 'cancel';
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'confirm');
      if (opener && opener.isConnected) opener.focus();
    }, { once: true });
    dialog.showModal();
    $('#confirmCancel').focus();
  });
}

/* ── Clipboard ────────────────────────────────── */
async function copyText(text, label = 'Copied', button = null) {
  try {
    await navigator.clipboard.writeText(text);
    if (button?.isConnected) {
      const use = $('use', button);
      const original = use?.getAttribute('href');
      button.classList.add('is-copied');
      use?.setAttribute('href', '#i-check');
      setTimeout(() => { button.classList.remove('is-copied'); if (original) use.setAttribute('href', original); }, 1400);
    }
    toast(`${label} copied to the clipboard.`, { tone: 'success', timeout: 2500 });
  } catch {
    toast('The clipboard is unavailable in this browser context. Select the text and copy it manually.', { tone: 'warning' });
  }
}

/* ── Shared async-button feedback ─────────────────
   Busy while the request runs; a short confirmation only after the server has answered; a failure
   state if it did not. The button keeps its width, so nothing around it moves. Errors are re-thrown
   for the caller's own message. */
async function withFeedback(button, run, { done = 'Done', failed = 'Failed' } = {}) {
  if (!button) return run();
  if (button.dataset.state === 'busy') return undefined;
  const resting = button.cloneNode(true);
  resting.querySelectorAll('.ripple-host').forEach(node => node.remove());
  const html = resting.innerHTML;
  button.style.minWidth = `${Math.ceil(button.getBoundingClientRect().width)}px`;
  button.dataset.state = 'busy'; button.setAttribute('aria-busy', 'true'); button.disabled = true;
  const restore = () => { if (!button.isConnected) return; button.innerHTML = html; delete button.dataset.state; button.removeAttribute('aria-busy'); button.disabled = false; button.style.minWidth = ''; };
  try {
    const out = await run();
    if (button.isConnected) { button.dataset.state = 'done'; button.removeAttribute('aria-busy'); button.innerHTML = `${icon('check', 'icon-sm')}${esc(done)}`; setTimeout(restore, 1400); }
    return out;
  } catch (error) {
    if (button.isConnected) { button.dataset.state = 'failed'; button.removeAttribute('aria-busy'); button.innerHTML = `${icon('alert-triangle', 'icon-sm')}${esc(failed)}`; setTimeout(restore, 1800); }
    throw error;
  }
}

/* ── CSV Export (sends the demo role header) ──── */
async function downloadFindings(params = {}, button) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  try { await withFeedback(button, async () => {
    const response = await fetch(`${APP_BASE}/api/v1/reports/findings.csv` + (qs.toString() ? `?${qs}` : ''), {
      headers: { 'x-demo-role': state.role, 'x-demo-institution': state.institution }
    });
    if (!response.ok) throw new Error(`Export failed with status ${response.status}.`);
    const text = await response.text();
    const rows = Math.max(text.trim().split('\n').length - 1, 0);
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `edutrace-findings-${state.role === 'regulator' ? 'regulator' : 'nitm'}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`${plural(rows, 'finding')} exported from your current access scope${qs.toString() ? ' and filters' : ''}. Identifiers in the file are internal record IDs, not APAAR values.`, { tone: 'success', title: 'Export ready' });
  }, { done: 'Exported', failed: 'Export failed' }); } catch (error) {
    toast(error.message, { tone: 'error', title: 'Export failed' });
  }
}

/* ── Router ───────────────────────────────────── */
const views = {};
const VIEW_TITLES = {
  overview: 'Overview',
  import: 'Import data',
  reconciliation: 'Reconciliation',
  graph: 'Integrity graph',
  matches: 'Potential matches',
  profile: 'Student profile',
  audit: 'Audit history'
};

function registerView(name, definition) { views[name] = definition; }

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return { view: VIEW_TITLES[path] ? path : 'overview', params: new URLSearchParams(query) };
}

function routeHash(view, params = {}) {
  const entries = params instanceof URLSearchParams ? [...params] : Object.entries(params);
  const qs = new URLSearchParams(entries.filter(([, v]) => v !== '' && v != null)).toString();
  return `#/${view}${qs ? `?${qs}` : ''}`;
}

function go(view, params) {
  const hash = routeHash(view, params);
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

function replaceRoute(view, params) {
  history.replaceState(null, '', routeHash(view, params));
}

let firstRender = true;
function renderRoute({ force = false } = {}) {
  const { view, params } = parseRoute();
  const changed = view !== state.view;
  if (changed && state.view) views[state.view]?.leave?.();
  state.view = view;

  $$('.view').forEach(section => { section.hidden = section.dataset.view !== view; });
  $$('.nav-item').forEach(link => {
    if (link.dataset.route === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#crumbCurrent').textContent = VIEW_TITLES[view];
  document.title = `${VIEW_TITLES[view]} · EduTrace AI`;
  $('#globalSearch').hidden = view === 'reconciliation' || view === 'graph';
  closeNav(false);

  if (changed && !firstRender) {
    window.scrollTo(0, 0);
    $(`#view-${view} .page-title`)?.focus({ preventScroll: true });
  }
  if (changed) enterView($(`#view-${view}`));
  firstRender = false;
  views[view]?.enter(params, { changed: changed || force });
}

/* ── Motion primitives ────────────────────────── */
/* Shared, restrained motion: a view entrance, a ripple on primary actions and the theme reveal.
   Each is skipped under prefers-reduced-motion, cleans up after itself and never stands in for
   a result: success and failure states still come only from the server's answer. */
const motionOff = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let enterTimer;
function enterView(section) {
  if (!section) return;
  $$('.view.is-entering').forEach(view => view.classList.remove('is-entering'));
  clearTimeout(enterTimer);
  if (motionOff()) return;
  void section.offsetWidth;
  section.classList.add('is-entering');
  enterTimer = setTimeout(() => section.classList.remove('is-entering'), 1400);
}

/* One ripple per press, on primary and destructive buttons only; it removes itself. */
document.addEventListener('pointerdown', event => {
  const button = event.target.closest('.btn-primary, .btn-danger');
  if (!button || event.button !== 0 || button.disabled || button.getAttribute('aria-disabled') === 'true' || motionOff()) return;
  const rect = button.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 2.2;
  button.querySelector(':scope > .ripple-host')?.remove();
  const host = document.createElement('span');
  host.className = 'ripple-host';
  host.setAttribute('aria-hidden', 'true');
  const wave = document.createElement('span');
  wave.className = 'ripple';
  wave.style.cssText = `width:${size}px;height:${size}px;left:${event.clientX - rect.left - size / 2}px;top:${event.clientY - rect.top - size / 2}px`;
  host.append(wave);
  button.append(host);
  wave.addEventListener('animationend', () => host.remove(), { once: true });
});

/* Theme switch: a circular reveal from the toggle where the View Transitions API exists;
   otherwise (or under reduced motion) the theme changes at once. */
function themeReveal(origin, apply) {
  if (!document.startViewTransition || motionOff()) { apply(); return; }
  const r = origin.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const root = document.documentElement;
  root.classList.add('theme-revealing');
  const transition = document.startViewTransition(apply);
  transition.ready.then(() => {
    root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' });
  }).catch(() => {});
  transition.finished.finally(() => root.classList.remove('theme-revealing'));
}

/* ── Shell: Navigation ────────────────────────── */
const mobileQuery = window.matchMedia('(max-width: 767px)');

function openNav() {
  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  sidebar.classList.add('is-open');
  scrim.hidden = false;
  requestAnimationFrame(() => scrim.classList.add('is-visible'));
  $('#menuBtn').setAttribute('aria-expanded', 'true');
  $('.nav-item[aria-current="page"]', sidebar)?.focus();
}

function closeNav(restoreFocus = true) {
  const sidebar = $('#sidebar');
  if (!sidebar.classList.contains('is-open')) return;
  sidebar.classList.remove('is-open');
  const scrim = $('#scrim');
  scrim.classList.remove('is-visible');
  setTimeout(() => { scrim.hidden = true; }, 200);
  $('#menuBtn').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('#menuBtn').focus();
}

function initShell() {
  $('#menuBtn').onclick = openNav;
  $('#sidebarClose').onclick = () => closeNav();
  $('#scrim').onclick = () => closeNav();

  /* Desktop compact mode (persisted per viewer) */
  const shell = $('#shell');
  const toggle = $('#collapseToggle');
  const applySidebar = mode => {
    shell.dataset.sidebar = mode;
    const compact = mode === 'compact';
    toggle.setAttribute('aria-pressed', String(compact));
    toggle.setAttribute('aria-label', compact ? 'Expand sidebar' : 'Collapse sidebar');
    toggle.dataset.tip = 'Expand sidebar';
    $('.nav-label', toggle).textContent = compact ? 'Expand sidebar' : 'Collapse sidebar';
  };
  applySidebar(readStore('edutrace.sidebar', 'expanded', 'localStorage'));
  toggle.onclick = () => {
    const next = shell.dataset.sidebar === 'compact' ? 'expanded' : 'compact';
    applySidebar(next);
    writeStore('edutrace.sidebar', next, 'localStorage');
  };

  /* Compact demo indicator opens the role menu */
  $('#demoCompact').onclick = () => openScopeMenu();

  /* Scope / role menu */
  $('#scopeChip').onclick = () => ($('#scopeMenu').hidden ? openScopeMenu() : closeScopeMenu());
  $$('.scope-option').forEach(option => {
    option.onclick = () => { closeScopeMenu(); setRole(option.dataset.role); };
  });
  $('#scopeMenu').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const options = $$('.scope-option');
    const index = options.indexOf(document.activeElement);
    options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
  });
  $('.scope-wrap').addEventListener('focusout', event => {
    if (!$('#scopeMenu').hidden && event.relatedTarget && !event.relatedTarget.closest('.scope-wrap')) closeScopeMenu(false);
  });
  document.addEventListener('click', event => {
    if (!$('#scopeMenu').hidden && !event.target.closest('.scope-wrap') && !event.target.closest('#demoCompact')) closeScopeMenu(false);
  });

  /* Theme: saved choice wins; otherwise follow the system setting */
  syncThemeToggle();
  $('#themeToggle').onclick = event => {
    const button = event.currentTarget;
    button.classList.remove('is-switching'); void button.offsetWidth; button.classList.add('is-switching');
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    const apply = () => {
      document.documentElement.dataset.theme = next;
      writeStore('edutrace.theme', next, 'localStorage');
      syncThemeToggle();
    };
    themeReveal(button, apply);
  };
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', event => {
    if (readStore('edutrace.theme', null, 'localStorage')) return;
    document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
    syncThemeToggle();
  });

  $('#roleSelect').onchange = event => setRole(event.target.value);
  $('#resetDemo').onclick = resetDemo;
  $('#exportAll').onclick = event => downloadFindings({}, event.currentTarget);

  /* Global search */
  $('#globalSearch').onsubmit = event => {
    event.preventDefault();
    const q = $('#globalQuery').value.trim();
    $('#globalQuery').value = '';
    go('reconciliation', q ? { q } : {});
  };

  /* Keyboard: "/" focuses the contextual search, Escape closes overlays */
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!$('#scopeMenu').hidden) { closeScopeMenu(); return; }
      if ($('#sidebar').classList.contains('is-open')) { closeNav(); return; }
    }
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target.closest('input, textarea, select, [contenteditable="true"]') || $('dialog[open]')) return;
    event.preventDefault();
    const field = state.view === 'reconciliation' ? $('#rxQuery')
      : state.view === 'graph' ? $('#gQuery')
      : mobileQuery.matches ? null : $('#globalQuery');
    if (field) field.focus();
    else go('reconciliation', { focus: 'search' });
  });

  window.addEventListener('hashchange', handleEntryNavigation);
  window.addEventListener('popstate', handleEntryNavigation);
}

function syncThemeToggle() {
  const dark = document.documentElement.dataset.theme === 'dark';
  const label = dark ? 'Switch to light theme' : 'Switch to dark theme';
  const button = $('#themeToggle');
  button.setAttribute('aria-label', label);
  button.title = label;
  $('use', button).setAttribute('href', dark ? '#i-sun' : '#i-moon');
  $('meta[name="theme-color"]').content = dark ? '#0A0A0A' : '#3A0F34';
}

function openScopeMenu() {
  const menu = $('#scopeMenu');
  menu.hidden = false;
  $('#scopeChip').setAttribute('aria-expanded', 'true');
  $('.scope-option[aria-checked="true"]', menu)?.focus();
}

function closeScopeMenu(restoreFocus = true) {
  const menu = $('#scopeMenu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('#scopeChip').setAttribute('aria-expanded', 'false');
  if (restoreFocus) $('#scopeChip').focus();
}

/* ── Demo Role (simulation, not authentication) ─ */
function syncRoleControls() {
  if (state.auth && state.auth !== 'demo_header') return; /* signed in: no simulated role to choose */
  $('#roleSelect').value = state.role;
  $$('.scope-option').forEach(option => option.setAttribute('aria-checked', String(option.dataset.role === state.role)));
  const label = state.role === 'regulator' ? 'Regulator' : 'NITM institution';
  $('#scopeText').textContent = `Demo · ${label}`;
  $('#scopeChip').title = `Simulated access role: ${state.role === 'regulator' ? 'Regulator (all institutions)' : 'NITM institution'}. Click to change.`;
  $('#demoCompact').dataset.tip = `Demo simulation · ${state.role === 'regulator' ? 'Regulator' : 'NITM institution'}`;
  const reset = $('#resetDemo');
  reset.disabled = state.readOnly || state.role !== 'regulator';
  reset.title = state.readOnly ? 'Reset is disabled in the read-only demo' : state.role === 'regulator' ? 'Restore the seeded synthetic dataset' : 'Only the demo regulator can reset synthetic data';
}

async function setRole(role) {
  if (role !== 'regulator' && role !== 'institution') return;
  if (role === state.role) { syncRoleControls(); return; }
  state.role = role;
  state.institution = 'NITM';
  lastMetrics.clear(); /* a scope change is not a change in the underlying values */
  writeStore('edutrace.role', role);
  syncRoleControls();
  await refreshPrincipal();
  renderRoute({ force: true });
  toast(role === 'regulator'
    ? 'Now viewing all three synthetic institutions as the demo regulator.'
    : 'Now viewing Northbridge Institute of Technology (NITM) only. Other institutions’ records are hidden by the server.',
  { title: 'Demo scope changed' });
}

async function refreshPrincipal() {
  try {
    const response = await api('/api/v1/dashboard/summary');
    state.summary = response.data;
    state.principal = response.principal;
    const pending = response.data.pending_decisions;
    const badge = $('#navPending');
    badge.hidden = !pending;
    badge.textContent = pending;
    badge.title = `${plural(pending, 'finding')} pending review`;
  } catch {
    /* The active view shows its own error state. */
  }
  await refreshMatchCount();
}

/* Number of potential matches still needing a reviewer, shown beside the nav item. */
async function refreshMatchCount(counts) {
  try {
    const data = counts || (await api('/api/v1/matches')).counts;
    const open = data.needs_review + data.needs_more_evidence;
    const badge = $('#navMatchCount');
    badge.hidden = !open;
    badge.textContent = open;
    badge.title = `${plural(open, 'potential match', 'potential matches')} awaiting a decision`;
  } catch { /* the matches view shows its own error state */ }
}

async function resetDemo() {
  const ok = await confirmDialog({
    title: 'Reset the synthetic demo data?',
    body: '<p>This restores the 360 seeded synthetic records and removes every imported batch, review decision and audit event stored in <code>data/demo-db.json</code>.</p><p>This cannot be undone.</p>',
    confirmLabel: 'Reset demo data',
    tone: 'danger'
  });
  if (!ok) return;
  const button = $('#resetDemo');
  button.disabled = true;
  try {
    await api('/api/v1/demo/reset', { method: 'POST', body: '{}' });
    toast('The seeded synthetic dataset has been restored.', { tone: 'success', title: 'Demo reset' });
    await refreshPrincipal();
    renderRoute({ force: true });
  } catch (error) {
    toast(error.message, { tone: 'error', title: 'Reset failed' });
  } finally {
    syncRoleControls();
  }
}

/* ── Overview ─────────────────────────────────── */
let overviewToken = 0;

registerView('overview', {
  enter() { loadOverview(); }
});

async function loadOverview() {
  const token = ++overviewToken;
  $('#ovMetrics').setAttribute('aria-busy', 'true');
  $('#ovMetrics').innerHTML = Array.from({ length: 4 }, () => '<span class="skel skel-metric"></span>').join('');
  $('#ovNext').innerHTML = '<span class="skel skel-line" style="width:55%"></span>';
  ['#ovAttention', '#ovAutomation', '#ovNotices'].forEach(id => { $(id).innerHTML = `<div class="ov-pad">${skeletonLines(3)}</div>`; });

  const [summaryRes, findingsRes, importsRes, automationRes, noticesRes, matchesRes, correctionsRes] = await Promise.allSettled([
    api('/api/v1/dashboard/summary'),
    api('/api/v1/findings'),
    api('/api/v1/imports'),
    api('/api/v1/automation'),
    api('/api/v1/notifications'),
    api('/api/v1/matches'),
    api('/api/v1/corrections')
  ]);
  if (token !== overviewToken) return;
  state.pendingCorrections = correctionsRes.status === 'fulfilled' ? correctionsRes.value.pending : 0;
  $('#ovMetrics').removeAttribute('aria-busy');
  if (summaryRes.status === 'fulfilled') state.summary = summaryRes.value.data;
  if (matchesRes.status === 'fulfilled') refreshMatchCount(matchesRes.value.counts);
  $('#ovScope').textContent = summaryRes.status === 'fulfilled' ? ` · ${scopeLabel(scopeInstitution(), summaryRes.value.data.institutions)}` : '';
  renderMetrics(summaryRes, automationRes, findingsRes, importsRes);
  renderNext(findingsRes);
  renderAttention(findingsRes, matchesRes);
  renderAutomation(automationRes);
  renderNotifications(noticesRes);
}

/* Four headline metrics. Each value is a server count for the current access scope, and each
   tooltip states the server's definition, so "open findings", "pending review" and "validation
   issues" (shown under Needs attention) never mean the same thing. */
function renderMetrics(summaryRes, automationRes, findingsRes, importsRes) {
  const el = $('#ovMetrics');
  if (summaryRes.status === 'rejected') {
    el.innerHTML = `<div class="card ov-metrics-error">${errorState(summaryRes.reason.message, 'data-retry-overview')}</div>`;
    $('[data-retry-overview]')?.addEventListener('click', loadOverview);
    return;
  }
  const d = summaryRes.value.data;
  const hostedViewer = state.auth === 'hosted_demo';
  const syntheticTest = state.runtime?.mode === 'synthetic-test';
  const a = automationRes.status === 'fulfilled' ? automationRes.value.data : null;
  const findings = findingsRes.status === 'fulfilled' ? findingsRes.value.data : null;
  const batches = importsRes.status === 'fulfilled' ? importsRes.value.data : null;
  const open = findings ? findings.filter(f => f.review_status !== 'resolved') : [];
  const highOpen = (hostedViewer ? (findings || []).filter(f => f.severity === 'high') : open.filter(f => f.severity === 'high')).length;
  const awaiting = hostedViewer ? 0 : d.by_status.find(s => s.status === 'awaiting_verification')?.count ?? 0;
  const cards = [
    {
      label: syntheticTest ? 'Records in current institution' : 'Imported records', iconName: 'database', value: d.imported_records,
      foot: syntheticTest ? `${d.seeded_fixture_records} seeded fixtures · ${d.session_imported_records} imported this session` : batches ? `${plural(batches.length, 'import batch', 'import batches')}` : plural(d.institutions, 'institution'),
      tip: d.metric_definitions.imported_records, href: '#/audit?tab=imports', linkText: 'View import batches'
    },
    {
      label: 'Automatically processed', iconName: 'check-circle', tone: 'is-success', value: a ? a.automatic : null,
      foot: a ? (hostedViewer ? `${a.automatic} of ${a.records} records` : `${pct(a.automatic_rate)} with no open finding`) : 'Unavailable',
      tip: a ? (hostedViewer ? 'Records processed automatically by deterministic rules. This is not identity verification.' : `${a.rate_definition} This is not authoritative identifier verification.`) : 'Processing outcomes could not be loaded.'
    },
    {
      label: hostedViewer ? 'Current findings' : 'Open findings', iconName: 'alert-triangle', tone: 'is-warning', value: hostedViewer ? d.accessible_findings : d.open_findings,
      foot: findings ? (highOpen ? `${highOpen} high severity` : 'None high severity') : `of ${d.accessible_findings} current`,
      tip: hostedViewer ? 'Current synthetic rule findings in the demo dataset.' : d.metric_definitions.open_findings, href: '#/reconciliation', linkText: 'Browse findings'
    },
    ...(!hostedViewer ? [{
      label: 'Pending review', iconName: 'clock', tone: 'is-pending', value: d.pending_decisions,
      foot: awaiting ? `${awaiting} awaiting verification` : 'No decision recorded yet',
      tip: d.metric_definitions.pending_decisions, href: '#/reconciliation?status=pending', linkText: 'View findings pending review'
    }] : [])
  ];
  el.innerHTML = cards.map(card => `
    <article class="metric${card.href ? ' is-link' : ''}">
      <div class="metric-top">
        <span class="metric-icon ${card.tone || ''}">${icon(card.iconName)}</span>
        ${card.href
          ? `<a class="metric-label metric-link" href="${card.href}" aria-label="${esc(`${card.label}: ${card.value ?? 'unavailable'}. ${card.linkText}`)}">${esc(card.label)}</a>`
          : `<span class="metric-label">${esc(card.label)}</span>`}
        <button type="button" class="tip" data-tip="${esc(card.tip)}" aria-label="${esc(`Definition of ${card.label}: ${card.tip}`)}">${icon('help', 'icon-sm')}</button>
      </div>
      <div class="metric-value" data-metric="${esc(card.label)}" data-value="${Number(card.value) || 0}">${card.value == null ? '—' : fmtNum(lastMetrics.get(card.label) ?? card.value)}</div>
      <div class="metric-foot">${esc(card.foot)}</div>
      ${card.href ? `<span class="metric-go" aria-hidden="true">${icon('arrow-right', 'icon-sm')}</span>` : ''}
    </article>`).join('');
  $$('#ovMetrics [data-metric]').forEach(metric => {
    if (metric.textContent === '—') return;
    const to = Number(metric.dataset.value);
    const from = lastMetrics.get(metric.dataset.metric);
    lastMetrics.set(metric.dataset.metric, to);
    if (from == null && !metricsIntroShown) countTo(metric, 0, to, { intro: true });
    else if (from != null && from !== to) countTo(metric, from, to);
  });
  metricsIntroShown = true;
}

/* Remembers the last value shown per metric so a number animates only when
   the underlying server value actually changed (for example after a decision). */
const lastMetrics = new Map();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
/* The count-up from zero runs once per page load, on the first server answer; later visits
   show the stored value and animate only a real change. */
let metricsIntroShown = false;

function countTo(el, from, to, { intro = false } = {}) {
  if (!intro) {
    el.classList.add('is-changed');
    setTimeout(() => el.classList.remove('is-changed'), 900);
  }
  if (reducedMotion.matches) { el.textContent = fmtNum(to); return; }
  if (intro) el.textContent = fmtNum(from);
  const start = performance.now();
  const duration = intro ? 900 : 420;
  const step = now => {
    const t = Math.min((now - start) / duration, 1);
    const eased = 1 - (1 - t) ** 3;
    el.textContent = fmtNum(Math.round(from + (to - from) * eased));
    if (t < 1 && el.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* Ordering used to pick the suggested next step: pending first, then severity, then age. */
function priorityOrder(findings) {
  return [...findings].sort((a, b) =>
    (STATUS[a.review_status]?.rank ?? 9) - (STATUS[b.review_status]?.rank ?? 9) ||
    (SEVERITY[b.severity]?.rank ?? 0) - (SEVERITY[a.severity]?.rank ?? 0) ||
    String(a.created_at).localeCompare(String(b.created_at)));
}

/* One action: the first unresolved finding in queue order. */
function renderNext(findingsRes) {
  const el = $('#ovNext');
  if (findingsRes.status === 'rejected') { el.innerHTML = ''; return; }
  const findings = findingsRes.value.data;
  const next = priorityOrder(findings.filter(f => f.review_status !== 'resolved'))[0];
  if (!findings.length) {
    el.innerHTML = `<div class="ov-next-inner"><span class="ov-next-label">${icon('arrow-right', 'icon-xs')}Suggested next step</span>
      <p class="ov-next-text">Import student data to run the reconciliation checks.</p>
      <a class="btn btn-secondary btn-sm" href="#/import">Import data${icon('arrow-right', 'icon-xs')}</a></div>`;
    return;
  }
  el.innerHTML = next
    ? `<div class="ov-next-inner">
        <span class="ov-next-label">${icon('arrow-right', 'icon-xs')}Suggested next step</span>
        <p class="ov-next-text">Review the highest-priority unresolved finding: <strong>${esc(next.title)}</strong>
          <span class="ov-next-meta">${esc(SEVERITY[next.severity]?.label || next.severity)} severity · ${esc(institutionText(next.records))}</span></p>
        <a class="btn btn-primary btn-sm" href="${routeHash('reconciliation', { finding: next.id })}">Open finding${icon('arrow-right', 'icon-xs')}</a>
      </div>`
    : `<div class="ov-next-inner is-clear">
        <span class="ov-next-label">${icon('check-circle', 'icon-xs')}Up to date</span>
        <p class="ov-next-text">Every current finding has a recorded decision.</p>
        <a class="btn btn-secondary btn-sm" href="#/audit">Audit history${icon('arrow-right', 'icon-xs')}</a>
      </div>`;
}

/* "Needs attention": open findings grouped into a few categories. Findings pending review are
   grouped by kind; findings awaiting verification form their own group, so no finding is
   counted twice. Explanations stay in the finding drawer. */
const ATTENTION_GROUPS = [
  {
    key: 'information', title: 'Missing or malformed information', iconName: 'alert-triangle',
    match: f => f.review_status === 'pending' && (f.category === 'identifier' || f.rule_code === 'REQUIRED_FIELD_MISSING'),
    parts: [['APAAR_MISSING', 'missing APAAR ID', 'missing APAAR IDs'], ['APAAR_MALFORMED', 'malformed APAAR ID', 'malformed APAAR IDs'], ['REQUIRED_FIELD_MISSING', 'required value missing', 'required values missing']],
    target: () => ({ href: routeHash('reconciliation', { category: 'identifier', status: 'pending' }), label: 'Review' })
  },
  {
    key: 'identity', title: 'Identity conflicts and candidate matches', iconName: 'git-merge',
    match: f => f.review_status === 'pending' && ['conflict', 'candidate', 'duplicate'].includes(f.category),
    parts: [['IDENTIFIER_ATTRIBUTE_CONFLICT', 'shared-identifier conflict', 'shared-identifier conflicts'], ['CANDIDATE_IDENTITY_MATCH', 'candidate match', 'candidate matches'], ['DUPLICATE_IDENTIFIER', 'repeated identifier', 'repeated identifiers']],
    target: (list, matches) => matches?.counts && matches.counts.needs_review + matches.counts.needs_more_evidence
      ? { href: '#/matches', label: 'Compare pairs' }
      : { href: list.length === 1 ? routeHash('reconciliation', { finding: list[0].id }) : routeHash('reconciliation', { category: [...new Set(list.map(f => f.category))].sort().join(','), status: 'pending' }), label: 'Review' }
  },
  {
    key: 'capacity', title: 'Capacity and enrolment alerts', iconName: 'scale',
    match: f => f.review_status === 'pending' && ['capacity', 'enrolment'].includes(f.category),
    parts: [['DEMO_INTAKE_LIMIT_EXCEEDED', 'intake limit exceeded', 'intake limits exceeded'], ['POTENTIAL_CONCURRENT_ENROLMENT', 'concurrent enrolment', 'concurrent enrolments']],
    target: list => ({ href: list.length === 1 ? routeHash('reconciliation', { finding: list[0].id }) : routeHash('reconciliation', { category: [...new Set(list.map(f => f.category))].sort().join(','), status: 'pending' }), label: 'Review' })
  },
  {
    key: 'verification', title: 'Waiting for verification', iconName: 'hourglass',
    match: f => f.review_status === 'awaiting_verification',
    parts: [],
    detail: list => `${plural(list.length, 'finding')} kept open until authorised evidence arrives`,
    target: () => ({ href: routeHash('reconciliation', { status: 'awaiting_verification' }), label: 'Follow up' })
  }
];

function renderAttention(findingsRes, matchesRes) {
  const el = $('#ovAttention');
  const all = $('#ovAttentionAll');
  if (findingsRes.status === 'rejected') { all.hidden = true; el.innerHTML = `<div class="ov-pad">${errorState(findingsRes.reason.message, 'data-retry-attention')}</div>`; $('[data-retry-attention]')?.addEventListener('click', loadOverview); return; }
  const findings = findingsRes.value.data;
  const matches = matchesRes.status === 'fulfilled' ? matchesRes.value : null;
  const open = findings.filter(f => f.review_status !== 'resolved');
  const grouped = new Set();
  const groups = ATTENTION_GROUPS.map(group => {
    const list = open.filter(f => !grouped.has(f.id) && group.match(f));
    list.forEach(f => grouped.add(f.id));
    return { group, list, high: list.filter(f => f.severity === 'high').length };
  });
  const other = open.filter(f => !grouped.has(f.id));
  if (other.length) groups.push({ group: { key: 'other', title: 'Other findings', iconName: 'reconcile', parts: [], detail: list => `${plural(list.length, 'finding')} pending review`, target: () => ({ href: routeHash('reconciliation', { status: 'pending' }), label: 'Review' }) }, list: other, high: other.filter(f => f.severity === 'high').length });
  const shown = groups.filter(g => g.list.length).sort((a, b) => b.high - a.high || b.list.length - a.list.length);
  // Possible corrections are source-record versioning, not findings: a separate, compact row.
  if (state.pendingCorrections) shown.push({ group: { key: 'correction', title: 'Possible corrections to confirm', iconName: 'file', parts: [], detail: () => `${plural(state.pendingCorrections, 'later row')} may replace an earlier version`, target: () => ({ href: '#/import', label: 'Review' }) }, list: Array.from({ length: state.pendingCorrections }), high: 0 });
  all.hidden = !open.length;
  if (!shown.length) {
    el.innerHTML = `<div class="ov-pad">${emptyState({ compact: true, iconName: 'check-circle', title: findings.length ? 'Nothing needs attention' : 'No findings yet', text: findings.length ? 'Every current finding has a recorded decision.' : 'Findings appear here after an import.' })}</div>`;
    return;
  }
  const rows = shown.slice(0, 3).map(({ group, list, high }) => {
    const detail = group.detail ? group.detail(list) : group.parts.map(([code, one, many]) => [list.filter(f => f.rule_code === code).length, one, many]).filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).join(' · ');
    const target = group.target(list, matches);
    return `<li>
      <a class="att-row" href="${target.href}" aria-label="${esc(`${group.title}: ${list.length}. ${detail}. ${target.label}`)}">
        <span class="att-icon att-${group.key}">${icon(group.iconName, 'icon-sm')}</span>
        <span class="att-text"><span class="att-title">${esc(group.title)}</span><span class="att-detail">${esc(detail)}${high ? ` · <span class="att-high">${high} high</span>` : ''}</span></span>
        <span class="att-count">${list.length}</span>
        <span class="att-go">${esc(target.label)}${icon('chevron-right', 'icon-xs')}</span>
      </a>
    </li>`;
  }).join('');
  el.innerHTML = `<ul class="att-list">${rows}</ul>${shown.length > 3 ? `<p class="ov-more"><a href="#/reconciliation">${plural(shown.length - 3, 'more category', 'more categories')}</a></p>` : ''}`;
}

/* ── Overview: automated processing ───────────── */
const PROCESSING_LABELS = {
  automatically_processed: 'Automatically processed',
  automatically_normalised: 'Automatically normalised',
  safely_matched: 'Safely matched',
  needs_institution_correction: 'Needs institution correction',
  needs_investigation: 'Needs investigation',
  verification_pending: 'Authoritative verification pending',
  processing_failed: 'Processing failed'
};
const PROCESSING_ORDER = ['automatically_processed', 'automatically_normalised', 'safely_matched', 'needs_institution_correction', 'needs_investigation', 'verification_pending', 'processing_failed'];
const NOTICE_KIND = {
  correction: { label: 'Correction', tone: 'tone-warning' },
  investigation: { label: 'Investigation', tone: 'tone-danger' },
  verification: { label: 'Verification', tone: 'st-awaiting_verification' },
  processing_failed: { label: 'Row rejected', tone: 'tone-danger' }
};
const NOTICE_ORIGIN = { import: 'Import', revalidation: 'Re-run', migration: 'Rules upgrade', seed: 'Demo seed', correction: 'Confirmed correction' };
const pct = rate => `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;

function renderAutomation(res) {
  const el = $('#ovAutomation');
  $('#ovAutomationAction').innerHTML = state.role === 'regulator'
    ? `<button type="button" class="btn btn-ghost btn-xs" id="ovRevalidate" title="Re-run every rule over all persisted records. Unchanged findings are kept and are not notified again.">${icon('rotate', 'icon-xs')}Re-run</button>`
    : '';
  $('#ovRevalidate')?.addEventListener('click', revalidateAll);
  if (res.status === 'rejected') { el.innerHTML = `<div class="ov-pad">${errorState(res.reason.message)}</div>`; return; }
  const a = res.value.data;
  if (!a.records) {
    el.innerHTML = `<div class="ov-pad">${emptyState({ compact: true, iconName: 'database', title: 'No records in your scope yet', text: 'Processing outcomes appear after an import.' })}</div>`;
    return;
  }
  const statuses = PROCESSING_ORDER.filter(key => a.by_status[key]);
  const v = a.verification || {};
  const ai = a.ai || {};
  const hostedViewer = state.auth === 'hosted_demo';
  const definition = hostedViewer
    ? 'Records processed automatically by deterministic rules. This is not identity verification.'
    : `${a.rate_definition} ${v.authoritatively_verified ?? 0} identifiers are authoritatively verified: no verification service is connected, so this is not identity verification.`;
  el.innerHTML = `
    <div class="ap-rate">
      <span class="ap-pct">${hostedViewer ? fmtNum(a.automatic) : esc(pct(a.automatic_rate))}</span>
      <span class="ap-sub">${fmtNum(a.automatic)} of ${plural(a.records, 'record')} ${hostedViewer ? 'processed automatically' : 'processed with no open finding'}
        <button type="button" class="tip" data-tip="${esc(definition)}" aria-label="${esc(`How this is measured: ${definition}`)}">${icon('help', 'icon-sm')}</button></span>
    </div>
    <div class="meter-bar ap-bar" role="img" aria-label="${esc(statuses.map(key => `${a.labels[key]}: ${a.by_status[key]}`).join(', '))}">
      ${statuses.map(key => `<span class="meter-seg po-${key}" style="flex:${a.by_status[key]}" title="${esc(`${a.labels[key]}: ${a.by_status[key]}`)}"></span>`).join('')}
    </div>
    <ul class="ap-breakdown">${statuses.map(key => `<li><span class="swatch po-${key}"></span><span>${esc(a.labels[key])}</span><strong>${fmtNum(a.by_status[key])}</strong></li>`).join('')}</ul>
    <div class="ap-ai" id="ovAiStatus">${aiStatusHtml(ai)}</div>`;
  $('#ovAiCheck')?.addEventListener('click', checkAi);
}

/* One line for the model provider; the full detail is in the title and the Check result. */
const AI_HEALTH_TONE = { disabled: 'tone-neutral', not_configured: 'tone-neutral', configured_untested: 'st-awaiting_verification', available: 'tone-success', temporarily_unavailable: 'tone-warning', recoverable_error: 'tone-warning', misconfigured: 'tone-danger' };
function aiStatusHtml(ai) {
  const h = ai.health || { state: 'not_configured', label: 'Not configured' };
  const used = Object.values(ai.usage || {}).reduce((n, t) => n + t.calls, 0);
  const what = ai.configured ? `${ai.provider_label || ai.provider} · ${ai.model}` : 'Off — deterministic rules only';
  const detail = [
    ai.configured ? 'Advisory only; it never changes findings, review status or identity links.' : (ai.reason || 'No model provider is configured.'),
    h.last_error && h.state !== 'available' ? `Last error ${relTime(h.last_error.at)}: ${h.last_error.message}.` : '',
    h.last_success_at ? `Last successful call ${relTime(h.last_success_at)}${used ? `, ${plural(used, 'call')} since the server started` : ''}.` : ''
  ].filter(Boolean).join(' ');
  return `${icon(ai.configured ? 'flask' : 'info', 'icon-xs')}
    <span class="ap-ai-text" title="${esc(detail)}"><strong>Model assistance</strong> <span class="badge badge-plain ${AI_HEALTH_TONE[h.state] || 'tone-neutral'}">${esc(h.label)}</span> <span class="subtle">${esc(what)}</span>
      ${h.last_error && h.state !== 'available' ? `<span class="ap-ai-error">${esc(h.last_error.message)}</span>` : ''}<span class="sr-only">${esc(detail)}</span></span>
    ${ai.configured && state.role === 'regulator' ? `<button type="button" class="btn btn-ghost btn-xs" id="ovAiCheck" title="Send one synthetic test request to the configured provider">${icon('rotate', 'icon-xs')}Check</button>` : ''}`;
}

async function checkAi(event) {
  const button = event.currentTarget;
  button.dataset.state = 'busy';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const result = (await api('/api/v1/ai/check', { method: 'POST' })).data;
    const ai = (await api('/api/v1/ai/status')).data;
    $('#ovAiStatus').innerHTML = aiStatusHtml(ai);
    $('#ovAiCheck')?.addEventListener('click', checkAi);
    $('#ovAiCheck')?.focus();
    toast(result.ok ? `The provider answered a synthetic test request in ${result.latency_ms} ms.` : result.reason, { tone: result.ok ? 'success' : 'error', title: `Model assistance: ${result.health.label}` });
  } catch (error) {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    toast(error.message, { tone: 'error', title: 'Check failed' });
  }
}

async function revalidateAll(event) {
  const button = event.currentTarget;
  const label = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `${icon('rotate', 'icon-xs')}Re-running…`;
  try {
    const r = (await api('/api/v1/automation/revalidate', { method: 'POST' })).data;
    const changed = r.created + r.superseded + r.cleared + (r.evidence_updated || 0) + r.auto_matched + r.withdrawn;
    toast(changed
      ? `${plural(r.created, 'new finding')}, ${r.superseded} superseded, ${r.cleared} cleared, ${r.auto_matched} matched automatically; ${plural(r.notified, 'exception')} notified.`
      : `No changes: all ${plural(r.unchanged, 'current finding')} still describe the data. Nothing was notified.`, { tone: 'success', title: 'Reconciliation re-run' });
    await loadOverview();
    $('#ovRevalidate')?.focus();
  } catch (error) {
    toast(error.message, { tone: 'error', title: 'Re-run failed' });
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = label;
  }
}

/* ── Overview: exception notifications ────────── */
/* The three most recent batches: where, which batch, how many new or changed exceptions and of
   which kind. Each opens the findings from that batch; details stay in the finding drawer. */
function renderNotifications(res) {
  const el = $('#ovNotices');
  const count = $('#ovNoticeCount');
  if (res.status === 'rejected') { count.hidden = true; el.innerHTML = `<div class="ov-pad">${errorState(res.reason.message)}</div>`; return; }
  const { data: list, unacknowledged } = res.value;
  count.hidden = !list.length;
  count.textContent = unacknowledged ? `${unacknowledged} unacknowledged` : 'All acknowledged';
  count.className = `badge badge-plain ${unacknowledged ? 'st-pending' : 'tone-neutral'}`;
  if (!list.length) {
    el.innerHTML = `<div class="ov-pad">${emptyState({ compact: true, iconName: 'inbox', title: 'No exception notifications', text: 'Imports and re-runs notify only new or changed exceptions.' })}</div>`;
    return;
  }
  el.innerHTML = `<ol class="nt-list" tabindex="-1" aria-label="Recent exception notifications">${list.slice(0, 3).map(noticeItem).join('')}</ol>
    ${list.length > 3 ? `<p class="ov-more">${plural(list.length - 3, 'older notification')} · <a href="#/reconciliation">All findings</a></p>` : ''}`;
  $$('[data-ack]', el).forEach(button => button.addEventListener('click', acknowledgeNotice));
}

function noticeItem(n) {
  const where = n.institution_code === 'CROSS' ? 'Cross-institution' : n.institution_code;
  const href = n.batch_id ? routeHash('reconciliation', { batch: n.batch_id }) : routeHash('reconciliation', n.institution_code && n.institution_code !== 'CROSS' ? { institution: n.institution_code } : {});
  const changes = (n.counts.new || 0) + (n.counts.changed || 0);
  const kinds = Object.entries(NOTICE_KIND).filter(([key]) => n.counts[key]).map(([key, k]) => `<span class="badge badge-plain ${k.tone}">${n.counts[key]} ${esc(k.label.toLowerCase())}</span>`).join('');
  return `<li class="nt-row${n.acknowledged ? ' is-ack' : ''}">
    <a class="nt-link" href="${href}" aria-label="${esc(`${where}${n.source_file ? `, ${n.source_file}` : ''}: ${plural(changes, 'new or changed exception')}. Open these findings`)}">
      <span class="nt-where"><strong>${esc(where)}</strong>${n.source_file ? ` <span class="mono">${esc(n.source_file)}</span>` : ''}</span>
      <span class="nt-meta">${esc(NOTICE_ORIGIN[n.origin] || n.origin)} · <time datetime="${esc(n.created_at)}" title="${esc(fmtDate(n.created_at))}">${esc(relTime(n.created_at))}</time> · ${plural(changes, 'new or changed exception')}</span>
    </a>
    <span class="nt-kinds">${kinds}</span>
    <span class="nt-ack">${n.acknowledged
      ? `<span class="subtle" title="${esc(`Acknowledged by ${n.acknowledged.by}, ${fmtDate(n.acknowledged.at)}`)}">${icon('check', 'icon-xs')}Acknowledged</span>`
      : `<button type="button" class="btn btn-ghost btn-xs" data-ack="${esc(n.id)}" aria-label="${esc(`Acknowledge notification for ${where}${n.source_file ? `, ${n.source_file}` : ''}`)}">${icon('check', 'icon-xs')}Acknowledge</button>`}</span>
  </li>`;
}

async function acknowledgeNotice(event) {
  const button = event.currentTarget;
  button.disabled = true; button.dataset.state = 'busy';
  try {
    await api(`/api/v1/notifications/${encodeURIComponent(button.dataset.ack)}/acknowledge`, { method: 'POST' });
    renderNotifications({ status: 'fulfilled', value: await api('/api/v1/notifications') });
    $('#ovNotices .nt-list')?.focus();
    toast('Notification acknowledged. The findings stay open until a user records a decision.', { tone: 'success' });
  } catch (error) {
    button.disabled = false;
    delete button.dataset.state;
    toast(error.message, { tone: 'error', title: 'Could not acknowledge' });
  }
}

function batchInstitution(batch) {
  return batch.institution_code === 'MULTI' ? 'Multi-institution' : batch.institution_code;
}

function renderImportList(el, importsRes, limit) {
  if (importsRes.status === 'rejected') { el.innerHTML = errorState(importsRes.reason.message); return; }
  const batches = importsRes.value.data.slice(0, limit);
  if (!batches.length) {
    el.innerHTML = emptyState({ compact: true, iconName: 'file', title: 'No import batches in this scope' });
    return;
  }
  el.innerHTML = `<ul class="batch-list">${batches.map(batch => `
    <li class="batch-item">
      <span class="batch-icon">${icon('file')}</span>
      <div style="min-width:0">
        <div class="batch-name" title="${esc(batch.source_file)}">${esc(batch.source_file)}</div>
        <div class="batch-meta">${esc(batchInstitution(batch))} · ${batch.seeded ? 'Seeded synthetic data' : esc(fmtDate(batch.created_at))}</div>
      </div>
      <div class="batch-counts">
        <strong>${fmtNum(batch.imported)}</strong> imported
        ${batch.seeded ? '' : `<br><span class="subtle">${fmtNum(batch.rejected)} rejected · ${fmtNum(batch.skipped)} skipped</span>`}
      </div>
    </li>`).join('')}</ul>`;
}

/* ── Audit History ────────────────────────────── */
let auditToken = 0;

registerView('audit', {
  enter(params) {
    selectAuditTab(state.auth === 'hosted_demo' || params.get('tab') === 'imports' ? 'imports' : 'decisions', false);
    loadAudit();
  }
});

function selectAuditTab(name, updateRoute = true) {
  ['decisions', 'imports'].forEach(tab => {
    const button = $(`#tab-${tab}`);
    const active = tab === name;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    $(`#panel-${tab}`).hidden = !active;
  });
  if (updateRoute) replaceRoute('audit', name === 'imports' ? { tab: 'imports' } : {});
}

function initAuditTabs() {
  const tabs = $$('.tab');
  tabs.forEach(tab => {
    tab.onclick = () => selectAuditTab(tab.id.replace('tab-', ''));
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus();
      selectAuditTab(tabs[next].id.replace('tab-', ''));
    };
  });
}

async function loadAudit() {
  const token = ++auditToken;
  $('#panel-decisions').innerHTML = `<div class="card-body">${skeletonLines(5)}</div>`;
  $('#panel-imports').innerHTML = `<div class="card-body">${skeletonLines(5)}</div>`;
  const [auditRes, importsRes] = await Promise.all([
    state.auth === 'hosted_demo' ? Promise.resolve({ status: 'skipped' }) : api('/api/v1/audit?limit=200').then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason })),
    api('/api/v1/imports').then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }))
  ]);
  if (token !== auditToken) return;

  if (auditRes.status === 'skipped') {
    $('#panel-decisions').innerHTML = '';
    $('#auditDecisionCount').textContent = '—';
  } else if (auditRes.status === 'rejected') {
    $('#panel-decisions').innerHTML = errorState(auditRes.reason.message, 'data-retry-audit');
    $('#auditDecisionCount').textContent = '!';
  } else {
    const { data, total } = auditRes.value;
    $('#auditDecisionCount').textContent = total;
    $('#panel-decisions').innerHTML = data.length ? `
      <div class="table-scroll"><table class="data-table stackable">
        <caption class="sr-only">Review decisions, newest first</caption>
        <thead><tr><th scope="col">Recorded</th><th scope="col">User</th><th scope="col">Outcome</th><th scope="col">Finding</th><th scope="col">User note</th></tr></thead>
        <tbody>${data.map(event => `
          <tr>
            <td data-label="Recorded"><span class="cell-main nowrap">${esc(fmtDate(event.at))}</span><div class="cell-sub">${esc(relTime(event.at))}</div></td>
            <td data-label="User">${esc(event.actor)}</td>
            <td data-label="Outcome">${auditBadge(event)}${event.receipt_id ? `<div class="cell-sub"><button type="button" class="link-btn" data-receipt="${esc(event.receipt_id)}">${icon('shield', 'icon-xs')}Receipt</button></div>` : ''}</td>
            <td data-label="Finding" class="cell-wide">
              <div class="cell-title"><a href="#/reconciliation?finding=${esc(event.finding_id)}">${esc(event.finding_title)}</a></div>
              <div class="cell-sub">${esc((event.record_context || []).map(r => `${r.institution_code} row ${r.source_row} · ${r.student_name}`).join(' ↔ '))}${event.records_count > 2 ? ` +${event.records_count - 2} more` : ''}</div>
            </td>
            <td data-label="User note" class="cell-wide" style="max-width:340px;overflow-wrap:anywhere">${esc(event.note)}</td>
          </tr>`).join('')}</tbody>
      </table></div>
      ${total > data.length ? `<div class="table-foot">Showing the ${data.length} most recent of ${total} decisions.</div>` : ''}`
      : emptyState({ iconName: 'history', title: 'No review decisions recorded yet', text: 'Decisions recorded in the reconciliation workspace are appended here and are never edited.', action: '<a class="btn btn-primary btn-sm" href="#/reconciliation?status=pending">Review pending findings</a>' });
  }

  if (importsRes.status === 'rejected') {
    $('#panel-imports').innerHTML = errorState(importsRes.reason.message, 'data-retry-audit');
    $('#auditImportCount').textContent = '!';
  } else {
    const batches = importsRes.value.data;
    $('#auditImportCount').textContent = batches.length;
    $('#panel-imports').innerHTML = batches.length ? `
      <div class="table-scroll"><table class="data-table stackable">
        <caption class="sr-only">Import batches, newest first</caption>
        <thead><tr><th scope="col">Source file</th><th scope="col">Institution</th><th scope="col" class="num">Detected</th><th scope="col" class="num">Imported</th><th scope="col" class="num">Rejected</th><th scope="col" class="num">Skipped</th><th scope="col" class="num">Findings created</th><th scope="col">Imported at</th><th scope="col" class="col-actions"><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>${batches.map(batch => `
          <tr>
            <td data-label="Source file" class="cell-wide"><div class="cell-title">${esc(batch.source_file)}</div><div class="cell-sub mono">${esc(batch.id)}</div></td>
            <td data-label="Institution">${esc(batchInstitution(batch))}</td>
            <td data-label="Detected" class="num">${batch.rows_detected == null ? '—' : fmtNum(batch.rows_detected)}</td>
            <td data-label="Imported" class="num">${fmtNum(batch.imported)}</td>
            <td data-label="Rejected" class="num">${fmtNum(batch.rejected)}</td>
            <td data-label="Skipped" class="num">${batch.skipped == null ? '—' : fmtNum(batch.skipped)}</td>
            <td data-label="Findings created" class="num">${batch.findings_created == null ? '—' : fmtNum(batch.findings_created)}</td>
            <td data-label="Imported at">${batch.seeded ? 'Seeded synthetic data' : esc(fmtDate(batch.created_at))}</td>
            <td class="col-actions"><a class="btn btn-secondary btn-xs" href="#/reconciliation?batch=${encodeURIComponent(batch.id)}">Findings${icon('chevron-right', 'icon-xs')}</a></td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : emptyState({ iconName: 'file', title: 'No import batches in this scope', action: '<a class="btn btn-primary btn-sm" href="#/import">Import student data</a>' });
  }
  $$('[data-retry-audit]').forEach(button => button.addEventListener('click', loadAudit));
}

/* ── Initialize (after all view modules load) ─── */
document.addEventListener('DOMContentLoaded', async () => {
  initShell();
  initAuditTabs();
  if (!(await loadRuntime())) return;
  handleEntryNavigation();
});
