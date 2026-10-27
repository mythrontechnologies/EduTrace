/* EduTrace AI — Student profile (source view)
   A read-only profile built around one source record: the records joined to it by an automatic
   identifier link or a reviewer's "same person" decision, shown side by side. Canonical values
   are derived for display only; source records are never merged or overwritten.
   ──────────────────────────────────────────────── */
'use strict';

const pf = { token: 0, data: null, tab: 'overview', record: null };
const PF_TABS = [
  ['overview', 'Overview'], ['education', 'Education history'], ['sources', 'Sources'], ['history', 'Match history'], ['conflicts', 'Conflicts']
];
const PF_STATE = {
  consistent: { label: 'Consistent', icon: 'check', cls: 'is-agree' },
  partial: { label: 'Missing in some sources', icon: 'minus-circle', cls: 'is-missing' },
  conflict: { label: 'Conflicting values', icon: 'alert-triangle', cls: 'is-conflict' },
  missing: { label: 'Not supplied', icon: 'minus-circle', cls: 'is-missing' }
};
const PF_OUTCOME = {
  auto_linked: { label: 'Linked automatically', cls: 'st-resolved' },
  needs_investigation: { label: 'Shared identifier, attributes conflict', cls: 'sev-high' },
  candidate_for_review: { label: 'Candidate for review', cls: 'st-pending' },
  not_linked: { label: 'Compared, not linked', cls: 'tone-neutral' }
};
const PF_PROCESSING = { automatically_processed: 'Processed automatically', automatically_normalised: 'Normalised automatically', safely_matched: 'Safely matched', needs_institution_correction: 'Needs institution correction', needs_investigation: 'Needs investigation', verification_pending: 'Verification pending' };
const pfField = key => ({ identifier: 'APAAR identifier', student_name: 'Name', date_of_birth: 'Date of birth' }[key] || key);
const pfSourceRef = s => `<span class="mono">${esc(s.source_file)}</span> · row ${esc(s.source_row)} · ${esc(s.institution_code)}`;

registerView('profile', {
  enter(params) {
    const record = params.get('record');
    const from = params.get('from');
    $('#pfBack').href = from ? routeHash('matches', { match: from }) : '#/matches';
    $('#pfBack').lastChild.textContent = from ? 'Back to the comparison' : 'Potential matches';
    pf.tab = PF_TABS.some(([key]) => key === params.get('tab')) ? params.get('tab') : 'overview';
    pfLoad(record);
  }
});

async function pfLoad(record) {
  const token = ++pf.token;
  const body = $('#pfBody');
  pf.record = record;
  if (!record) {
    $('#h-profile').textContent = 'Student profile';
    body.innerHTML = `<div class="card">${emptyState({ iconName: 'users', title: 'No source record selected', text: 'Open a profile from a potential match, a finding or a record in the integrity graph.', action: '<a class="btn btn-secondary btn-sm" href="#/matches">Potential matches</a>' })}</div>`;
    return;
  }
  body.setAttribute('aria-busy', 'true');
  body.innerHTML = `<div class="card">${skeletonLines(6)}</div>`;
  try {
    const response = await api(`/api/v1/profiles/${encodeURIComponent(record)}`);
    if (token !== pf.token) return;
    pf.data = response.data;
    pfRender();
  } catch (error) {
    if (token !== pf.token) return;
    body.removeAttribute('aria-busy');
    body.innerHTML = `<div class="card">${error.status === 404
      ? emptyState({ iconName: 'search', title: 'This source record is not available', text: 'It does not exist or is outside your access scope.' })
      : errorState(error.message, 'data-retry-profile')}</div>`;
    $('[data-retry-profile]')?.addEventListener('click', () => pfLoad(record));
  }
}

