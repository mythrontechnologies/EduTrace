/* EduTrace AI — Potential Matches
   Review queue of persisted identity links that need a person, a side-by-side comparison of the
   two source records, the evidence behind the pairing and reviewer decisions. Everything shown
   comes from /api/v1/matches; nothing is merged and no decision is made automatically.
   ──────────────────────────────────────────────── */
'use strict';

const mx = { data: null, selected: null, detail: null, listToken: 0, detailToken: 0, bound: false, filterOpener: null };
const MX_PARAMS = ['q', 'institution', 'status', 'method', 'conflict', 'evidence', 'session'];
const MX_NARROW = window.matchMedia('(max-width: 1023px)');

const MX_STATUS = {
  needs_review: { label: 'Needs review', icon: 'clock', cls: 'st-pending' },
  needs_more_evidence: { label: 'Needs more evidence', icon: 'hourglass', cls: 'st-awaiting_verification' },
  same_person: { label: 'Same person', icon: 'git-merge', cls: 'st-resolved' },
  different_person: { label: 'Different people', icon: 'minus-circle', cls: 'st-resolved' }
};
const MX_FIELD = { identifier: 'APAAR identifier', student_name: 'Name', date_of_birth: 'Date of birth', missing: 'A value is missing', none: 'No conflicting attribute' };
const MX_STATE = {
  agree: { label: 'Agree', icon: 'check', cls: 'is-agree' },
  similar: { label: 'Similar, not identical', icon: 'help', cls: 'is-similar' },
  conflict: { label: 'Conflict', icon: 'alert-triangle', cls: 'is-conflict' },
  equivalent: { label: 'Equivalent after folding', icon: 'check', cls: 'is-agree' },
  differs: { label: 'Differs · context', icon: 'info', cls: 'is-differs' },
  not_comparable: { label: 'Not comparable', icon: 'minus-circle', cls: 'is-missing' },
  missing_one: { label: 'Missing on one side', icon: 'minus-circle', cls: 'is-missing' },
  missing_both: { label: 'Not supplied by either', icon: 'minus-circle', cls: 'is-missing' }
};
const MX_DECISION_TEXT = {
  same_person: 'Both source records describe one student. The records stay separate and unchanged; the student profile shows them together. Requires confirmation.',
  different_person: 'The records describe different students. The pair is closed and kept in the audit history.',
  needs_more_evidence: 'Keep the pair open while identifiers or source documents are obtained from the institutions.'
};
const MX_CHECK = { missing: 'Missing', malformed: 'Malformed (local check)', locally_well_formed: 'Well-formed locally' };

const MX_METHOD = { protected_identifier_exact: 'Shared identifier', name_dob_similarity: 'Similar name + DOB' };
const MX_RESOLUTION_TONE = { AUTO_MATCHED: 'st-resolved', POTENTIAL_MATCH: 'st-pending', MATCH_WITHDRAWN: 'tone-danger', SAME_PERSON_CONFIRMED: 'st-resolved', DIFFERENT_PERSON: 'st-resolved', NEEDS_MORE_EVIDENCE: 'st-awaiting_verification', INSUFFICIENT_EVIDENCE: 'tone-neutral', NO_SUPPORTED_MATCH: 'tone-neutral' };
const MX_FACTOR = { agree: 'Agrees', exact: 'Identical', equivalent: 'Equivalent', similar: 'Similar', conflict: 'Conflicts', missing: 'Missing', not_usable: 'Not usable' };
const mxStatusBadge = status => { const m = MX_STATUS[status] || { label: status, icon: 'info', cls: 'tone-neutral' }; return `<span class="badge ${m.cls}">${icon(m.icon)}${esc(m.label)}</span>`; };
const mxMethodBadge = (kind, label) => `<span class="method-chip ${kind === 'exact' ? 'is-exact' : 'is-similarity'}">${icon(kind === 'exact' ? 'shield' : 'scale', 'icon-xs')}${esc(label)}</span>`;
const mxSourceLine = sources => sources.map(s => `${esc(s.institution_code)} · row ${esc(s.source_row)}`).join(' <span aria-hidden="true">↔</span><span class="sr-only"> and </span> ');
const mxFieldTags = m => [
  ...m.agreeing_fields.map(f => `<span class="ev-tag is-agree">${icon('check', 'icon-xs')}${esc(MX_FIELD[f] || f)}</span>`),
  ...(m.similar_fields || []).map(f => `<span class="ev-tag is-similar">${icon('help', 'icon-xs')}${esc(MX_FIELD[f] || f)} similar</span>`),
  ...m.conflicting_fields.map(f => `<span class="ev-tag is-conflict">${icon('alert-triangle', 'icon-xs')}${esc(MX_FIELD[f] || f)}</span>`),
  ...m.missing_fields.map(f => `<span class="ev-tag is-missing">${icon('minus-circle', 'icon-xs')}${esc(MX_FIELD[f] || f)} missing</span>`)
].join('');

