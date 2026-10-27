/* EduTrace AI — Student history (temporal identity view)
   Opened from the integrity graph. Everything shown comes from /api/v1/identities/:id/history and
   /api/v1/records/:id: persisted source records, versions, findings, identity relationships,
   reviewer decisions and audit events. Import, system and reviewer times are kept apart from
   what institutions reported (academic session, admission year, status); no date is inferred.
   ──────────────────────────────────────────────── */
'use strict';

const hx = { data: null, recordId: null, asOf: '', filter: { institution: '', category: '', from: '', to: '' }, limit: 40, token: 0, opener: null };
const HX_TIME = { import: 'Imported', system: 'Recorded by EduTrace', reviewer: 'User action' };
const HX_CATEGORY = { record: 'Source record', correction: 'Correction', finding: 'Finding', identity: 'Identity', review: 'Review decision' };
/* Timeline markers: a distinct icon and shape per kind of event, so colour is never the only cue. */
const HX_MARK = { record: 'file', correction: 'rotate', finding: 'alert-triangle', identity: 'link', review: 'check-circle' };
function hxMark(e) {
  if (/withdrawn/.test(e.type || '')) return ['minus-circle', 'mark-withdrawn'];
  if (e.type === 'corrected_version_stored') return ['rotate', 'mark-correction'];
  return [HX_MARK[e.category] || 'info', `mark-${e.category}`];
}
const HX_EVIDENCE = { missing: 'Missing information', malformed: 'Malformed value', contradiction: 'Contradiction', candidate: 'Possible match', repeat: 'Repeated identifier', enrolment: 'Concurrent enrolment', capacity: 'Capacity' };
const HX_LINE = { AUTO_MATCHED: 'exact', SAME_SOURCE_RECORD: 'source', POTENTIAL_MATCH: 'candidate', NEEDS_MORE_EVIDENCE: 'candidate', SAME_PERSON_CONFIRMED: 'confirmed', DIFFERENT_PERSON: 'rejected', MATCH_WITHDRAWN: 'withdrawn', INSUFFICIENT_EVIDENCE: 'rejected', NO_SUPPORTED_MATCH: 'rejected' };
const HX_VARIATION = { consistent: ['Consistent', 'is-agree'], missing_in_some: ['Missing in some sources', 'is-missing'], recorded_variation: ['Recorded variation', 'is-similar'], corrected: ['Corrected between versions', 'is-agree'], differs_by_source: ['Differs by source', 'is-differs'] };
const HX_FIELD = { identifier: 'APAAR identifier', student_name: 'Name', date_of_birth: 'Date of birth' };
const hxRef = r => `${r.institution_code} · <span class="mono">${esc(r.source_file)}</span> row ${esc(r.source_row)}${r.version > 1 ? ` · v${esc(r.version)}` : ''}${r.active ? '' : ' · superseded'}`;