function pfRender() {
  const d = pf.data;
  const body = $('#pfBody');
  body.removeAttribute('aria-busy');
  $('#h-profile').textContent = d.display_label;
  $('#pfSub').textContent = d.basis;
  const count = key => key === 'sources' ? d.sources.length : key === 'history' ? d.match_history.length : key === 'conflicts' ? d.conflicts.fields.length + d.conflicts.findings.length : null;
  body.innerHTML = `
    <div class="pf-summary card">
      <div class="pf-stat"><span class="pf-stat-value">${d.sources.length}</span><span>${d.sources.length === 1 ? 'source record' : 'source records'}</span></div>
      <div class="pf-stat"><span class="pf-stat-value">${new Set(d.sources.map(s => s.institution_code)).size}</span><span>${new Set(d.sources.map(s => s.institution_code)).size === 1 ? 'institution' : 'institutions'}</span></div>
      <div class="pf-stat"><span class="pf-stat-value">${d.match_history.length}</span><span>${d.match_history.length === 1 ? 'comparison' : 'comparisons'}</span></div>
      <div class="pf-stat"><span class="pf-stat-value">${d.conflicts.fields.length}</span><span>${d.conflicts.fields.length === 1 ? 'conflicting identity field' : 'conflicting identity fields'}</span></div>
      ${d.hidden_linked_records ? `<p class="pf-hidden">${icon('shield', 'icon-xs')}${plural(d.hidden_linked_records, 'linked record')} outside your access scope ${d.hidden_linked_records === 1 ? 'is' : 'are'} not shown.</p>` : ''}
    </div>
    <div class="tabs pf-tabs" role="tablist" aria-label="Profile sections">
      ${PF_TABS.map(([key, label]) => `<button type="button" class="tab" role="tab" id="pf-tab-${key}" aria-controls="pf-panel" aria-selected="${key === pf.tab}" tabindex="${key === pf.tab ? 0 : -1}" data-tab="${key}">${esc(label)}${count(key) != null ? ` <span class="count-pill">${count(key)}</span>` : ''}</button>`).join('')}
    </div>
    <section class="card pf-panel" role="tabpanel" id="pf-panel" aria-labelledby="pf-tab-${pf.tab}" tabindex="0">${pfPanel(pf.tab)}</section>`;
  if (!body.dataset.historyBound) { body.addEventListener('toggle', pfLoadHistory, true); body.dataset.historyBound = '1'; }
  const tabs = $$('.pf-tabs [role="tab"]', body);
  const activate = (tab, focus) => {
    pf.tab = tab.dataset.tab;
    tabs.forEach(t => { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    const panel = $('#pf-panel');
    panel.setAttribute('aria-labelledby', tab.id);
    panel.innerHTML = pfPanel(pf.tab);
    replaceRoute('profile', { ...Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || '')), tab: pf.tab === 'overview' ? '' : pf.tab });
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab, false));
    tab.addEventListener('keydown', event => {
      const keys = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
      if (!(event.key in keys)) return;
      event.preventDefault();
      activate(tabs[(keys[event.key] + tabs.length) % tabs.length], true);
    });
  });
}

const PF_RELATION = { original: 'Original', correction: 'Corrected version', unchanged_copy: 'Unchanged re-import' };
const PF_BASIS = { institution_reference: 'matched by the institution\'s record reference', reviewer_confirmed: 'confirmed by a user', heuristic: 'possible correction (unconfirmed)' };
async function pfLoadHistory(event) {
  const details = event.target;
  if (!details.matches?.('details[data-lineage]') || !details.open || details.dataset.loaded) return;
  details.dataset.loaded = '1';
  const box = $('.pf-history-body', details);
  try {
    const v = (await api(`/api/v1/records/${encodeURIComponent(details.dataset.lineage)}/lineage`)).data;
    const versions = v.versions.map(x => `<li class="${x.active ? '' : 'is-superseded'}">
      <strong>v${esc(x.version)}</strong> ${esc(PF_RELATION[x.relation] || x.relation)}${x.basis ? ` · ${esc(PF_BASIS[x.basis] || x.basis)}` : ''}
      <span class="muted"> · <span class="mono">${esc(x.source_file)}</span> row ${esc(x.source_row)}${x.imported_at ? ` · ${esc(fmtDate(x.imported_at))}` : ''}${x.active ? '' : ' · superseded'}</span>
      ${x.changes.length ? `<ul>${x.changes.map(c => `<li>${esc(c.label)}: <span class="mono">${esc(c.from ?? '—')}</span> → <span class="mono">${esc(c.to ?? '—')}</span></li>`).join('')}</ul>` : ''}</li>`).join('');
    const list = (items, empty) => items.length ? `<ul>${items.map(f => `<li><a href="#/reconciliation?finding=${esc(f.id)}${f.lifecycle_status !== 'current' ? '&lifecycle=all' : ''}">${esc(f.title)}</a> <span class="muted">${esc(f.lifecycle_status === 'cleared' ? 'resolved by correction' : statusLabel(f.review_status))}</span></li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
    box.innerHTML = `<ol class="pf-versions">${versions}</ol>
      <p class="pf-h4">Resolved by a correction</p>${list(v.findings_resolved_by_correction, 'None.')}
      <p class="pf-h4">Still open</p>${list(v.findings_open, 'None.')}
      ${v.identity_decisions.length ? `<p class="pf-h4">Identity decisions</p><ul>${v.identity_decisions.map(d => `<li>${esc(String(d.decision).replaceAll('_', ' '))} · ${esc(d.reviewer)}${d.applies_to_current_evidence ? '' : ' <span class="muted">(made on an earlier version)</span>'}</li>`).join('')}</ul>` : ''}
      ${v.candidates.filter(c => c.status === 'pending').length ? `<p class="callout info">${icon('info')}<span>A possible correction is waiting for confirmation on the <a href="#/import">Import page</a>.</span></p>` : ''}`;
  } catch (error) {
    box.innerHTML = `<p class="field-error">${esc(error.message)}</p>`;
    delete details.dataset.loaded;
  }
}