registerView('matches', {
  enter(params) {
    mxBind();
    MX_PARAMS.forEach(key => {
      const value = params.get(key) || '';
      if (key === 'q') { $('#mxQuery').value = value; $('#mxClearQuery').hidden = !value; }
      else { const select = $(`#mxFilters [data-param="${key}"]`); if (select) select.dataset.pending = value; if (select) select.value = value; }
    });
    mx.selected = params.get('match') || null;
    mxLoadList();
  },
  leave() { if ($('#mxFilterSheet').open) $('#mxFilterSheet').close(); }
});

function mxParams() {
  const params = {};
  const q = $('#mxQuery').value.trim();
  if (q) params.q = q;
  $$('#mxFilters [data-param]').forEach(select => { if (select.value) params[select.dataset.param] = select.value; });
  return params;
}
function mxSyncUrl() { replaceRoute('matches', { ...mxParams(), ...(mx.selected ? { match: mx.selected } : {}) }); }

function mxBind() {
  if (mx.bound) return;
  mx.bound = true;
  let debounce;
  $('#mxSearchForm').onsubmit = event => { event.preventDefault(); clearTimeout(debounce); mxApply(); };
  $('#mxQuery').addEventListener('input', () => {
    $('#mxClearQuery').hidden = !$('#mxQuery').value;
    clearTimeout(debounce);
    debounce = setTimeout(mxApply, 260);
  });
  $('#mxClearQuery').onclick = () => { $('#mxQuery').value = ''; $('#mxClearQuery').hidden = true; $('#mxQuery').focus(); mxApply(); };
  $$('#mxFilters [data-param]').forEach(select => { select.onchange = () => { if (!$('#mxFilterSheet').open) mxApply(); }; });
  $('#mxChips').addEventListener('click', event => {
    const chip = event.target.closest('[data-clear]');
    if (!chip) return;
    if (chip.dataset.clear === 'q') { $('#mxQuery').value = ''; $('#mxClearQuery').hidden = true; }
    else if (chip.dataset.clear === 'all') { $('#mxQuery').value = ''; $('#mxClearQuery').hidden = true; $$('#mxFilters [data-param]').forEach(s => { s.value = ''; }); }
    else $(`#mxFilters [data-param="${chip.dataset.clear}"]`).value = '';
    mxApply();
    $('#mxQuery').focus();
  });
  $('#mxList').addEventListener('click', event => {
    const item = event.target.closest('[data-match]');
    if (item) mxSelect(item.dataset.match, { focusDetail: true });
  });
  $('#mxList').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = $$('#mxList [data-match]');
    const index = items.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.min(Math.max(index + (event.key === 'ArrowDown' ? 1 : -1), 0), items.length - 1);
    items[next].focus();
  });

  /* Filters become a sheet on narrow screens; the same controls are moved into it and back. */
  const sheet = $('#mxFilterSheet');
  $('#mxFilterBtn').onclick = event => {
    mx.filterOpener = event.currentTarget;
    $('#mxSheetBody').append($('#mxFilters'));
    sheet.showModal();
    $('#mxFilters .select')?.focus();
  };
  const closeSheet = () => sheet.close();
  $('#mxSheetClose').onclick = closeSheet;
  $('#mxSheetDone').onclick = () => { closeSheet(); mxApply(); };
  $('#mxSheetClear').onclick = () => { $$('#mxFilters [data-param]').forEach(s => { s.value = ''; }); closeSheet(); mxApply(); };
  sheet.addEventListener('close', () => {
    $('#mxQuery').closest('.mx-queue').querySelector('.mx-queue-head').after($('#mxFilters'));
    if (mx.filterOpener?.isConnected) mx.filterOpener.focus();
  });
  sheet.addEventListener('cancel', () => { /* Escape closes without applying pending changes to the URL */ });
  MX_NARROW.addEventListener('change', () => mxLayoutMode());
}

function mxApply() {
  mxSyncUrl();
  mxLoadList();
}

async function mxLoadList() {
  const token = ++mx.listToken;
  const list = $('#mxList');
  list.setAttribute('aria-busy', 'true');
  if (!mx.data) list.innerHTML = Array.from({ length: 3 }, () => `<li class="mx-skel">${skeletonLines(3)}</li>`).join('');
  $('#mxCount').textContent = 'Loading potential matches…';
  const qs = new URLSearchParams(mxParams()).toString();
  let response;
  try {
    response = await api(`/api/v1/matches${qs ? `?${qs}` : ''}`);
  } catch (error) {
    if (token !== mx.listToken) return;
    list.removeAttribute('aria-busy');
    list.innerHTML = `<li>${errorState(error.message, 'data-retry-matches')}</li>`;
    $('#mxCount').textContent = '';
    $('[data-retry-matches]')?.addEventListener('click', mxLoadList);
    mxRenderDetail();
    return;
  }
  if (token !== mx.listToken) return;
  list.removeAttribute('aria-busy');
  mx.data = response;
  refreshMatchCount(response.counts);
  mxFillFilters(response.filter_options);
  mxRenderChips();
  mxRenderList();
  if (mx.selected && !response.data.some(m => m.id === mx.selected) && !mx.detail) mx.selected = mx.selected; /* keep a deep link: the detail request decides */
  if (!mx.selected && !MX_NARROW.matches && response.data.length) mx.selected = response.data[0].id;
  if (mx.selected) mxLoadDetail(mx.selected);
  else mxRenderDetail();
  mxLayoutMode();
}