/* ── Record search (graph panel) ── */
function hxRecordSearchHtml(institution) {
  return `<form class="hx-search" data-hx-search="${esc(institution)}" role="search">
      <label class="sr-only" for="hxQ-${esc(institution || 'all')}">Search source records</label>
      <input class="input" id="hxQ-${esc(institution || 'all')}" type="search" placeholder="Name, file, row or reference" autocomplete="off">
      <button type="submit" class="btn btn-secondary btn-xs">${icon('search', 'icon-xs')}Search</button>
    </form>
    <label class="hx-versions"><input type="checkbox" data-hx-versions> Include superseded versions</label>
    <div class="hx-results" aria-live="polite"></div>`;
}
function hxBindRecordSearch(root, institution) {
  const form = $('[data-hx-search]', root);
  if (!form) return;
  let offset = 0;
  const run = async (append = false) => {
    const box = $('.hx-results', root);
    const q = $('input[type=search]', form).value.trim();
    const qs = new URLSearchParams({ limit: '25', offset: String(offset), ...(institution ? { institution } : {}), ...(q ? { q } : {}), ...($('[data-hx-versions]', root).checked ? { versions: 'all' } : {}) });
    if (!append) box.innerHTML = skeletonLines(3);
    try {
      const r = await api(`/api/v1/records?${qs}`);
      const rows = r.data.map(x => `<li><div><strong>${esc(x.student_name || 'Name not supplied')}</strong><div class="subtle">${hxRef(x)}</div></div>
        <div class="hx-row-actions"><button type="button" class="btn btn-ghost btn-xs" data-record-detail="${esc(x.record_id)}">Details</button><button type="button" class="btn btn-secondary btn-xs" data-history="${esc(x.record_id)}">${icon('history', 'icon-xs')}History</button></div></li>`).join('');
      const list = append ? $('.hx-list', box) : null;
      if (list) { list.insertAdjacentHTML('beforeend', rows); $('.hx-more', box)?.remove(); }
      else box.innerHTML = r.total ? `<p class="subtle">${plural(r.total, 'record')}${q ? ` matching “${esc(q)}”` : ''}</p><ul class="hx-list">${rows}</ul>` : '<p class="muted">No source records match.</p>';
      offset += r.data.length;
      if (offset < r.total) box.insertAdjacentHTML('beforeend', `<button type="button" class="btn btn-ghost btn-xs hx-more">Show ${Math.min(25, r.total - offset)} more of ${r.total - offset}</button>`);
      $('.hx-more', box)?.addEventListener('click', event => { event.currentTarget.classList.add('is-busy'); run(true); });
    } catch (error) { box.innerHTML = `<p class="field-error">${esc(error.message)}</p>`; }
  };
  form.addEventListener('submit', event => { event.preventDefault(); offset = 0; run(); });
  $('[data-hx-versions]', root).addEventListener('change', () => { offset = 0; run(); });
  run();
}

/* ── History section ── */
async function hxOpen(recordId, opener) {
  hx.recordId = recordId; hx.opener = opener || null; hx.limit = 40;
  hx.filter = { institution: '', category: '', from: '', to: '' };
  await hxLoad({ focus: true });
}
async function hxLoad({ focus = false } = {}) {
  const token = ++hx.token;
  const box = $('#gHistory');
  box.hidden = false;
  box.setAttribute('aria-busy', 'true');
  if (!hx.data || hx.data.root_record_id !== hx.recordId) box.innerHTML = `<div class="hx-pad">${skeletonLines(5)}</div>`;
  try {
    const r = await api(`/api/v1/identities/${encodeURIComponent(hx.recordId)}/history${hx.asOf ? `?as_of=${encodeURIComponent(hx.asOf)}` : ''}`);
    if (token !== hx.token) return;
    hx.data = r.data;
    hxRender();
    if (focus) { box.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'auto' : 'smooth' }); $('#hxTitle')?.focus({ preventScroll: true }); }
  } catch (error) {
    if (token !== hx.token) return;
    box.innerHTML = `<div class="hx-pad">${errorState(error.message, 'data-hx-retry')}</div>`;
    $('[data-hx-retry]', box)?.addEventListener('click', () => hxLoad({ focus: true }));
  } finally { box.removeAttribute('aria-busy'); }
}