function pfStateBadge(state) {
  const s = PF_STATE[state] || { label: state, icon: 'info', cls: '' };
  return `<span class="mx-state ${s.cls}">${icon(s.icon, 'icon-xs')}${esc(s.label)}</span>`;
}

function pfPanel(tab) {
  const d = pf.data;
  if (tab === 'overview') return `
    <h2 class="sr-only">Overview</h2>
    <p class="muted pf-note">${icon('info', 'icon-xs')}Values are read from the source records below. Where sources disagree, every value is shown with its source and none is chosen.</p>
    <dl class="pf-attrs">${d.attributes.map(a => `
      <div class="pf-attr ${PF_STATE[a.state]?.cls || ''}">
        <dt>${esc(a.label)}</dt>
        <dd>
          ${a.state === 'conflict' || a.state === 'partial'
            ? `<ul class="pf-values">${a.values.map(v => `<li><span class="${v.value ? '' : 'mx-missing'}">${esc(v.value || 'Missing')}</span> <span class="muted">${esc(v.institution_code)} row ${esc(v.source_row)}</span></li>`).join('')}</ul>`
            : `<span class="${a.value ? (a.key === 'apaar_id' ? 'mono' : '') : 'mx-missing'}">${esc(a.value || 'Not supplied')}</span>`}
          <span class="pf-attr-meta">${pfStateBadge(a.state)}${a.verification ? `<span class="mx-state is-unverified">${icon('shield', 'icon-xs')}Not verified</span>` : ''}</span>
        </dd>
      </div>`).join('')}</dl>
    <h3 class="pf-h3">Processing state</h3>
    <ul class="pf-processing">${d.processing.map(p => `<li><span>${esc(p.institution_code)} row ${esc(p.source_row)}</span><strong>${esc(PF_PROCESSING[p.status] || p.status || 'Not processed')}</strong><span class="muted">Identifier: ${esc(MX_CHECK[p.identifier_check] || p.identifier_check)}</span></li>`).join('')}</ul>`;

  if (tab === 'education') return `
    <h2 class="sr-only">Education history</h2>
    <div class="table-scroll"><table class="data-table stackable">
      <thead><tr><th scope="col">Institution</th><th scope="col">Programme</th><th scope="col">Session</th><th scope="col">Admission year</th><th scope="col">Enrolment status</th><th scope="col">Source</th></tr></thead>
      <tbody>${d.education.map(e => `<tr>
        <td data-label="Institution"><strong>${esc(e.institution_code)}</strong><div class="cell-sub">${esc(e.institution_name)}</div></td>
        <td data-label="Programme">${esc(e.programme || '—')}</td>
        <td data-label="Session">${esc(e.academic_session || '—')}</td>
        <td data-label="Admission year">${esc(e.admission_year || '—')}</td>
        <td data-label="Enrolment status">${esc(e.enrolment_status || '—')}</td>
        <td data-label="Source"><span class="mono">${esc(e.source_file)}</span> · row ${esc(e.source_row)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;

  if (tab === 'sources') return `
    <h2 class="sr-only">Sources</h2>
    <div class="pf-sources">${d.sources.map(s => `
      <article class="pf-source">
        <header><p class="mx-source-kicker">${esc(s.institution_code)} · ${esc(s.institution_name)}</p><p class="mx-source-meta">${icon('file', 'icon-xs')}${pfSourceRef(s)}</p>
        <p class="mx-source-meta">${icon('clock', 'icon-xs')}${s.import_id ? `Batch ${esc(s.import_label)}` : 'Seeded synthetic data'}${s.imported_at ? ` · ${esc(fmtDate(s.imported_at))}` : ''}</p></header>
        <dl class="kv">
          <div><dt>Name</dt><dd>${esc(s.student_name || 'Not supplied')}</dd></div>
          <div><dt>Date of birth</dt><dd>${esc(s.date_of_birth || 'Not supplied')}</dd></div>
          <div><dt>APAAR identifier</dt><dd><span class="mono">${esc(s.apaar_id || 'Not supplied')}</span> · ${esc(MX_CHECK[s.identifier_check] || s.identifier_check)} · not verified</dd></div>
        </dl>
        ${s.lineage && s.lineage.version > 1 ? `<p class="pf-version">${icon('history', 'icon-xs')}Version ${esc(s.lineage.version)} · corrected record</p>` : ''}
        <details class="pf-inspect pf-history" data-lineage="${esc(s.record_id)}"><summary>Correction history</summary><div class="pf-history-body">${skeletonLines(2)}</div></details>
        <details class="pf-inspect"><summary>Inspect the source record as imported</summary>
          <table class="data-table compact"><thead><tr><th scope="col">Field</th><th scope="col">Value in the file</th><th scope="col">Normalisation</th></tr></thead>
          <tbody>${Object.entries(s.original).map(([k, v]) => `<tr><td>${esc(k)}</td><td><span class="mono">${v ? `“${esc(v)}”` : '<span class="muted">Empty</span>'}</span></td><td class="muted">${esc(s.transformations[k] || '—')}</td></tr>`).join('')}</tbody></table>
          <p class="muted">Identifiers are masked. Record id <span class="mono">${esc(s.record_id)}</span>.</p>
        </details>
      </article>`).join('')}</div>`;

  if (tab === 'history') return `
    <h2 class="sr-only">Match history</h2>
    ${d.match_history.length ? `<ul class="pf-links">${d.match_history.map(l => {
      const o = PF_OUTCOME[l.outcome] || { label: l.outcome, cls: 'tone-neutral' };
      return `<li class="pf-link">
        <div class="pf-link-head">${mxMethodBadge(l.method === 'protected_identifier_exact' ? 'exact' : 'similarity', l.method_label)}<span class="badge ${o.cls}">${esc(o.label)}</span>${l.decision ? mxStatusBadge(l.decision.decision) : ''}</div>
        <p class="pf-link-recs">${l.records.map(pfSourceRef).join(' <span aria-hidden="true">↔</span> ')}</p>
        <p class="tag-row">${mxFieldTags(l)}</p>
        <p class="muted">${esc(l.reason)}</p>
        ${l.decision ? `<p class="tl-note"><strong>${esc(l.decision.reviewer)}</strong>, ${esc(fmtDate(l.decision.at))}: ${esc(l.decision.note)}</p>` : ''}
        ${l.reviewable ? `<a class="link-btn" href="${routeHash('matches', { match: l.link_id })}">Compare side by side ${icon('arrow-right', 'icon-xs')}</a>` : ''}
      </li>`;
    }).join('')}</ul>` : `<p class="muted">No other record has been compared with this one.</p>`}
    <h3 class="pf-h3">User and system activity</h3>
    ${d.audit.length ? `<ol class="timeline">${d.audit.map(e => `<li class="tl-item"><span class="tl-icon ${e.system ? '' : isAwaitingAction(e.action) ? 'st-awaiting_verification' : 'st-resolved'}">${icon(e.system ? 'rotate' : 'check')}</span><div><p class="tl-text"><strong>${esc(e.actor)}</strong> ${esc(outcomeLabel(e.action).toLowerCase())} · <a href="#/reconciliation?finding=${esc(e.finding_id)}">finding</a></p><p class="tl-meta"><time datetime="${esc(e.at)}">${esc(fmtDate(e.at))}</time></p>${e.note ? `<p class="tl-note">${esc(e.note)}</p>` : ''}</div></li>`).join('')}</ol>` : '<p class="muted">No audit events for findings involving these records.</p>'}`;

  return `
    <h2 class="sr-only">Conflicts</h2>
    <h3 class="pf-h3">Identity fields that differ between sources</h3>
    ${d.conflicts.fields.length ? `<ul class="pf-conflicts">${d.conflicts.fields.map(a => `<li><strong>${esc(a.label)}</strong><ul class="pf-values">${a.values.map(v => `<li>${esc(v.value || 'Missing')} <span class="muted">${esc(v.institution_code)} row ${esc(v.source_row)}</span></li>`).join('')}</ul></li>`).join('')}</ul>` : '<p class="muted">The joined source records agree on name, date of birth and identifier.</p>'}
    <h3 class="pf-h3">Findings involving these records</h3>
    ${d.conflicts.findings.length ? `<ul class="pf-findings">${d.conflicts.findings.map(f => `<li><a href="#/reconciliation?finding=${esc(f.id)}">${esc(f.title)}</a> ${sevBadge(f.severity)} ${statusBadge(f.review_status)}${f.decision ? `<p class="muted">${esc(outcomeLabel(f.decision.outcome))} by ${esc(f.decision.reviewer)}: ${esc(f.decision.note)}</p>` : ''}</li>`).join('')}</ul>` : '<p class="muted">No current findings involve these records.</p>'}`;
}