function mxFillFilters(options) {
  const fill = (id, values, labelOf) => {
    const select = $(id);
    const current = select.dataset.pending ?? select.value;
    delete select.dataset.pending;
    const first = select.options[0].outerHTML;
    select.innerHTML = first + values.map(v => `<option value="${esc(v)}">${esc(labelOf(v))}</option>`).join('');
    select.value = values.includes(current) ? current : '';
  };
  fill('#mxInstitution', options.institutions, v => v);
  fill('#mxStatus', options.statuses, v => MX_STATUS[v]?.label || v);
  fill('#mxConflict', options.conflicts, v => MX_FIELD[v] || v);
  fill('#mxEvidence', options.evidence, v => `${MX_FIELD[v] || v} agrees`);
  fill('#mxMethod', options.methods, v => MX_METHOD[v] || v);
  fill('#mxSession', options.sessions || [], v => v);
}

function mxRenderChips() {
  const params = mxParams();
  const labels = {
    q: v => `Search: “${v}”`, institution: v => `Institution: ${v}`, status: v => `Status: ${MX_STATUS[v]?.label || v}`,
    conflict: v => `Conflict: ${MX_FIELD[v] || v}`, evidence: v => `Agrees: ${MX_FIELD[v] || v}`,
    method: v => `Method: ${MX_METHOD[v] || v}`, session: v => `Session: ${v}`
  };
  const keys = Object.keys(params);
  const filterCount = keys.filter(k => k !== 'q').length;
  $('#mxFilterCount').hidden = !filterCount;
  $('#mxFilterCount').textContent = filterCount;
  $('#mxChips').innerHTML = keys.length
    ? keys.map(k => `<button type="button" class="chip" data-clear="${esc(k)}" aria-label="${esc(`Remove filter ${labels[k](params[k])}`)}">${esc(labels[k](params[k]))}${icon('x', 'icon-xs')}</button>`).join('') + (keys.length > 1 ? '<button type="button" class="link-btn" data-clear="all">Clear all</button>' : '')
    : '';
}

function mxRenderList() {
  const { data, total, counts } = mx.data;
  const filtered = Object.keys(mxParams()).length > 0;
  $('#mxCount').textContent = total
    ? `${filtered ? `${plural(data.length, 'match', 'matches')} shown of ${total}` : plural(total, 'potential match', 'potential matches')} · ${counts.needs_review} need review${counts.needs_more_evidence ? `, ${counts.needs_more_evidence} waiting for evidence` : ''}`
    : '';
  if (!total) {
    $('#mxList').innerHTML = `<li>${emptyState({ iconName: 'check-circle', title: 'No potential matches need review', text: 'A pair appears here when two source records in your scope share an identifier but disagree on name or date of birth, or have no shared identifier but a matching date of birth and similar names. Nothing in your current data meets either condition.', action: '<a class="btn btn-secondary btn-sm" href="#/import">Import student data</a>' })}</li>`;
    return;
  }
  if (!data.length) {
    $('#mxList').innerHTML = `<li>${emptyState({ compact: true, iconName: 'search', title: 'No matches for these filters', text: 'Try removing a filter or searching for a different name, institution, file or row.', action: '<button type="button" class="btn btn-secondary btn-sm" data-clear="all">Clear filters</button>' })}</li>`;
    $('#mxList [data-clear]')?.addEventListener('click', () => { $('#mxQuery').value = ''; $$('#mxFilters [data-param]').forEach(s => { s.value = ''; }); mxApply(); });
    return;
  }
  $('#mxList').innerHTML = data.map(m => `
    <li>
      <button type="button" class="mx-item${m.id === mx.selected ? ' is-selected' : ''}" data-match="${esc(m.id)}"${m.id === mx.selected ? ' aria-current="true"' : ''}>
        <span class="mx-item-top">${m.resolution === 'MATCH_WITHDRAWN' ? `<span class="badge tone-danger">${icon('rotate')}Automatic match withdrawn</span>` : mxStatusBadge(m.status)}${mxMethodBadge(m.method_kind, MX_METHOD[m.method] || m.method)}</span>
        <span class="mx-item-label">${esc(m.display_label)}${m.copies > 1 ? ` <span class="mx-copies" title="Unchanged resubmissions of this pair, shown once">×${m.copies}</span>` : ''}</span>
        <span class="mx-item-src">${mxSourceLine(m.sources)}</span>
        <span class="mx-item-tags"><span class="ev-count">${m.matching_field_count} of 3 identity fields match</span>${mxFieldTags(m)}${m.disqualifiers.filter(x => x.code === 'competing_candidates' || x.code === 'shared_malformed_identifier').map(x => `<span class="ev-tag is-conflict">${icon('alert-triangle', 'icon-xs')}${esc(x.label)}</span>`).join('')}</span>
        <span class="mx-item-why">${esc(m.why)}</span>
        <span class="mx-item-next">${icon('arrow-right', 'icon-xs')}${esc(m.recommended_action)}</span>
      </button>
    </li>`).join('');
}