function hxRender() {
  hx.seen = new Set();
  const d = hx.data; const box = $('#gHistory');
  if (d.not_yet_stored) {
    box.innerHTML = `<header class="hx-head"><div><p class="eyebrow">${icon('history', 'icon-xs')}Student history</p><h2 class="hx-title" id="hxTitle" tabindex="-1">Not stored yet on ${esc(hx.asOf)}</h2>
      <p class="subtle">This source record was stored on ${esc(fmtDate(d.stored_at))}. Nothing about it was known by the end of ${esc(hx.asOf)} (UTC).</p></div>
      <div class="hx-head-actions"><button type="button" class="btn btn-secondary btn-xs" id="hxNow">Show today</button><button type="button" class="icon-btn" id="hxClose" aria-label="Close student history">${icon('x')}</button></div></header>`;
    $('#hxNow').onclick = () => { hx.asOf = ''; hxLoad({ focus: true }); };
    $('#hxClose').onclick = () => { box.hidden = true; hx.data = null; };
    return;
  }
  const names = [...new Set(d.records.map(r => r.values.student_name).filter(Boolean))];
  const versions = d.records.filter(r => r.version > 1 || !r.active).length;
  box.innerHTML = `
    <header class="hx-head">
      <div>
        <p class="eyebrow">${icon('history', 'icon-xs')}Student history</p>
        <h2 class="hx-title" id="hxTitle" tabindex="-1">${esc(names[0] || 'Source record')}${names.length > 1 ? ` <span class="subtle">also recorded as ${esc(names.slice(1).join(', '))}</span>` : ''}</h2>
        <p class="subtle">${plural(d.records.length, 'source record')} · ${plural(d.institutions.length, 'institution')}${versions ? ` · ${plural(versions, 'superseded or corrected version')}` : ''}${d.hidden_records ? ` · ${plural(d.hidden_records, 'linked record')} outside your scope` : ''}</p>
      </div>
      <div class="hx-head-actions">
        <form class="hx-asof" id="hxAsOfForm"><label class="field-label" for="hxAsOf">Known as of</label>
          <input class="input" type="date" id="hxAsOf" value="${esc(hx.asOf)}"><button type="submit" class="btn btn-secondary btn-xs">Apply</button>${hx.asOf ? '<button type="button" class="btn btn-ghost btn-xs" id="hxNow">Today</button>' : ''}</form>
        <button type="button" class="icon-btn" id="hxClose" aria-label="Close student history">${icon('x')}</button>
      </div>
    </header>
    ${hx.asOf ? `<p class="callout info hx-asof-note">${icon('clock')}<span>Showing only records stored, relationships established and decisions recorded by the end of ${esc(hx.asOf)} (UTC). Later events are hidden, not undone.</span></p>` : ''}
    <p class="hx-basis">${icon('shield', 'icon-xs')}${esc(d.basis)}</p>
    <div class="hx-grid">
      <section class="hx-block" aria-labelledby="hxInst"><h3 id="hxInst">Records by institution</h3>
        ${d.institutions.map(i => `<div class="hx-inst"><p class="hx-inst-name"><strong>${esc(i.code)}</strong> ${esc(i.name)}</p><ul class="hx-list">${d.records.filter(r => r.institution_code === i.code).map(r => `<li class="${r.active ? '' : 'is-superseded'}"><div>${esc(r.values.student_name || 'Name not supplied')}<div class="subtle">${hxRef(r)}${r.values.academic_session ? ` · session ${esc(r.values.academic_session)} (reported)` : ''}</div></div><button type="button" class="btn btn-ghost btn-xs" data-record-detail="${esc(r.record_id)}">Details</button></li>`).join('')}</ul></div>`).join('')}
      </section>
      <section class="hx-block" aria-labelledby="hxRel"><h3 id="hxRel">Why these records are connected</h3>
        ${d.relationships.length ? `<ul class="hx-rels">${d.relationships.map(rel => `<li>
          <p><span class="legend-line ${HX_LINE[rel.resolution] || 'candidate'}" aria-hidden="true"></span><strong>${esc(rel.label)}</strong>${rel.within_identity ? '' : ' <span class="badge badge-plain tone-neutral">Not part of this identity</span>'}</p>
          <p class="subtle">${rel.records.map(hxRef).join(' ↔ ')}</p>
          <p class="tag-row">${rel.agreeing_fields.map(f => `<span class="ev-tag is-agree">${icon('check', 'icon-xs')}${esc(HX_FIELD[f] || f)}</span>`).join('')}${rel.similar_fields.map(f => `<span class="ev-tag is-similar">${icon('help', 'icon-xs')}${esc(HX_FIELD[f] || f)} similar</span>`).join('')}${rel.conflicting_fields.map(f => `<span class="ev-tag is-conflict">${icon('alert-triangle', 'icon-xs')}${esc(HX_FIELD[f] || f)}</span>`).join('')}${rel.missing_fields.map(f => `<span class="ev-tag is-missing">${icon('minus-circle', 'icon-xs')}${esc(HX_FIELD[f] || f)} missing</span>`).join('')}${rel.competing_candidates ? `<span class="ev-tag is-conflict">${rel.competing_candidates} competing candidates</span>` : ''}</p>
          ${rel.decision ? `<p class="hx-decision">${icon('check', 'icon-xs')}${esc(rel.decision.decision.replaceAll('_', ' '))} — ${esc(rel.decision.reviewer)}, ${esc(fmtDate(rel.decision.at))}</p>` : ''}
          ${rel.withdrawn ? `<p class="hx-decision is-withdrawn">${icon('rotate', 'icon-xs')}Withdrawn ${esc(fmtDate(rel.withdrawn.at))}</p>` : ''}
          ${rel.link_id ? `<a class="link-btn" href="${routeHash('matches', { match: rel.link_id })}">Evidence and decision${icon('arrow-right', 'icon-xs')}</a>` : ''}
        </li>`).join('')}</ul>` : '<p class="muted">No identity relationships involve these records.</p>'}
      </section>
    </div>
    <section class="hx-block" aria-labelledby="hxVar"><h3 id="hxVar">Recorded attributes</h3>
      <div class="table-scroll"><table class="data-table compact hx-var"><thead><tr><th scope="col">Attribute</th><th scope="col">Values and their sources</th><th scope="col">Status</th></tr></thead><tbody>
      ${d.variations.filter(v => v.state !== 'not_recorded').map(v => { const [label, cls] = HX_VARIATION[v.state] || [v.state, '']; return `<tr><th scope="row">${esc(v.label)}</th><td>${v.values.map(x => `<div><span class="${v.field === 'apaar_id' ? 'mono' : ''}">${esc(x.value)}</span> <span class="subtle">${x.records.map(r => `${esc(r.institution_code)} row ${esc(r.source_row)}${r.version > 1 ? ` v${esc(r.version)}` : ''}`).join(', ')}</span></div>`).join('')}${v.missing_in.length ? `<div class="mx-missing">Missing in ${v.missing_in.map(r => `${esc(r.institution_code)} row ${esc(r.source_row)}`).join(', ')}</div>` : ''}${v.corrections.map(c => `<div class="hx-change">${esc(c.from ?? '—')} → ${esc(c.to ?? '—')} <span class="subtle">(${esc(c.basis === 'reviewer_confirmed' ? 'confirmed by a user' : 'institution reference')})</span></div>`).join('')}</td><td><span class="mx-state ${cls}">${esc(label)}</span>${v.note ? `<p class="subtle">${esc(v.note)}</p>` : ''}</td></tr>`; }).join('')}
      </tbody></table></div>
      ${d.variations.some(v => v.state === 'not_recorded') ? `<p class="subtle">Not recorded by any source: ${esc(d.variations.filter(v => v.state === 'not_recorded').map(v => v.label).join(', '))}.</p>` : ''}
    </section>
    <section class="hx-block" aria-labelledby="hxTl"><h3 id="hxTl">Timeline</h3>
      <p class="subtle">${esc(d.time_note)}</p>
      <div class="hx-filters" id="hxFilters">
        <div class="field"><label class="field-label" for="hxFInst">Institution</label><select class="select" id="hxFInst"><option value="">All</option>${d.institutions.map(i => `<option value="${esc(i.code)}"${hx.filter.institution === i.code ? ' selected' : ''}>${esc(i.code)}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label" for="hxFCat">Event type</label><select class="select" id="hxFCat"><option value="">All</option>${Object.entries(HX_CATEGORY).map(([k, v]) => `<option value="${k}"${hx.filter.category === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label" for="hxFFrom">From</label><input class="input" type="date" id="hxFFrom" value="${esc(hx.filter.from)}"></div>
        <div class="field"><label class="field-label" for="hxFTo">To</label><input class="input" type="date" id="hxFTo" value="${esc(hx.filter.to)}"></div>
      </div>
      <div class="hx-tl-bar"><p class="subtle" id="hxCount" role="status"></p>
        <div class="hx-tl-actions"><button type="button" class="btn btn-ghost btn-xs" id="hxPrevDecision">${icon('chevron-up', 'icon-xs')}Previous decision</button><button type="button" class="btn btn-ghost btn-xs" id="hxNextDecision">${icon('chevron-down', 'icon-xs')}Next decision</button><button type="button" class="btn btn-ghost btn-xs" id="hxExpand">Expand all</button><button type="button" class="btn btn-ghost btn-xs" id="hxReset" hidden>Reset filters</button></div></div>
      <ol class="hx-tl" id="hxTimeline"></ol>
    </section>`;
  hxRenderTimeline();
  hxBind();
}

function hxFiltered() {
  const f = hx.filter;
  return hx.data.timeline.filter(e => (!f.institution || e.institution_code === f.institution || (e.source && e.source.institution_code === f.institution))
    && (!f.category || e.category === f.category) && (!f.from || String(e.at).slice(0, 10) >= f.from) && (!f.to || String(e.at).slice(0, 10) <= f.to));
}

function hxEventDetails(e) {
  const rows = [];
  if (e.reported) rows.push(`<div><dt>Reported by institution</dt><dd>${[e.reported.academic_session && `session ${esc(e.reported.academic_session)}`, e.reported.admission_year && `admitted ${esc(e.reported.admission_year)}`, e.reported.enrolment_status && esc(e.reported.enrolment_status)].filter(Boolean).join(' · ') || '—'}</dd></div>`);
  if (e.values) rows.push(`<div><dt>Recorded values</dt><dd>${esc(e.values.name || '—')} · ${esc(e.values.date_of_birth || 'no date of birth')} · <span class="mono">${esc(e.values.apaar_id || 'no identifier')}</span>${e.values.programme ? ` · ${esc(e.values.programme)}` : ''}</dd></div>`);
  if (e.changes?.length) rows.push(`<div class="hx-changes"><dt>Changed</dt><dd>${e.changes.map(c => `<div class="hx-change"><span class="hx-change-field">${esc(c.label)}</span>
    <span class="hx-change-pair"><span class="hx-old"><span class="hx-change-cap">Before</span><span class="hx-change-val">${esc(c.from ?? '—')}</span></span>${icon('arrow-right', 'icon-xs hx-change-arrow')}<span class="hx-new"><span class="hx-change-cap">After</span><span class="hx-change-val">${esc(c.to ?? '—')}</span></span></span></div>`).join('')}</dd></div>`);
  if (e.from_state) rows.push(`<div><dt>State</dt><dd>${esc(e.from_state.replaceAll('_', ' ').toLowerCase())} → ${esc(e.to_state.replaceAll('_', ' ').toLowerCase())}</dd></div>`);
  if (e.explanation) rows.push(`<div><dt>Rule</dt><dd>${esc(e.explanation)}</dd></div>`);
  if (e.note) rows.push(`<div><dt>Note</dt><dd>${esc(e.note)}</dd></div>`);
  if (e.actor) rows.push(`<div><dt>By</dt><dd>${esc(e.actor)}</dd></div>`);
  return rows.join('');
}

function hxRenderTimeline() {
  const all = hx.data.timeline; const list = hxFiltered();
  const filtered = list.length !== all.length;
  $('#hxCount').textContent = filtered ? `Filtered: ${list.length} of ${all.length} events` : `${plural(all.length, 'event')}`;
  $('#hxReset').hidden = !filtered;
  const shown = list.slice(0, hx.limit);
  /* Only events that were not on screen before are revealed, so filtering and paging animate what
     changed rather than replaying the whole list. */
  const seen = hx.seen || new Set();
  let fresh = 0;
  $('#hxTimeline').innerHTML = shown.length ? shown.map(e => { const [mark, markClass] = hxMark(e); const isNew = !seen.has(e.id); return `
    <li class="hx-ev cat-${esc(e.category)} ${markClass}${isNew ? ' is-new' : ''}" data-ev="${esc(e.id)}" data-cat="${esc(e.category)}"${isNew ? ` style="--i:${Math.min(fresh++, 12)}"` : ''}>
      <span class="hx-dot" aria-hidden="true">${icon(mark, 'icon-xs')}</span>
      <div class="hx-ev-main">
        <p class="hx-ev-when"><time datetime="${esc(e.at)}">${esc(fmtDate(e.at))}</time> <span class="hx-kind kind-${esc(e.time_kind)}">${esc(HX_TIME[e.time_kind] || e.time_kind)}</span></p>
        <p class="hx-ev-title"><span class="badge badge-plain tone-neutral">${esc(HX_CATEGORY[e.category] || e.category)}</span>${e.evidence_kind ? `<span class="badge badge-plain ${e.evidence_kind === 'contradiction' ? 'tone-danger' : e.evidence_kind === 'missing' ? 'tone-warning' : 'tone-neutral'}">${esc(HX_EVIDENCE[e.evidence_kind] || e.evidence_kind)}</span>` : ''} ${esc(e.title || outcomeLabel(e.type))}${e.institution_code ? ` <span class="subtle">· ${esc(e.institution_code)}</span>` : ''}</p>
        <details class="hx-ev-more"><summary>Details</summary><dl class="kv">${hxEventDetails(e)}</dl>
          <p class="hx-ev-links">${[...new Set(e.record_ids || [])].map(id => { const r = hx.data.records.find(x => x.record_id === id); return `<button type="button" class="link-btn" data-record-detail="${esc(id)}">${r ? `${esc(r.institution_code)} row ${esc(r.source_row)}${r.version > 1 ? ` v${esc(r.version)}` : ''}${r.active ? '' : ' (superseded)'}` : 'Source record'}</button>`; }).join(' ')}${e.finding_id ? ` <a class="link-btn" href="#/reconciliation?finding=${esc(e.finding_id)}&lifecycle=all">Open finding</a>` : ''}</p></details>
      </div>
    </li>`; }).join('') : `<li class="muted hx-empty">No events match these filters.</li>`;
  hx.seen = new Set([...seen, ...shown.map(e => e.id)]);
  if (list.length > shown.length) $('#hxTimeline').insertAdjacentHTML('beforeend', `<li><button type="button" class="btn btn-ghost btn-xs" id="hxMore">Show ${Math.min(40, list.length - shown.length)} more of ${list.length - shown.length}</button></li>`);
  $('#hxMore')?.addEventListener('click', () => { hx.limit += 40; hxRenderTimeline(); });
}

function hxBind() {
  const box = $('#gHistory');
  $('#hxClose').onclick = () => { box.hidden = true; hx.data = null; (hx.opener?.isConnected ? hx.opener : $('#gPanel'))?.focus?.(); };
  $('#hxAsOfForm').onsubmit = event => { event.preventDefault(); hx.asOf = $('#hxAsOf').value; hxLoad({ focus: true }); };
  $('#hxNow')?.addEventListener('click', () => { hx.asOf = ''; hxLoad({ focus: true }); });
  const sync = () => { hx.filter = { institution: $('#hxFInst').value, category: $('#hxFCat').value, from: $('#hxFFrom').value, to: $('#hxFTo').value }; hx.limit = 40; hxRenderTimeline(); };
  $$('#hxFilters select, #hxFilters input').forEach(el => el.addEventListener('change', sync));
  $('#hxReset').onclick = () => { $('#hxFInst').value = ''; $('#hxFCat').value = ''; $('#hxFFrom').value = ''; $('#hxFTo').value = ''; sync(); $('#hxCount').focus?.(); };
  $('#hxExpand').onclick = event => { const open = event.currentTarget.textContent.trim() === 'Expand all'; $$('#hxTimeline details').forEach(d => { d.open = open; }); event.currentTarget.textContent = open ? 'Collapse all' : 'Expand all'; };
  const jump = dir => {
    const items = $$('#hxTimeline .hx-ev[data-cat="review"]');
    if (!items.length) { toast('No user decisions in the shown events.', { tone: 'info' }); return; }
    const current = items.findIndex(li => li.classList.contains('is-current'));
    const next = items[(current + dir + items.length) % items.length] || items[0];
    items.forEach(li => li.classList.remove('is-current'));
    next.classList.add('is-current'); $('details', next).open = true;
    next.scrollIntoView({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' }); $('summary', next).focus();
  };
  $('#hxNextDecision').onclick = () => jump(1);
  $('#hxPrevDecision').onclick = () => jump(-1);
}

/* ── Record detail dialog ── */
async function hxRecordDialog(recordId, opener) {
  const dialog = $('#recordDialog');
  const body = $('#recordDialogBody');
  body.innerHTML = skeletonLines(6);
  if (!dialog.open) dialog.showModal();
  dialog.dataset.opener = '';
  hx.dialogOpener = opener || null;
  try {
    const r = (await api(`/api/v1/records/${encodeURIComponent(recordId)}`)).data;
    $('#recordDialogTitle').textContent = `Source record · ${r.institution_code} row ${r.source_row}`;
    const keys = Object.keys(r.original);
    body.innerHTML = `
      <dl class="kv rd-prov">
        <div><dt>Record</dt><dd class="mono">${esc(r.record_id)}</dd></div>
        <div><dt>Institution reference</dt><dd>${r.source_reference ? `<span class="mono">${esc(r.source_reference)}</span>` : `<span class="muted">${esc(r.source_reference_note)}</span>`}</dd></div>
        <div><dt>Source</dt><dd><span class="mono">${esc(r.source_file)}</span> row ${esc(r.source_row)} · ${esc(r.institution_code)}</dd></div>
        <div><dt>Import</dt><dd>${r.batch.id ? `${esc(r.batch.file)} · ${esc(fmtDate(r.batch.created_at))}` : esc(r.batch.note)}</dd></div>
        <div><dt>Version</dt><dd>v${esc(r.version)} · ${esc(r.relation.replaceAll('_', ' '))} · ${r.active ? 'current' : `superseded by <span class="mono">${esc(r.superseded_by)}</span>`}</dd></div>
        <div><dt>Verification</dt><dd>Local format checks only (${esc(r.processing?.identifier_check || 'n/a')}); no authoritative APAAR verification.</dd></div>
        <div><dt>External services</dt><dd id="rdExternal" class="muted">Checking the integration adapter…</dd></div>
      </dl>
      <h3 class="rd-h">Values as recorded and as compared</h3>
      <div class="table-scroll"><table class="data-table compact"><thead><tr><th scope="col">Field</th><th scope="col">As recorded in the file</th><th scope="col">Compared as</th></tr></thead><tbody>${keys.map(k => `<tr><td>${esc(k)}</td><td class="mono">${r.original[k] ? `“${esc(r.original[k])}”` : '<span class="muted">Empty</span>'}</td><td class="mono">${esc(r.comparison[k] ?? '—')}</td></tr>`).join('')}</tbody></table></div>
      ${r.lineage?.versions.length > 1 ? `<h3 class="rd-h">Versions</h3><ol class="pf-versions">${r.lineage.versions.map(v => `<li class="${v.active ? '' : 'is-superseded'}"><strong>v${esc(v.version)}</strong> ${esc(v.relation.replaceAll('_', ' '))} · <span class="mono">${esc(v.source_file)}</span> row ${esc(v.source_row)} · ${esc(fmtDate(v.imported_at))}${v.changes.length ? `<ul>${v.changes.map(c => `<li>${esc(c.label)}: ${esc(c.from ?? '—')} → ${esc(c.to ?? '—')}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>` : ''}
      <h3 class="rd-h">Findings</h3>${r.findings.length ? `<ul class="hx-plain">${r.findings.map(f => `<li><a href="#/reconciliation?finding=${esc(f.id)}&lifecycle=all">${esc(f.title)}</a> <span class="subtle">${esc(HX_EVIDENCE[f.evidence_kind] || f.evidence_kind)} · ${esc(f.lifecycle_status === 'current' ? statusLabel(f.review_status) : f.lifecycle_status)}</span></li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
      <h3 class="rd-h">Identity relationships</h3>${r.relationships.length ? `<ul class="hx-plain">${r.relationships.map(l => `<li><span class="legend-line ${HX_LINE[l.resolution] || 'candidate'}" aria-hidden="true"></span> ${esc(l.label)} with ${hxRef(l.other)}${l.decision ? ` · ${esc(l.decision.reviewer)}` : ''}</li>`).join('')}</ul>` : '<p class="muted">None.</p>'}
      <h3 class="rd-h">Audit events</h3>${r.audit.length ? `<ol class="hx-plain">${r.audit.map(a => `<li>${esc(fmtDate(a.at))} · ${esc(outcomeLabel(a.action))} · ${esc(a.actor)}</li>`).join('')}</ol>` : '<p class="muted">None.</p>'}
      <div class="rd-actions"><button type="button" class="btn btn-secondary btn-sm" data-history="${esc(r.record_id)}">${icon('history', 'icon-sm')}Student history</button><a class="btn btn-ghost btn-sm" href="${routeHash('profile', { record: r.record_id, tab: 'sources' })}">Profile</a></div>`;
    hxExternalVerification(recordId);
  } catch (error) {
    body.innerHTML = errorState(error.message);
  }
}

/* External services sit behind one adapter. "Not connected" is the honest default; a mock adapter is
   labelled simulated wherever it appears. */
const HX_APAAR = {
  format: { missing: 'Missing', malformed: 'Malformed (not 12 digits)', well_formed: 'Well-formed (local format check only)' },
  verification: { not_connected: 'Not verified: no APAAR service is connected', consent_required: 'Not sent: consent is not granted', not_checkable: 'Not sent: identifier missing or malformed', mock_record_found: 'Mock: record found', mock_no_record: 'Mock: no record' },
  conflict: { none: 'None open', identifier_conflict: 'Identifier shared with conflicting name or date of birth', shared_identifier_pending_review: 'Identifier shared; review pending', concurrent_enrolment_review: 'Concurrent enrolment under review' },
  consent: { granted: 'Granted', withdrawn: 'Withdrawn', not_recorded: 'Not recorded' }
};
async function hxExternalVerification(recordId) {
  const el = $('#rdExternal');
  try {
    const v = (await api(`/api/v1/records/${encodeURIComponent(recordId)}/verification`)).data;
    if (!el?.isConnected) return;
    el.classList.remove('muted');
    const canRecord = (state.principal?.capabilities || []).includes('consent.record') && !state.readOnly;
    el.innerHTML = `
      <dl class="gp-kv apaar-status">
        <dt>APAAR ID</dt><dd class="mono">${esc(v.identifier || 'Not provided')} · ${esc(HX_APAAR.format[v.format_status])}</dd>
        <dt>Verification</dt><dd>${v.simulated ? '<span class="badge badge-plain tone-warning">SIMULATED</span> ' : ''}${esc(HX_APAAR.verification[v.verification_status] || v.verification_status)}${v.verification_source === 'none' ? ' (APAAR, ABC, DigiLocker: not connected)' : ''}</dd>
        <dt>Conflicts</dt><dd>${esc(HX_APAAR.conflict[v.conflict_status] || v.conflict_status)}</dd>
        <dt>Consent</dt><dd>${esc(HX_APAAR.consent[v.consent_status] || v.consent_status)} <span class="subtle">(identity verification)</span></dd>
      </dl>
      <p class="subtle">${esc(v.detail)}${v.label ? ` ${esc(v.label)}` : ''} Not connected (APAAR, ABC, DigiLocker) means no official check has been made.</p>
      ${canRecord ? `<form class="consent-form" id="rdConsent"><label class="field-label" for="rdConsentStatus">Record consent</label>
        <select class="select" id="rdConsentStatus"><option value="granted">Granted</option><option value="withdrawn">Withdrawn</option></select>
        <input class="input" id="rdConsentRef" maxlength="200" placeholder="Where the signed form is held" aria-label="Where the consent record is held">
        <button type="submit" class="btn btn-secondary btn-xs">Record</button><p class="field-error" id="rdConsentError" hidden></p></form>` : ''}`;
    $('#rdConsent')?.addEventListener('submit', async event => {
      event.preventDefault();
      try {
        await withFeedback(event.submitter, () => api(`/api/v1/records/${encodeURIComponent(recordId)}/consent`, { method: 'POST', body: JSON.stringify({ status: $('#rdConsentStatus').value, reference: $('#rdConsentRef').value }) }), { done: 'Recorded' });
        hxExternalVerification(recordId);
      } catch (error) { $('#rdConsentError').textContent = error.message; $('#rdConsentError').hidden = false; }
    });
  } catch { if (el?.isConnected) el.textContent = 'External verification status unavailable.'; }
}

document.addEventListener('click', event => {
  const detail = event.target.closest('[data-record-detail]');
  if (detail) { hxRecordDialog(detail.dataset.recordDetail, detail); return; }
  const history = event.target.closest('#gHistory [data-history], #recordDialog [data-history]');
  if (history) {
    if ($('#recordDialog').open) $('#recordDialog').close();
    if (state.view !== 'graph') go('graph');
    hxOpen(history.dataset.history, history);
  }
});
$('#recordDialogClose')?.addEventListener('click', () => $('#recordDialog').close());
$('#recordDialog')?.addEventListener('close', () => { if (hx.dialogOpener?.isConnected) hx.dialogOpener.focus(); });