function mxSelect(id, { focusDetail = false } = {}) {
  mx.selected = id;
  $$('#mxList [data-match]').forEach(item => {
    const on = item.dataset.match === id;
    item.classList.toggle('is-selected', on);
    if (on) item.setAttribute('aria-current', 'true'); else item.removeAttribute('aria-current');
  });
  mxSyncUrl();
  mxLoadDetail(id, { focusDetail });
}

function mxLayoutMode() {
  $('#mxLayout').classList.toggle('is-detail', MX_NARROW.matches && Boolean(mx.selected));
}

async function mxLoadDetail(id, { focusDetail = false } = {}) {
  const token = ++mx.detailToken;
  const panel = $('#mxDetail');
  mxLayoutMode();
  panel.setAttribute('aria-busy', 'true');
  if (!mx.detail || mx.detail.match.id !== id) panel.innerHTML = `<div class="card mx-loading">${skeletonLines(6)}</div>`;
  try {
    const response = await api(`/api/v1/matches/${encodeURIComponent(id)}`);
    if (token !== mx.detailToken) return;
    mx.detail = response.data;
    mxRenderDetail();
    if (focusDetail) $('#mxDetailTitle')?.focus({ preventScroll: !MX_NARROW.matches });
  } catch (error) {
    if (token !== mx.detailToken) return;
    mx.detail = null;
    panel.removeAttribute('aria-busy');
    panel.innerHTML = `<div class="card">${error.status === 404
      ? emptyState({ iconName: 'search', title: 'This potential match is not available', text: 'It may be outside your access scope, or the records changed so the pair is no longer a candidate.', action: '<button type="button" class="btn btn-secondary btn-sm" data-mx-back>Back to the queue</button>' })
      : errorState(error.message, 'data-retry-detail')}</div>`;
    $('[data-retry-detail]')?.addEventListener('click', () => mxLoadDetail(id));
    $('[data-mx-back]')?.addEventListener('click', mxBack);
  }
}

function mxBack() {
  const id = mx.selected;
  mx.selected = null; mx.detail = null;
  mxSyncUrl();
  mxLayoutMode();
  mxRenderDetail();
  const item = id && $(`#mxList [data-match="${CSS.escape(id)}"]`);
  (item || $('#mxQuery')).focus();
}

function mxRenderDetail() {
  const panel = $('#mxDetail');
  panel.removeAttribute('aria-busy');
  const d = mx.detail;
  if (!d) {
    panel.innerHTML = mx.data?.total
      ? `<div class="card mx-placeholder">${emptyState({ iconName: 'columns', title: 'Select a potential match', text: 'The two source records open side by side, with the evidence behind the pairing and the decision options.' })}</div>`
      : '';
    return;
  }
  const m = d.match;
  const linked = m.status === 'same_person';
  panel.innerHTML = `
    <div class="card mx-card">
      <header class="mx-head">
        <button type="button" class="btn btn-ghost btn-sm mx-back" data-mx-back>${icon('arrow-left', 'icon-sm')}Queue</button>
        <div class="mx-head-main">
          <p class="eyebrow">${mxMethodBadge(m.method_kind, m.method_label)}</p>
          <h2 class="mx-title" id="mxDetailTitle" tabindex="-1">${esc(m.display_label)}</h2>
          <p class="mx-sub">${mxSourceLine(m.sources)}${d.explanation.finding ? ` · <a href="#/reconciliation?finding=${esc(d.explanation.finding.id)}">${esc(d.explanation.finding.title)}</a>` : ''}</p>
        </div>
        <div class="mx-head-status">${mxStatusBadge(m.status)}</div>
      </header>

      <div class="mx-sources">
        ${[d.reference, d.incoming].map(side => `
          <article class="mx-source ${side.role === 'reference' ? 'is-reference' : 'is-incoming'}" aria-label="${side.role === 'reference' ? 'Reference record' : 'Incoming record'}">
            <p class="mx-source-kicker">${side.role === 'reference' ? 'Reference record' : 'Incoming record'}</p>
            <p class="mx-source-inst"><strong>${esc(side.institution_code)}</strong> ${esc(side.institution_name)}</p>
            <p class="mx-source-meta">${icon('file', 'icon-xs')}<span class="mono">${esc(side.source_file)}</span> · row ${esc(side.source_row)}</p>
            <p class="mx-source-meta">${icon('clock', 'icon-xs')}${side.import_id ? `Batch ${esc(side.import_label)}` : 'Seeded synthetic data'}${side.imported_at ? ` · ${esc(fmtDate(side.imported_at, false))}` : ''}</p>
            <a class="link-btn" href="${routeHash('profile', { record: side.record_id, from: m.id })}">${icon('users', 'icon-xs')}Open student profile</a>
          </article>`).join('')}
      </div>

      <section class="mx-compare" aria-labelledby="mxCompareTitle">
        <div class="mx-section-head">
          <h3 id="mxCompareTitle">Field comparison</h3>
          <p>Select a field to see its source value and how it was normalised.</p>
        </div>
        <div class="mx-grid-head" aria-hidden="true"><span>Field</span><span>Reference</span><span>Result</span><span>Incoming</span></div>
        <ul class="mx-rows">${d.fields.map(mxFieldRow).join('')}</ul>
        <ul class="mx-legend" aria-label="Result key">${['agree', 'equivalent', 'similar', 'conflict', 'missing_one', 'not_comparable', 'differs'].map(k => `<li class="mx-state ${MX_STATE[k].cls}">${icon(MX_STATE[k].icon, 'icon-xs')}${esc(MX_STATE[k].label)}</li>`).join('')}<li class="mx-state is-unverified">${icon('shield', 'icon-xs')}Identifiers are never verified</li></ul>
      </section>
    </div>

    <div class="mx-lower">
      <section class="card mx-why" aria-labelledby="mxWhyTitle">
        <h3 id="mxWhyTitle">${linked ? 'Why these records were linked' : 'Why these records are candidates'}</h3>
        ${mxExplanation(d)}
      </section>
      <section class="card mx-ai" aria-labelledby="mxAiTitle">
        <h3 id="mxAiTitle" tabindex="-1">Model commentary <span class="badge badge-plain tone-neutral">Advisory</span></h3>
        <div id="mxAiBody">${mxAiPanel(d)}</div>
      </section>
    </div>

    <section class="card mx-decide" aria-labelledby="mxDecideTitle">
      <h3 id="mxDecideTitle" tabindex="-1">User decision</h3>
      ${mxDecisionPanel(d)}
    </section>

    <section class="card mx-lab lab-entry" aria-labelledby="mxLabTitle">
      <h3 id="mxLabTitle">${icon('flask', 'icon-sm')}Evidence Impact Lab</h3>
      <p class="muted">Stage a source-backed correction to either record and see what the real rules and policy ${esc(d.explanation.policy_version)} would do, on an isolated copy. Nothing is saved and nothing here is a decision.</p>
      <button type="button" class="btn btn-secondary btn-sm" data-lab-link="${esc(d.match.id)}">${icon('flask', 'icon-sm')}Explore impact</button>
    </section>

    <section class="card mx-history" aria-labelledby="mxHistoryTitle">
      <h3 id="mxHistoryTitle">Audit history for this pair</h3>
      ${d.history.length
        ? `<ol class="timeline">${d.history.map(e => `<li class="tl-item"><span class="tl-icon ${e.system ? '' : isAwaitingAction(e.action) ? 'st-awaiting_verification' : 'st-resolved'}">${icon(e.system ? 'rotate' : e.action.startsWith('match_') ? 'git-merge' : 'check')}</span><div><p class="tl-text"><strong>${esc(e.actor)}</strong> ${esc(outcomeLabel(e.action).toLowerCase())}${e.link_id && e.link_id !== m.id ? ' (another pair in this finding)' : ''}</p>${e.from_state ? `<p class="tl-meta">${esc(e.from_state.replaceAll('_', ' ').toLowerCase())} → ${esc(e.to_state.replaceAll('_', ' ').toLowerCase())}</p>` : ''}<p class="tl-meta"><time datetime="${esc(e.at)}" title="${esc(fmtDate(e.at))}">${esc(relTime(e.at))}</time></p>${e.note ? `<p class="tl-note">${esc(e.note)}</p>` : ''}${e.receipt_id ? `<button type="button" class="link-btn" data-receipt="${esc(e.receipt_id)}">${icon('shield', 'icon-xs')}Receipt</button>` : ''}</div></li>`).join('')}</ol>`
        : `<p class="muted">No decisions yet. Every decision on this pair is recorded here and in the <a href="#/audit">audit history</a>.</p>`}
    </section>`;

  $$('[data-mx-back]', panel).forEach(button => button.addEventListener('click', mxBack));
  $$('.mx-row-btn', panel).forEach(button => button.addEventListener('click', () => {
    const open = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!open));
    $(`#${button.getAttribute('aria-controls')}`).hidden = open;
  }));
  mxBindDecision();
  $('#mxAskModel')?.addEventListener('click', mxAskModel);
}

function mxValue(field, side) {
  const v = field[side];
  if (!v.value) return `<span class="mx-missing">${field.state === 'missing_both' ? 'Not supplied' : 'Missing'}</span>`;
  if (field.key === 'apaar_id') return `<span class="mono">${esc(v.value)}</span><span class="mx-sub-note">${esc(MX_CHECK[v.identifier_check] || v.identifier_check)} · not verified</span>`;
  return esc(v.value);
}

function mxFieldRow(field, index) {
  const state = MX_STATE[field.state] || { label: field.state, icon: 'info', cls: '' };
  const id = `mxEv-${index}`;
  const plainValue = side => field[side].value || (field.state === 'missing_both' ? 'not supplied' : 'missing');
  const source = (side, title) => {
    const v = field[side]; const s = v.source;
    return `<div class="mx-ev-side"><p class="mx-ev-title">${title}</p><dl class="kv">
      <div><dt>Source</dt><dd><span class="mono">${esc(s.source_file)}</span> · row ${esc(s.source_row)} · ${esc(s.institution_code)}</dd></div>
      <div><dt>Import</dt><dd>${s.import_id ? esc(s.import_label) : 'Seeded synthetic data'}${s.imported_at ? ` · ${esc(fmtDate(s.imported_at))}` : ''}</dd></div>
      ${field.key === 'apaar_id' ? `<div><dt>Identifier check</dt><dd>${esc(MX_CHECK[v.identifier_check] || v.identifier_check)}. No authoritative verification is available.</dd></div>` : `<div><dt>Value in the file</dt><dd>${s.original_value != null ? `<span class="mono">“${esc(s.original_value)}”</span>` : '<span class="muted">Empty</span>'}</dd></div>`}
      ${s.transformation ? `<div><dt>Normalisation</dt><dd>${esc(s.transformation)}</dd></div>` : ''}
    </dl></div>`;
  };
  return `<li class="mx-row ${state.cls}${field.kind === 'context' ? ' is-context' : ''}">
    <button type="button" class="mx-row-btn" aria-expanded="false" aria-controls="${id}" aria-label="${esc(`${field.label}: ${state.label}. Reference ${plainValue('reference')}; incoming ${plainValue('incoming')}. Show source evidence`)}">
      <span class="mx-cell mx-label"><span class="mx-label-text">${esc(field.label)}</span>${field.kind === 'identity' ? '<span class="mx-kind">Identity field</span>' : '<span class="mx-kind is-context">Context</span>'}${icon('chevron-down', 'icon-xs mx-caret')}</span>
      <span class="mx-cell mx-ref"><span class="mx-side-label">Reference</span>${mxValue(field, 'reference')}</span>
      <span class="mx-cell mx-state ${state.cls}">${icon(state.icon, 'icon-xs')}${esc(state.label)}</span>
      <span class="mx-cell mx-inc"><span class="mx-side-label">Incoming</span>${mxValue(field, 'incoming')}</span>
    </button>
    <div class="mx-evidence" id="${id}" hidden>
      ${field.note ? `<p class="mx-ev-note">${icon('info', 'icon-xs')}${esc(field.note)}</p>` : ''}
      <div class="mx-ev-grid">${source('reference', 'Reference record')}${source('incoming', 'Incoming record')}</div>
    </div>
  </li>`;
}

function mxExplanation(d) {
  const e = d.explanation;
  const list = (fields, cls, iconName, empty) => fields.length ? fields.map(f => `<span class="ev-tag ${cls}">${icon(iconName, 'icon-xs')}${esc(MX_FIELD[f] || f)}</span>`).join('') : `<span class="muted">${empty}</span>`;
  return `<p class="mx-kicker-rule">${icon('shield', 'icon-xs')}Deterministic evidence · policy <code>${esc(e.policy_version)}</code></p>
  <dl class="why-list">
    <div><dt>Policy result</dt><dd><span class="badge ${MX_RESOLUTION_TONE[e.resolution] || 'tone-neutral'}">${esc(e.resolution_label)}</span>${e.withdrawn ? `<p>An automatic match between these records was withdrawn ${esc(relTime(e.withdrawn.at))} because new evidence contradicted it.</p>` : ''}
      <details class="mx-policy"><summary>What the automatic-link policy requires</summary><ol>${e.policy.conditions.map(c => `<li>${esc(c)}</li>`).join('')}</ol><p>${esc(e.policy.never)}</p></details></dd></div>
    <div><dt>Method</dt><dd>${mxMethodBadge(e.method_kind, e.method_label)}<p>${esc(e.method_description)}</p></dd></div>
    <div><dt>Agree</dt><dd class="tag-row">${list(e.agreeing_fields, 'is-agree', 'check', 'No identity attribute agrees')}${list(e.similar_fields || [], 'is-similar', 'help', '').replace('<span class="muted"></span>', '')}</dd></div>
    <div><dt>Conflict</dt><dd class="tag-row">${list(e.conflicting_fields, 'is-conflict', 'alert-triangle', 'No conflicting identity attribute')}</dd></div>
    <div><dt>Missing evidence</dt><dd class="tag-row">${list(e.missing_fields, 'is-missing', 'minus-circle', 'Nothing missing')}</dd></div>
    <div><dt>Contradictions</dt><dd class="tag-row">${e.disqualifiers.length ? e.disqualifiers.map(x => `<span class="ev-tag is-conflict">${icon('alert-triangle', 'icon-xs')}${esc(x.label)}</span>`).join('') : '<span class="muted">None recorded</span>'}</dd></div>
    <div><dt>Why it was raised</dt><dd>${esc(e.why)}</dd></div>
    ${e.uncertainty ? `<div><dt>Why it is uncertain</dt><dd>${esc(e.uncertainty)}</dd></div>` : ''}
    <div><dt>Recommendation</dt><dd><strong>${esc(e.recommendation)}</strong></dd></div>
    <div><dt>Evidence score</dt><dd><span class="score-pill">${esc(e.score.value)} / ${esc(e.score.max)}</span><p class="muted">${esc(e.score.note)}</p>
      ${e.factors.length ? `<table class="data-table compact factor-table"><caption class="sr-only">Contributing factors</caption><thead><tr><th scope="col">Field</th><th scope="col">Result</th><th scope="col">Weight</th></tr></thead><tbody>${e.factors.map(f => `<tr><td>${esc(MX_FIELD[f.field] || f.field)}</td><td title="${esc(f.note)}">${esc(MX_FACTOR[f.result] || f.result)}</td><td class="num">${f.weight > 0 ? '+' : ''}${esc(f.weight)}</td></tr>`).join('')}</tbody></table>` : ''}</dd></div>
    <div><dt>Limitations</dt><dd><ul class="mx-limits">${e.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul></dd></div>
  </dl>
  <p class="mx-source-of-truth">${icon('info', 'icon-xs')}Produced by deterministic rules (policy ${esc(e.policy_version)}). ${esc(e.system_reason)}</p>`;
}

function mxAiPanel(d) {
  const ai = d.ai;
  const provider = ai.provider;
  const m = ai.match_explanation;
  const parts = [];
  if (m && !m.stale) {
    parts.push(`<div class="ai-result">
      <p class="ai-kicker">${icon('flask', 'icon-xs')}AI-generated commentary · <code>${esc(m.provenance?.model)}</code>${m.provenance?.local ? ' (local)' : ''}${m.provenance?.generated_at ? ` · ${esc(relTime(m.provenance.generated_at))}` : ''}</p>
      <p>${esc(m.summary)}</p>
      ${m.limitations?.length ? `<ul class="mx-limits">${m.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <p class="ai-next">${icon('arrow-right', 'icon-xs')}${esc(m.recommended_action_label || '')}</p>
    </div>`);
  } else if (m?.stale) parts.push(`<p class="callout info">${icon('info')}<span>An earlier model explanation was withheld because the evidence, prompt or model changed after it was generated.</span></p>`);
  if (ai.candidate_assessment) {
    const a = ai.candidate_assessment;
    parts.push(`<div class="ai-result"><p class="ai-kicker">${icon('flask', 'icon-xs')}Name assessment · <code>${esc(a.model)}</code>${a.local ? ' (local)' : ''}</p><p><strong>${esc(String(a.assessment).replaceAll('_', ' '))}</strong> · ${esc(String(a.name_relationship).replaceAll('_', ' '))}</p><p>${esc(a.rationale)}</p></div>`);
  }
  if (!parts.length) parts.push(`<p class="muted">No model commentary for this pair. Everything above is deterministic evidence.</p>`);
  const action = !provider?.configured
    ? `<p class="ai-status">${icon('info', 'icon-xs')}Model assistance is off; the deterministic explanation above is complete.</p>`
    : `<button type="button" class="btn btn-secondary btn-sm" id="mxAskModel">${icon('flask', 'icon-sm')}${m && !m.stale ? 'Refresh model commentary' : 'Ask the model to explain this evidence'}</button>
       <p class="ai-provider-line">${esc(provider.label)} · <code>${esc(provider.model)}</code> · ${esc(provider.health || '')}. Only field results are sent — no names, dates or identifiers.</p>`;
  return `${parts.join('')}${action}<p class="ai-effect">${icon('shield', 'icon-xs')}${esc(ai.effect)}</p>`;
}

async function mxAskModel(event) {
  const button = event.currentTarget;
  const d = mx.detail;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.dataset.state = 'busy';
  button.innerHTML = `${icon('rotate', 'icon-sm')}Waiting for the model…`;
  try {
    const result = (await api(`/api/v1/matches/${encodeURIComponent(d.match.id)}/explain`, { method: 'POST', body: '{}' })).data;
    const fresh = (await api(`/api/v1/matches/${encodeURIComponent(d.match.id)}`)).data;
    if (mx.detail?.match.id !== d.match.id) return;
    mx.detail = fresh;
    $('#mxAiBody').innerHTML = mxAiPanel(fresh) + (result.source === 'model' ? '' : `<p class="callout warning">${icon('alert-triangle')}<span>${esc(result.model_unavailable_reason || 'The model did not return a usable answer.')} The deterministic explanation above is unaffected.</span></p>`);
    $('#mxAskModel')?.addEventListener('click', mxAskModel);
    $('#mxAiTitle')?.focus();
    toast(result.source === 'model' ? `Commentary from ${result.provenance?.model} passed validation against the evidence. It is advisory only.` : 'No usable model answer; the deterministic explanation stands.', { tone: result.source === 'model' ? 'success' : 'warning', title: 'Model commentary' });
  } catch (error) {
    button.disabled = false; button.removeAttribute('aria-busy');
    button.innerHTML = `${icon('flask', 'icon-sm')}Try again`;
    toast(error.message, { tone: 'error', title: 'Model request failed' });
  }
}

function mxDecisionPanel(d) {
  const current = d.decision;
  const finalNow = current && MX_STATUS[current.decision] && ['same_person', 'different_person'].includes(current.decision);
  const historical = d.explanation.finding && d.explanation.finding.lifecycle_status !== 'current';
  const summary = current ? `<div class="decision-now ${finalNow ? 'is-final' : ''}">
      ${mxStatusBadge(current.decision)}
      <p><strong>${esc(current.reviewer)}</strong> · <time datetime="${esc(current.at)}" title="${esc(fmtDate(current.at))}">${esc(relTime(current.at))}</time></p>
      <p class="tl-note">${esc(current.note)}</p>
      ${current.receipt_id ? `<button type="button" class="link-btn" data-receipt="${esc(current.receipt_id)}">${icon('shield', 'icon-xs')}View decision receipt</button>` : '<p class="subtle" style="font-size:12px">No receipt: recorded before decision receipts were introduced.</p>'}
      ${current.history.length ? `<details class="decision-prev"><summary>${plural(current.history.length, 'earlier decision')}</summary><ul>${current.history.map(h => `<li>${esc(h.label)} · ${esc(h.reviewer)} · ${esc(fmtDate(h.at))}<br><span class="muted">${esc(h.note)}</span></li>`).join('')}</ul></details>` : ''}
    </div>` : '';
  if (historical) return `${summary}<p class="callout info">${icon('info')}<span>This pair belongs to a historical finding. Decisions are recorded on current findings only.</span></p>`;
  const options = d.decisions.map(option => {
    const disabled = finalNow && option.key !== 'needs_more_evidence';
    return `<label class="decision-option${disabled ? ' is-disabled' : ''}">
      <input type="radio" name="mxDecision" value="${esc(option.key)}"${disabled ? ' disabled' : ''}>
      <span class="decision-option-body"><strong>${esc(option.label)}</strong><span>${esc(MX_DECISION_TEXT[option.key])}</span></span>
    </label>`;
  }).join('');
  return `${summary}
    <form class="decision-form" id="mxDecisionForm" novalidate>
      <fieldset>
        <legend>${current ? (finalNow ? 'Reopen this pair' : 'Update the decision') : 'Record a decision'}</legend>
        ${finalNow ? `<p class="muted">A final decision can only be reopened with “Needs more evidence”, so the change of mind is recorded.</p>` : ''}
        <div class="decision-options" id="mxDecisionOptions">${options}</div>
        <p class="field-error" id="mxDecisionError" hidden></p>
      </fieldset>
      <div class="field">
        <label class="field-label" for="mxNote">Decision note <span class="req">Required</span></label>
        <textarea class="textarea" id="mxNote" rows="3" maxlength="1000" aria-describedby="mxNoteHelp mxNoteError" placeholder="What evidence supports this decision?"></textarea>
        <p class="field-help" id="mxNoteHelp">Kept in the audit history with your name and the time.</p>
        <p class="field-error" id="mxNoteError" hidden></p>
      </div>
      <div class="decision-actions"><button type="submit" class="btn btn-primary" id="mxSubmit">${icon('check', 'icon-sm')}Record decision</button></div>
    </form>`;
}

function mxBindDecision() {
  const form = $('#mxDecisionForm');
  if (!form) return;
  form.addEventListener('change', () => { $('#mxDecisionError').hidden = true; $('#mxDecisionOptions').removeAttribute('aria-invalid'); });
  $('#mxNote').addEventListener('input', () => { $('#mxNoteError').hidden = true; $('#mxNote').removeAttribute('aria-invalid'); });
  form.onsubmit = async event => {
    event.preventDefault();
    const d = mx.detail;
    const decision = $('input[name="mxDecision"]:checked', form)?.value;
    const note = $('#mxNote').value.trim();
    let invalid = null;
    if (!decision) { $('#mxDecisionError').textContent = 'Choose a decision.'; $('#mxDecisionError').hidden = false; $('#mxDecisionOptions').setAttribute('aria-invalid', 'true'); invalid = invalid || $('input[name="mxDecision"]:not(:disabled)', form); }
    if (!note) { $('#mxNoteError').textContent = 'Add a note explaining the evidence for this decision.'; $('#mxNoteError').hidden = false; $('#mxNote').setAttribute('aria-invalid', 'true'); invalid = invalid || $('#mxNote'); }
    if (invalid) { invalid.focus(); return; }
    let confirm = false;
    if (decision === 'same_person') {
      confirm = await confirmDialog({
        title: 'Record these records as the same person?',
        body: `<p>${esc(d.reference.institution_code)} row ${esc(d.reference.source_row)} and ${esc(d.incoming.institution_code)} row ${esc(d.incoming.source_row)} will be recorded as one student.</p><p>Both source records stay separate and unchanged. The decision appears in the audit history and can be reopened with “Needs more evidence”.</p>`,
        confirmLabel: 'Record same person'
      });
      if (!confirm) return;
    }
    const button = $('#mxSubmit');
    button.disabled = true; button.setAttribute('aria-busy', 'true'); button.dataset.state = 'busy';
    try {
      const response = await api(`/api/v1/matches/${encodeURIComponent(d.match.id)}/decision`, { method: 'POST', body: JSON.stringify({ decision, note, ...(confirm ? { confirm: true } : {}) }) });
      mx.detail = response.data;
      mxRenderDetail();
      $('#mxDecideTitle')?.focus();
      toast(`${MX_STATUS[decision].label} recorded. The audit history, finding status and counters are updated.`, { tone: 'success', title: 'Decision recorded' });
      refreshPrincipal();
      const token = ++mx.listToken;
      const qs = new URLSearchParams(mxParams()).toString();
      const list = await api(`/api/v1/matches${qs ? `?${qs}` : ''}`);
      if (token !== mx.listToken) return;
      mx.data = list;
      refreshMatchCount(list.counts);
      mxRenderList();
    } catch (error) {
      button.disabled = false; button.removeAttribute('aria-busy'); delete button.dataset.state;
      $('#mxDecisionError').textContent = error.message;
      $('#mxDecisionError').hidden = false;
      $('#mxDecisionError').setAttribute('role', 'alert');
    }
  };
}
