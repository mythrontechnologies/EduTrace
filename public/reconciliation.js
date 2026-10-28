/* EduTrace AI — Reconciliation Workspace
   SIH 26263 · Search, filters, findings table, evidence drawer and review decisions.
   All filtering and scoping happens server-side; this module only renders results.
   ──────────────────────────────────────────────── */
'use strict';

const RX_PARAMS = ['q', 'institution', 'category', 'severity', 'status', 'session', 'batch', 'lifecycle'];
const activeRxParams = () => state.auth === 'hosted_demo' ? RX_PARAMS.filter(key => key !== 'status') : RX_PARAMS;
const RX_FILTER_LABELS = {
  institution: 'Institution',
  category: 'Issue type',
  severity: 'Severity',
  status: 'Status',
  session: 'Session',
  batch: 'Batch / file',
  lifecycle: 'Lifecycle'
};

const rx = {
  filters: Object.fromEntries(RX_PARAMS.map(key => [key, ''])),
  response: null,
  sorted: [],
  sort: { key: 'severity', dir: 'desc' },
  page: 1,
  pageSize: 25,
  queryKey: null,
  loadToken: 0,
  batches: {},
  institutionNames: {},
  openId: null,
  detail: null,
  returnFocus: null,
  showAllRecords: false
};

/* ── Route Integration ────────────────────────── */
registerView('reconciliation', {
  enter(params, { changed }) {
    const filters = Object.fromEntries(activeRxParams().map(key => [key, params.get(key) || '']));
    const key = JSON.stringify(filters);
    rx.filters = filters;
    rxSetInputs(filters);

    if (params.get('focus') === 'search') {
      replaceRoute('reconciliation', filters);
      requestAnimationFrame(() => $('#rxQuery').focus());
    }

    const findingId = params.get('finding');
    if (changed || key !== rx.queryKey || !rx.response) {
      rx.queryKey = key;
      rx.page = 1;
      rxLoad().then(() => rxSyncDrawer(findingId));
    } else {
      rxSyncDrawer(findingId);
    }
  },
  leave() {
    const drawer = $('#findingDrawer');
    if (drawer.open) drawer.close();
  }
});

function rxSetInputs(filters) {
  $('#rxQuery').value = filters.q;
  $('#rxClearQuery').hidden = !filters.q;
  $$('#rxFilters select').forEach(select => {
    const value = filters[select.dataset.param] || '';
    rxEnsureOption(select, value);
    select.value = value;
    select.classList.toggle('is-set', Boolean(value));
  });
}

/* Keep a URL-provided value selectable even before options load. */
function rxEnsureOption(select, value) {
  if (!value || [...select.options].some(option => option.value === value)) return;
  const option = document.createElement('option');
  option.value = value;
  option.textContent = rxFilterValueLabel(select.dataset.param, value);
  select.append(option);
}

function rxFilterValueLabel(param, value) {
  if (param === 'institution') return rx.institutionNames[value] ? `${value} · ${rx.institutionNames[value]}` : value;
  if (param === 'category') return String(value).split(',').map(v => CATEGORY[v] || ruleLabel(v)).join(' or ');
  if (param === 'severity') return SEVERITY[value]?.label || value;
  if (param === 'status') return statusLabel(value);
  if (param === 'lifecycle') return value === 'historical' ? 'Historical' : value === 'all' ? 'Current and historical' : value;
  if (param === 'batch') {
    const batch = rx.batches[value];
    return batch ? `${batch.source_file} (${value})` : value;
  }
  return value;
}

function rxApply(filters) {
  filters = Object.fromEntries(activeRxParams().map(key => [key, filters[key] || '']));
  rx.filters = filters;
  rx.queryKey = JSON.stringify(filters);
  rx.page = 1;
  replaceRoute('reconciliation', filters);
  rxSetInputs(filters);
  rxLoad();
}

function rxReadInputs() {
  const filters = { q: $('#rxQuery').value.trim() };
  $$('#rxFilters select').forEach(select => { if (activeRxParams().includes(select.dataset.param)) filters[select.dataset.param] = select.value; });
  return filters;
}

/* ── Loading ──────────────────────────────────── */
async function rxLoad({ keepPage = false } = {}) {
  const token = ++rx.loadToken;
  if (!keepPage) rx.page = 1;
  if (!rx.response || !keepPage) rxRenderSkeleton();
  else $('#rxRows').classList.add('is-refreshing');
  $('#rxSummary').innerHTML = `<span class="rx-loading">${icon('rotate', 'icon-xs')}Loading findings…</span>`;
  rxSheetDoneLabel('Loading…');
  const qs = new URLSearchParams(Object.entries(rx.filters).filter(([, value]) => value));

  const [findingsRes, importsRes] = await Promise.allSettled([
    api('/api/v1/findings' + (qs.toString() ? `?${qs}` : '')),
    api('/api/v1/imports')
  ]);
  if (token !== rx.loadToken) return;
  $('#rxRows').classList.remove('is-refreshing');

  if (importsRes.status === 'fulfilled') {
    rx.batches = Object.fromEntries(importsRes.value.data.map(batch => [batch.id, batch]));
    importsRes.value.institutions.forEach(item => { rx.institutionNames[item.code] = item.name; });
  }

  if (findingsRes.status === 'rejected') {
    rx.response = null;
    rx.sorted = [];
    $('#rxRows').innerHTML = `<tr><td colspan="8">${errorState(findingsRes.reason.message, 'data-retry-rx')}</td></tr>`;
    $('#rxSummary').textContent = 'Findings are unavailable.';
    rxSheetDoneLabel('Close');
    $('#rxPager').hidden = true;
    $('[data-retry-rx]')?.addEventListener('click', () => rxLoad());
    return;
  }

  rx.response = findingsRes.value;
  rx.response.filter_options.institutions.forEach(item => { rx.institutionNames[item.code] = item.name; });
  rxPopulateFilters(rx.response.filter_options);
  rxRenderChips();
  rxRenderSummary();
  rxRenderRows();
}

function rxRenderSkeleton() {
  $('#rxRows').innerHTML = Array.from({ length: 6 }, () => `
    <tr class="skel-row" aria-hidden="true">
      <td><span class="skel skel-line" style="width:80%"></span><span class="skel skel-line" style="width:40%"></span></td>
      <td><span class="skel skel-line" style="width:70%"></span></td>
      <td><span class="skel skel-line" style="width:50%"></span></td>
      <td class="col-hide-md"><span class="skel skel-line" style="width:70%"></span></td>
      <td><span class="skel skel-line" style="width:60%"></span></td>
      <td><span class="skel skel-line" style="width:70%"></span></td>
      <td class="col-hide-md"><span class="skel skel-line" style="width:60%"></span></td>
      <td></td>
    </tr>`).join('');
  $('#rxPager').hidden = true;
}

/* ── Filters ──────────────────────────────────── */
function rxFillSelect(select, groups) {
  const current = select.value;
  const first = select.options[0];
  select.replaceChildren(first);
  groups.forEach(group => {
    if (!group.items.length) return;
    const parent = group.label ? document.createElement('optgroup') : select;
    if (group.label) parent.label = group.label;
    group.items.forEach(item => {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      parent.append(option);
    });
    if (group.label) select.append(parent);
  });
  rxEnsureOption(select, current);
  select.value = current;
}

function rxPopulateFilters(options) {
  const statusField = $('#rxStatus').parentElement;
  statusField.hidden = state.auth === 'hosted_demo';
  rxFillSelect($('#rxInstitution'), [{ items: options.institutions.map(i => ({ value: i.code, label: `${i.code} · ${i.name}` })) }]);
  const categories = options.categories.filter(value => CATEGORY[value]);
  const rules = options.categories.filter(value => !CATEGORY[value]);
  rxFillSelect($('#rxCategory'), [
    { label: 'Issue categories', items: categories.map(value => ({ value, label: CATEGORY[value] })) },
    { label: 'Specific rules', items: rules.map(value => ({ value, label: ruleLabel(value) })) }
  ]);
  rxFillSelect($('#rxSeverity'), [{ items: [...options.severities].sort((a, b) => (SEVERITY[b]?.rank || 0) - (SEVERITY[a]?.rank || 0)).map(value => ({ value, label: SEVERITY[value]?.label || value })) }]);
  if (state.auth !== 'hosted_demo') rxFillSelect($('#rxStatus'), [{ items: [...options.statuses].sort((a, b) => (STATUS[a]?.rank ?? 9) - (STATUS[b]?.rank ?? 9)).map(value => ({ value, label: statusLabel(value) })) }]);
  rxFillSelect($('#rxSession'), [{ items: options.sessions.map(value => ({ value, label: value })) }]);
  rxFillSelect($('#rxBatch'), [
    { label: 'Import batches', items: options.batches.map(value => ({ value, label: rx.batches[value] ? `${rx.batches[value].source_file} · ${value}` : value })) },
    { label: 'Source files', items: options.source_files.map(value => ({ value, label: value })) }
  ]);
  $$('#rxFilters select').forEach(select => select.classList.toggle('is-set', Boolean(select.value)));
}

function rxRenderChips() {
  const active = activeRxParams().filter(key => rx.filters[key]);
  $('#rxActive').hidden = !active.length;
  $('#rxChips').innerHTML = active.map(key => {
    const label = key === 'q' ? 'Search' : RX_FILTER_LABELS[key];
    const value = key === 'q' ? `“${rx.filters.q}”` : rxFilterValueLabel(key, rx.filters[key]);
    return `<span class="chip"><span class="chip-text">${esc(label)}: <b>${esc(value)}</b></span>
      <button type="button" data-remove="${key}" aria-label="${esc(`Remove ${label} filter: ${value}`)}">${icon('x', 'icon-xs')}</button></span>`;
  }).join('');
  const selectCount = active.filter(key => key !== 'q').length;
  $('#rxFilterCount').hidden = !selectCount;
  $('#rxFilterCount').textContent = selectCount;
}

function rxRenderSummary() {
  const res = rx.response;
  const filtered = activeRxParams().some(key => rx.filters[key]);
  const sev = res.by_severity.filter(item => item.count).map(item => `<span class="badge sev-${item.severity}">${icon(SEVERITY[item.severity].icon)}${item.count} ${SEVERITY[item.severity].label.toLowerCase()}</span>`).join('');
  const scope = { current: 'current', historical: 'historical', all: 'current and historical' }[res.lifecycle] || 'current';
  const historical = res.lifecycle === 'current' && res.lifecycle_counts?.historical
    ? ` · <button type="button" class="link-btn" data-lifecycle="historical">View ${plural(res.lifecycle_counts.historical, 'historical finding')}</button>` : '';
  $('#rxSummary').innerHTML = `
    <span>${filtered && activeRxParams().some(key => key !== 'lifecycle' && rx.filters[key])
      ? `<strong>${res.total}</strong> of <strong>${res.accessible_total}</strong> ${scope} ${res.accessible_total === 1 ? 'finding matches' : 'findings match'} your search and filters`
      : `<strong>${res.total}</strong> ${scope} ${res.total === 1 ? 'finding' : 'findings'} in your scope`}${historical}</span>
    <span class="rx-sevsum">${sev}</span>`;
  rxSheetDoneLabel(`Show ${plural(res.total, 'result')}`);
}

/* ── Mobile filter drawer ─────────────────────── */
/* Below 768px the filter fields move into a modal sheet (native <dialog>:
   focus is contained, Escape closes it, focus returns to the Filters button). */
function rxSheetDoneLabel(text) {
  const done = $('#rxSheetDone');
  if (done) done.textContent = text;
}

function rxOpenSheet() {
  const sheet = $('#rxFilterSheet');
  $('#rxSheetBody').append($('#rxFilters'));
  sheet.showModal();
  $('#rxFilterToggle').setAttribute('aria-expanded', 'true');
  $('#rxFilters select')?.focus();
}

function rxRestoreFilters() {
  const filters = $('#rxFilters');
  if (filters.parentElement !== $('#rxSearchForm').parentElement) $('#rxSearchForm').after(filters);
}

/* ── Table ────────────────────────────────────── */
const RX_SORTERS = {
  title: f => f.title.toLocaleLowerCase('en-IN'),
  student: f => (f.records[0]?.student_name || '').toLocaleLowerCase('en-IN'),
  institution: f => institutionText(f.records),
  category: f => categoryLabel(f.category),
  severity: f => SEVERITY[f.severity]?.rank || 0,
  status: f => STATUS[f.review_status]?.rank ?? 9,
  source: f => `${f.records[0]?.source_file || ''}|${String(f.records[0]?.source_row ?? '').padStart(6, '0')}`
};

function rxSortData(data) {
  const { key, dir } = rx.sort;
  const read = RX_SORTERS[key];
  const factor = dir === 'asc' ? 1 : -1;
  return [...data].sort((a, b) => {
    const x = read(a);
    const y = read(b);
    const primary = x < y ? -1 : x > y ? 1 : 0;
    return primary * factor ||
      (STATUS[a.review_status]?.rank ?? 9) - (STATUS[b.review_status]?.rank ?? 9) ||
      (SEVERITY[b.severity]?.rank || 0) - (SEVERITY[a.severity]?.rank || 0) ||
      String(a.created_at).localeCompare(String(b.created_at));
  });
}

function rxFindingHref(id) {
  return routeHash('reconciliation', { ...rx.filters, finding: id });
}

function rxStudentCell(f) {
  const records = f.records;
  if (!records.length) return '<span class="subtle">Outside your scope</span>';
  if (records.length > 4) return `<div class="cell-main">${plural(records.length, 'source record')}</div><div class="cell-sub">${esc(records[0].programme)} cohort</div>`;
  const names = [...new Set(records.map(r => r.student_name || 'Name not provided'))];
  return `<div class="cell-main">${names.map(esc).join('<br>')}</div>${records.length > 1 ? `<div class="cell-sub">${plural(records.length, 'linked record')}${names.length > 1 ? ' · names differ' : ''}</div>` : ''}`;
}

function rxInstitutionCell(f) {
  const codes = [...new Set(f.records.map(r => r.institution_code))];
  if (!codes.length) return '—';
  if (codes.length > 1) return `<div class="cell-main">${codes.map(esc).join(' ↔ ')}</div><div class="cell-sub">Cross-institution</div>`;
  return `<div class="cell-main" title="${esc(rx.institutionNames[codes[0]] || '')}">${esc(codes[0])}</div><div class="cell-sub">Single institution</div>`;
}

function rxSourceCell(f) {
  const records = f.records;
  if (!records.length) return '—';
  if (records.length > 4) return `<div class="cell-main">${plural(records.length, 'row')}</div><div class="cell-sub">${esc([...new Set(records.map(r => r.source_file))].join(', '))}</div>`;
  const files = [...new Set(records.map(r => r.source_file))];
  if (files.length === 1) return `<div class="cell-main nowrap">${records.length > 1 ? 'Rows' : 'Row'} ${records.map(r => r.source_row).sort((a, b) => a - b).join(', ')}</div><div class="cell-sub">${esc(files[0])}</div>`;
  return records.map(r => `<div class="cell-main nowrap">${esc(r.institution_code)} row ${r.source_row}</div>`).join('') + `<div class="cell-sub">${plural(files.length, 'source file')}</div>`;
}

function rxRenderRows() {
  const data = rx.response.data;
  rx.sorted = rxSortData(data);

  $$('#rxTable th[data-sort]').forEach(th => {
    const active = th.dataset.sort === rx.sort.key;
    if (active) th.setAttribute('aria-sort', rx.sort.dir === 'asc' ? 'ascending' : 'descending');
    else th.removeAttribute('aria-sort');
    $('use', th).setAttribute('href', active ? (rx.sort.dir === 'asc' ? '#i-sort-asc' : '#i-sort-desc') : '#i-sort');
  });

  if (!data.length) {
    const filtered = activeRxParams().some(key => rx.filters[key]);
    $('#rxRows').innerHTML = `<tr><td colspan="8">${filtered
      ? emptyState({ iconName: 'search', title: 'No findings match this search and filter combination', text: 'Try a shorter search term, remove a filter, or clear everything to see all accessible findings.', action: '<button type="button" class="btn btn-secondary btn-sm" data-clear-all>Clear all filters</button>' })
      : emptyState({ iconName: 'check-circle', title: 'No findings in your access scope', text: 'Reconciliation has not produced any findings for the records you can access.', action: '<a class="btn btn-primary btn-sm" href="#/import">Import student data</a>' })}</td></tr>`;
    $('[data-clear-all]')?.addEventListener('click', rxClearAll);
    $('#rxPager').hidden = true;
    return;
  }

  const pages = Math.max(Math.ceil(rx.sorted.length / rx.pageSize), 1);
  rx.page = Math.min(rx.page, pages);
  const start = (rx.page - 1) * rx.pageSize;
  const pageRows = rx.sorted.slice(start, start + rx.pageSize);

  $('#rxRows').innerHTML = pageRows.map(f => `
    <tr class="is-clickable${f.id === rx.openId ? ' is-selected' : ''}" data-id="${esc(f.id)}">
      <td class="cell-wide" data-label="Finding">
        <div class="cell-title"><a href="${rxFindingHref(f.id)}" data-finding-link>${esc(f.title)}</a></div>
        <div class="cell-sub"><span class="mono">#${esc(shortId(f.id))}</span> · ${esc(fmtDate(f.created_at, false))}</div>
      </td>
      <td data-label="Student / record">${rxStudentCell(f)}</td>
      <td data-label="Institution">${rxInstitutionCell(f)}</td>
      <td class="col-hide-md" data-label="Issue type"><div class="cell-main">${esc(categoryLabel(f.category))}</div><div class="cell-sub">${esc(ruleLabel(f.rule_code))}</div></td>
      <td data-label="Severity">${sevBadge(f.severity)}</td>
      <td data-label="Review status">${statusBadge(f.review_status)}${isHistorical(f) ? `<div style="margin-top:5px">${lifecycleBadge(f)}</div>` : ''}</td>
      <td class="col-hide-md" data-label="Source">${rxSourceCell(f)}</td>
      <td class="col-actions"><a class="btn btn-secondary btn-xs" href="${rxFindingHref(f.id)}" aria-label="${esc(`Review finding: ${f.title}, ${recordContext(f)}`)}">Review${icon('chevron-right', 'icon-xs')}</a></td>
    </tr>`).join('');

  const pager = $('#rxPager');
  pager.hidden = false;
  pager.innerHTML = `
    <span>Showing ${start + 1}–${start + pageRows.length} of ${rx.sorted.length}</span>
    ${pages > 1 ? `<div class="pager">
      <button type="button" class="icon-btn icon-btn-sm bordered" data-page="-1" aria-label="Previous page" ${rx.page === 1 ? 'disabled' : ''}>${icon('chevron-left', 'icon-sm')}</button>
      <span>Page ${rx.page} of ${pages}</span>
      <button type="button" class="icon-btn icon-btn-sm bordered" data-page="1" aria-label="Next page" ${rx.page === pages ? 'disabled' : ''}>${icon('chevron-right', 'icon-sm')}</button>
    </div>` : '<span>Sorted by column headers · select a row to review</span>'}`;
}

function rxClearAll() {
  rxApply(Object.fromEntries(activeRxParams().map(key => [key, ''])));
  $('#rxQuery').focus();
}

/* ── Finding Drawer ───────────────────────────── */
function rxSyncDrawer(findingId) {
  const drawer = $('#findingDrawer');
  if (findingId && findingId !== rx.openId) rxOpenFinding(findingId);
  else if (findingId && !drawer.open) rxOpenFinding(findingId);
  else if (!findingId && drawer.open) drawer.close();
}

async function rxOpenFinding(id) {
  rx.openId = id;
  rx.showAllRecords = false;
  const drawer = $('#findingDrawer');
  if (!drawer.open) {
    rx.returnFocus = document.activeElement;
    drawer.showModal();
  }
  $$('#rxRows tr[data-id]').forEach(row => row.classList.toggle('is-selected', row.dataset.id === id));
  $('#drawerInner').innerHTML = `
    <header class="drawer-head">
      <div class="drawer-bar"><span class="subtle">Loading finding…</span>${rxCloseButton()}</div>
      <span class="skel skel-line" style="width:30%"></span><span class="skel skel-line" style="height:20px;width:75%"></span>
    </header>
    <div class="drawer-body"><div class="d-section">${skeletonLines(4)}</div><div class="d-section">${skeletonLines(6)}</div></div>`;
  $('#drawerClose').focus();
  try {
    const response = await api('/api/v1/findings/' + encodeURIComponent(id));
    if (rx.openId !== id) return;
    rx.detail = response;
    rxRenderDrawer(response);
  } catch (error) {
    if (rx.openId !== id) return;
    $('#drawerInner').innerHTML = `
      <header class="drawer-head"><div class="drawer-bar"><span></span>${rxCloseButton()}</div><h2 class="drawer-title" id="drawerTitle">Finding unavailable</h2></header>
      <div class="drawer-body"><div class="d-section">${emptyState({
        error: true,
        title: error.status === 404 ? 'This finding is not available in your access scope' : 'The finding could not be loaded',
        text: esc(error.status === 404 ? 'It may belong to an institution outside the current demo role, or the synthetic data may have been reset.' : error.message)
      })}</div></div>`;
    $('#drawerClose').focus();
  }
}

function rxCloseButton() {
  return `<button type="button" class="icon-btn" id="drawerClose" aria-label="Close finding details">${icon('x')}</button>`;
}

const RX_COMPARE_FIELDS = [
  ['student_name', 'Student name'],
  ['date_of_birth', 'Date of birth'],
  ['institution_code', 'Institution'],
  ['programme', 'Programme'],
  ['academic_session', 'Academic session'],
  ['enrolment_status', 'Enrolment status'],
  ['apaar_id', 'APAAR ID (masked)'],
  ['source_file', 'Source file'],
  ['source_row', 'Source row']
];

function rxCompare(key, values, rule) {
  if (key === 'source_file' || key === 'source_row') return null;
  if (key === 'apaar_id') {
    if (RULES[rule]?.exactId) return { kind: 'same', text: 'Exact match (protected comparison)' };
    if (values.every(v => v === 'Not provided')) return { kind: 'na', text: 'Not provided' };
    return { kind: 'na', text: 'Not compared by this rule' };
  }
  const normalised = values.map(v => String(v ?? '').trim().toLocaleLowerCase('en-IN'));
  if (normalised.some(v => !v)) return { kind: 'na', text: 'Missing in a record' };
  return new Set(normalised).size === 1 ? { kind: 'same', text: 'Same' } : { kind: 'diff', text: 'Differs' };
}

function rxCmpBadge(result) {
  if (!result) return '<span class="cmp na">—</span>';
  const iconName = { same: 'check', diff: 'x', na: 'minus-circle', flag: 'alert-triangle' }[result.kind];
  return `<span class="cmp ${result.kind}">${icon(iconName)}${esc(result.text)}</span>`;
}

function rxFlaggedField(f) {
  if (RULES[f.rule_code]?.field) return RULES[f.rule_code].field;
  if (f.rule_code === 'REQUIRED_FIELD_MISSING') return String(f.explanation || '').split(' ')[0];
  return null;
}

function rxEvidenceSection(f) {
  const records = f.records;
  const intro = '<p class="muted" style="font-size:13px;margin-bottom:12px">Values below come from the persisted source records. APAAR identifiers are always masked; identifier comparisons use a protected fingerprint, never the raw value.</p>';

  if (!records.length) {
    return `<section class="d-section"><h3>${icon('columns')}Source evidence</h3>${emptyState({ compact: true, title: 'No source records in your scope' })}</section>`;
  }

  /* Single-record findings: show values with the flagged field highlighted */
  if (records.length === 1) {
    const record = records[0];
    const flagged = rxFlaggedField(f);
    return `<section class="d-section"><h3>${icon('columns')}Source evidence</h3>${intro}
      <div class="compare-scroll"><table class="compare">
        <thead><tr><th scope="col">Field</th><th scope="col">${esc(record.institution_code)} · row ${record.source_row}</th><th scope="col">Check</th></tr></thead>
        <tbody>${RX_COMPARE_FIELDS.map(([key, label]) => {
          const value = record[key];
          const isFlagged = key === flagged;
          return `<tr><th scope="row">${esc(label)}</th>
            <td class="${isFlagged ? 'is-flagged' : ''}">${value === '' || value == null ? '<span class="subtle">Empty</span>' : esc(value)}</td>
            <td>${isFlagged ? rxCmpBadge({ kind: 'flag', text: 'Flagged by rule' }) : '<span class="cmp na">—</span>'}</td></tr>`;
        }).join('')}</tbody>
      </table></div></section>`;
  }

  /* Large cohorts (capacity): list the counted records */
  if (records.length > 4) {
    const capacity = f.capacity || state.summary?.capacity?.find(rule => rule.institution_code === records[0].institution_code && rule.programme === records[0].programme && rule.academic_session === records[0].academic_session);
    const shown = rx.showAllRecords ? records : records.slice(0, 10);
    return `<section class="d-section"><h3>${icon('columns')}Source evidence</h3>
      <dl class="d-grid" style="margin:0 0 14px">
        <div class="d-kv"><dt>Active records counted</dt><dd>${records.length}</dd></div>
        <div class="d-kv"><dt>Configured capacity</dt><dd>${capacity ? capacity.permitted_capacity : 'See explanation'}</dd></div>
        <div class="d-kv"><dt>Programme · session</dt><dd>${esc(records[0].programme)} · ${esc(records[0].academic_session)}${capacity?.seat_category ? ` · seat category ${esc(capacity.seat_category)}` : ''}</dd></div>
      </dl>
      <div class="compare-scroll"><table class="compare">
        <thead><tr><th scope="col">Row</th><th scope="col">Student</th><th scope="col">Status</th><th scope="col">APAAR (masked)</th><th scope="col">Source file</th></tr></thead>
        <tbody>${shown.map(r => `<tr><td class="num">${r.source_row}</td><td>${esc(r.student_name)}</td><td>${esc(r.enrolment_status)}</td><td class="mono">${esc(r.apaar_id)}</td><td>${esc(r.source_file)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${records.length > 10 ? `<button type="button" class="link-btn" style="margin-top:10px" data-toggle-records>${rx.showAllRecords ? 'Show first 10 records' : `Show all ${records.length} records`}</button>` : ''}
    </section>`;
  }

  /* 2–4 records: side-by-side comparison */
  const comparisons = RX_COMPARE_FIELDS.map(([key, label]) => ({ key, label, result: rxCompare(key, records.map(r => r[key]), f.rule_code) }));
  const matched = comparisons.filter(c => c.result?.kind === 'same');
  const differing = comparisons.filter(c => c.result?.kind === 'diff');
  return `<section class="d-section"><h3>${icon('columns')}Source evidence</h3>${intro}
    <div class="compare-scroll"><table class="compare">
      <thead><tr><th scope="col">Field</th>${records.map((r, i) => `<th scope="col">Record ${String.fromCharCode(65 + i)} · ${esc(r.institution_code)} row ${r.source_row}</th>`).join('')}<th scope="col">Comparison</th></tr></thead>
      <tbody>${comparisons.map(c => `<tr><th scope="row">${esc(c.label)}</th>
        ${records.map(r => `<td class="${c.result?.kind === 'diff' ? 'is-diff' : ''}${c.key === 'apaar_id' ? ' mono' : ''}">${r[c.key] === '' || r[c.key] == null ? '<span class="subtle">Empty</span>' : esc(r[c.key])}</td>`).join('')}
        <td>${rxCmpBadge(c.result)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="field-summary">
      <div><h4>Matching values</h4><div class="tag-list">${matched.length ? matched.map(c => `<span class="badge badge-plain tone-neutral">${esc(c.label)}</span>`).join('') : '<span class="subtle">None</span>'}</div></div>
      <div><h4>Differing values</h4><div class="tag-list">${differing.length ? differing.map(c => `<span class="badge badge-plain tone-danger">${esc(c.label)}</span>`).join('') : '<span class="subtle">None</span>'}</div></div>
    </div>
  </section>`;
}

function rxProvenanceSection(f) {
  if (!f.records.length) return '';
  const records = f.records.slice(0, 4);
  const transformations = Object.entries(f.records[0].transformations || {});
  return `<section class="d-section"><h3>${icon('file')}Source provenance</h3>
    <ul class="prov-list">${records.map(r => `
      <li><span><strong>${esc(r.source_file)}</strong> · row ${r.source_row}</span><span class="subtle">${esc(r.institution_code)}</span>
        <span class="subtle">Internal record <span class="mono">${esc(r.id)}</span> · original values retained alongside normalised values</span>
        ${r.superseded_by ? `<span class="badge badge-plain tone-neutral">${icon('history')}Superseded by a corrected version</span>` : r.lineage?.version > 1 ? `<span class="badge badge-plain tone-info">${icon('history')}Corrected version ${esc(r.lineage.version)}</span>` : ''}
        <a class="link-btn" href="${routeHash('profile', { record: r.id, tab: 'sources' })}">${icon('users', 'icon-xs')}Open student profile</a></li>`).join('')}
    </ul>
    ${f.records.length > 4 ? `<p class="subtle" style="font-size:12.5px">+${f.records.length - 4} more records from the same provenance.</p>` : ''}
    ${transformations.length ? `<p class="field-label" style="margin:12px 0 6px">Normalisation applied before matching</p>
      <dl class="d-grid" style="margin:0">${transformations.map(([field, rule]) => `<div class="d-kv"><dt>${esc(field.replaceAll('_', ' '))}</dt><dd>${esc(rule)}</dd></div>`).join('')}</dl>` : ''}
  </section>`;
}

function rxHistorySection(f, audit) {
  return `<section class="d-section"><h3>${icon('history')}Review history</h3>
    ${audit.length ? `<ol class="timeline">${[...audit].reverse().map(event => `
      <li class="tl-item">
        <span class="tl-icon ${isAwaitingAction(event.action) ? 'st-awaiting_verification' : 'st-resolved'}">${icon(isAwaitingAction(event.action) ? 'hourglass' : String(event.action).startsWith('match_') ? 'git-merge' : 'check')}</span>
        <div>
          <p class="tl-text"><strong>${esc(event.actor)}</strong> recorded <strong>${esc(outcomeLabel(event.action))}</strong></p>
          <p class="tl-meta"><time datetime="${esc(event.at)}">${esc(fmtDate(event.at))}</time></p>
          ${event.note ? `<p class="tl-note">${esc(event.note)}</p>` : ''}
          ${event.receipt_id && state.auth !== 'hosted_demo' ? `<button type="button" class="link-btn" data-receipt="${esc(event.receipt_id)}">${icon('shield', 'icon-xs')}View decision receipt</button>` : ''}
        </div>
      </li>`).join('')}</ol>`
      : '<p class="muted" style="font-size:13px">No decision has been recorded yet. Detected by the reconciliation engine on ' + esc(fmtDate(f.created_at)) + '.</p>'}
  </section>`;
}

function rxDecisionSection(f) {
  const resolved = f.review_status === 'resolved';
  const choices = resolved ? ['awaiting_verification'] : Object.keys(OUTCOMES);
  const lastDecision = f.decision;
  return `<form class="d-section" id="decisionForm" novalidate>
    <h3>${icon('check-circle')}Record a review decision</h3>
    ${resolved ? `<div class="callout info" style="margin-bottom:14px">${icon('info')}<div>Resolved${lastDecision ? ` as <strong>${esc(outcomeLabel(lastDecision.outcome))}</strong> by ${esc(lastDecision.reviewer)} on ${esc(fmtDate(lastDecision.at))}` : ''}. A resolved finding can only be reopened for further verification.</div></div>` : ''}
    <fieldset class="outcomes">
      <legend>Outcome</legend>
      ${choices.map(value => `
        <label class="outcome">
          <input type="radio" name="outcome" value="${value}"${choices.length === 1 ? ' checked' : ''}>
          <span><strong>${esc(resolved ? 'Reopen for further verification' : OUTCOMES[value].label)}</strong><span>${esc(OUTCOMES[value].desc)}</span></span>
        </label>`).join('')}
    </fieldset>
    <div class="field decision-note">
      <label class="field-label" for="decisionNote">User note <span class="req">Required</span></label>
      <textarea class="textarea" id="decisionNote" maxlength="1000" required aria-describedby="noteHelp noteCount" placeholder="What evidence did you review, and why does it support this outcome?"></textarea>
      <div class="note-meta"><span id="noteHelp">Stored permanently in the audit history with your account name.</span><span id="noteCount" aria-live="polite">0 / 1000</span></div>
    </div>
    <div class="decision-actions">
      <p class="inline-error" id="decisionError" role="alert" hidden></p>
      <button type="submit" class="btn btn-primary" id="decisionSubmit">${icon('check')}Record decision</button>
    </div>
  </form>`;
}

function rxLifecycleNotice(f) {
  if (isHistorical(f)) {
    const title = f.lifecycle_status === 'superseded' ? 'Historical finding — superseded' : 'Historical finding — condition no longer present';
    return `<div class="callout warning" role="note">${icon('history')}<div><strong>${title}</strong> on ${esc(fmtDate(f.lifecycle_changed_at))}. ${esc(f.lifecycle_reason || '')}
      ${f.superseded_by ? ` <a href="${rxFindingHref(f.superseded_by)}">Open the current finding</a>.` : ''} Its evidence and review history are preserved below for audit.</div></div>`;
  }
  if (f.supersedes?.length) {
    return `<div class="callout info" role="note">${icon('history')}<div>This finding replaces ${plural(f.supersedes.length, 'earlier finding')} for the same capacity condition: ${f.supersedes.map(id => `<a href="${rxFindingHref(id)}">#${esc(shortId(id))}</a>`).join(', ')}. Earlier decisions remain in their own review history.</div></div>`;
  }
  return '';
}

function rxHistoricalDecisionNote(f) {
  return `<section class="d-section"><h3>${icon('check-circle')}Review decisions</h3>
    <p class="muted" style="font-size:13px">Decisions cannot be recorded on a historical finding. ${f.superseded_by ? `Review the <a href="${rxFindingHref(f.superseded_by)}">current finding</a> instead.` : 'The underlying condition is no longer present.'}</p>
  </section>`;
}

/* ── Automated processing and model assistance ── */
const RX_LINK_METHODS = {
  protected_identifier_exact: 'Exact protected-identifier comparison',
  name_dob_similarity: 'Name-token similarity with date of birth'
};
const RX_LINK_OUTCOMES = {
  auto_linked: ['Linked automatically', 'tone-success'],
  needs_investigation: ['Conflicting attributes', 'tone-danger'],
  candidate_for_review: ['Candidate for review', 'st-awaiting_verification'],
  not_linked: ['Not linked', 'tone-neutral']
};
const RX_ID_CHECKS = { missing: 'Missing', locally_well_formed: 'Well-formed locally (not verified)', malformed: 'Malformed' };
const RX_FIELD_LABELS = { identifier: 'Identifier', student_name: 'Name', date_of_birth: 'Date of birth' };
const RX_OUTCOME_TONE = { automatically_processed: 'tone-success', automatically_normalised: 'tone-success', safely_matched: 'tone-info', needs_institution_correction: 'tone-warning', needs_investigation: 'tone-danger', verification_pending: 'st-awaiting_verification', processing_failed: 'tone-danger' };
const RX_MAX_SCORE = 15; /* identifier 8 + exact name 4 + date of birth 3, see src/identity.js */

function rxFieldTags(fields, tone) {
  return fields.length ? fields.map(key => `<span class="badge badge-plain ${tone}">${esc(RX_FIELD_LABELS[key] || key)}</span>`).join('') : '<span class="subtle">None</span>';
}

function rxProcessingSection(f) {
  const a = f.automation;
  const links = f.identity_links || [];
  if (!a && !links.length) return '';
  const records = f.records.filter(r => r.processing).slice(0, 4);
  return `<section class="d-section"><h3>${icon('sliders')}Automated processing</h3>
    ${a ? `<dl class="d-grid" style="margin-top:0">
      <div class="d-kv"><dt>Processing outcome</dt><dd><span class="badge badge-plain ${RX_OUTCOME_TONE[a.outcome] || 'tone-neutral'}">${esc(PROCESSING_LABELS[a.outcome] || a.outcome)}</span></dd></div>
      <div class="d-kv"><dt>Last evaluated</dt><dd>${esc(fmtDate(a.evaluated_at))}</dd></div>
    </dl>` : ''}
    ${links.length ? `<p class="field-label" style="margin:16px 0 6px">Identity-match evidence</p>
      <ul class="link-list">${links.slice(0, 3).map(l => {
        const [label, tone] = RX_LINK_OUTCOMES[l.outcome] || [l.outcome, 'tone-neutral'];
        return `<li>
          <div class="link-head"><span class="badge badge-plain ${tone}">${esc(label)}</span>
            <span class="subtle">${esc(RX_LINK_METHODS[l.method] || l.method)} · evidence score ${esc(l.score)} of ${RX_MAX_SCORE}${l.method === 'name_dob_similarity' ? ` · name similarity ${Math.round(l.name_similarity * 100)}%` : ''}</span></div>
          <div class="link-fields">
            <div><h4>Agree</h4><div class="tag-list">${rxFieldTags(l.agreeing_fields, 'tone-success')}</div></div>
            <div><h4>Conflict</h4><div class="tag-list">${rxFieldTags(l.conflicting_fields, 'tone-danger')}</div></div>
            <div><h4>Missing</h4><div class="tag-list">${rxFieldTags(l.missing_fields, 'tone-neutral')}</div></div>
          </div>
          <p class="link-reason">${esc(l.reason)}</p>
          <p class="subtle link-src">Records <span class="mono">${esc(l.records.join(', '))}</span>${l.policy_version ? ` · policy <code>${esc(l.policy_version)}</code>` : ''}</p>
          ${['candidate_for_review', 'needs_investigation'].includes(l.outcome) && l.records.every(id => f.records.some(r => r.id === id)) ? `<a class="btn btn-secondary btn-xs" href="${routeHash('matches', { match: l.id })}">${icon('columns', 'icon-xs')}Compare side by side</a>` : ''}
        </li>`;
      }).join('')}</ul>
      <p class="subtle" style="font-size:12px;margin-top:6px">The score is a fixed weighting of field agreement, not a probability. Automatic linking is decided by the policy, never by name similarity alone.</p>` : ''}
    ${records.length ? `<p class="field-label" style="margin:16px 0 6px">Record checks</p>
      <ul class="prov-list">${records.map(r => `<li>
        <span><strong>${esc(r.institution_code)}</strong> · ${esc(r.source_file)} row ${r.source_row}</span>
        <span class="badge badge-plain ${RX_OUTCOME_TONE[r.processing.status] || 'tone-neutral'}">${esc(PROCESSING_LABELS[r.processing.status] || r.processing.status)}</span>
        <span class="subtle">Identifier: ${esc(RX_ID_CHECKS[r.processing.identifier_check] || r.processing.identifier_check)} · authoritative verification not available${r.processing.normalisations?.length ? ` · ${esc(r.processing.normalisations.join('; '))}` : ''}</span>
      </li>`).join('')}</ul>` : ''}
  </section>`;
}

function rxAssistSection(f) {
  return `<section class="d-section" id="assistSection">
    <h3>${icon('flask')}Plain-language explanation</h3>
    <div id="assistBody">
      <p class="muted" style="font-size:13px">Generated by the configured model when one is available, otherwise taken from the rule text. Either way it is advisory and never changes this finding.</p>
      <button type="button" class="btn btn-secondary btn-sm" id="assistBtn" style="margin-top:10px">${icon('info', 'icon-sm')}Explain this finding</button>
    </div>
  </section>`;
}

async function rxRunAssist(f) {
  const body = $('#assistBody');
  const button = $('#assistBtn');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `${icon('rotate', 'icon-sm')}Preparing explanation…`;
  try {
    /* The read-only demo asks for the deterministic explanation, which never calls a model or stores anything. */
    const { data } = state.readOnly
      ? await api(`/api/v1/findings/${encodeURIComponent(f.id)}/explanation`)
      : await api(`/api/v1/findings/${encodeURIComponent(f.id)}/assist`, { method: 'POST' });
    if (rx.openId && rx.openId !== f.id) return;
    const e = data.explanation;
    const fromModel = e.source === 'model';
    const c = data.candidate_assessment;
    body.innerHTML = `
      <p class="assist-src ${fromModel ? 'is-model' : ''}">${fromModel
        ? `Generated by <code>${esc(e.provenance.model)}</code>${e.provenance.local ? ' (local model on this machine)' : ''} · ${esc(fmtDate(e.provenance.generated_at))} · advisory, not verification`
        : 'Rule text (deterministic).'} ${!fromModel && e.model_unavailable_reason ? `<span class="subtle">${esc(e.model_unavailable_reason)}</span>` : ''}
        ${e.replaced_stale ? '<span class="subtle">An earlier explanation was replaced because the finding\'s evidence, rule, prompt or model changed.</span>' : ''}
        ${e.stale_model_explanation_withheld ? '<span class="subtle">An earlier model explanation no longer matches the current evidence and is not shown.</span>' : ''}</p>
      <p class="d-lede">${esc(e.summary)}</p>
      ${e.what_it_indicates ? `<div class="interp" style="margin-top:10px">
        <div class="means"><h4>${icon('info', 'icon-xs')}What it indicates</h4>${esc(e.what_it_indicates)}</div>
        <div class="not"><h4>${icon('shield', 'icon-xs')}What it does not establish</h4>${esc(e.what_it_does_not_establish)}</div>
      </div>` : ''}
      ${e.suggested_next_step ? `<p style="margin-top:10px;font-size:13px"><strong>Next step:</strong> ${esc(e.suggested_next_step)}</p>` : ''}
      ${c ? `<div class="assist-candidate">${c.source === 'model'
        ? `<p><strong>Name assessment:</strong> ${esc(c.assessment.replaceAll('_', ' '))} (${esc(c.name_relationship.replaceAll('_', ' '))})</p><p>${esc(c.rationale)}</p><p class="subtle">${esc(c.effect)}</p>`
        : `<p class="subtle">Name assessment unavailable: ${esc(c.reason)}</p>`}</div>` : ''}
      ${!fromModel && e.model_unavailable_reason && data.ai.configured ? `<button type="button" class="btn btn-secondary btn-sm" id="assistBtn" style="margin-top:10px">${icon('rotate', 'icon-sm')}Try the model again</button>` : ''}
      <details class="assist-sent"><summary>What would be sent to a model</summary>
        <p>${esc(data.ai.data_policy)}</p>
        <div class="tag-list">${data.sent_fields.map(key => `<span class="badge badge-plain tone-neutral">${esc(key)}</span>`).join('')}</div>
      </details>`;
    // After a model failure the reviewer can retry; the deterministic text above stays meanwhile.
    $('#assistBtn', body)?.addEventListener('click', () => rxRunAssist(f));
  } catch (error) {
    if (!$('#assistBtn')) return;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = `${icon('info', 'icon-sm')}Explain this finding`;
    toast(error.message, { tone: 'error', title: 'Explanation unavailable' });
  }
}

/* The current assessment is recomputed by the server from the latest records and rules. The explanation
   stored on the finding is what was true when it was raised; it is shown as dated history, never as current. */
const RX_FACT = { records_sharing_identifier: 'Records sharing the identifier', automatically_linked_pairs: 'Pairs linked automatically', pairs_needing_investigation: 'Pairs needing investigation', active_institutions: 'Institutions with an active enrolment', pair_outcome: 'Pair outcome', competing_candidates: 'Competing candidates', missing_fields: 'Missing on the pair', observed_active: 'Active enrolments counted', permitted_capacity: 'Configured capacity' };
function rxAssessmentHtml(f) {
  const a = f.assessment;
  if (!a) return `<p class="field-label">As raised on ${esc(fmtDate(f.created_at))} (no current assessment available)</p><p>${esc(f.explanation)}</p>`;
  const tone = a.status !== 'current' ? 'tone-neutral' : a.condition_present === false ? 'st-awaiting_verification' : 'tone-success';
  const label = a.status !== 'current' ? 'Historical' : a.condition_present === false ? 'Condition no longer present' : 'Condition still present';
  const facts = a.facts.filter(x => RX_FACT[x.key]).map(x => `<div class="d-kv"><dt>${esc(RX_FACT[x.key])}</dt><dd>${esc(String(x.value).replaceAll('_', ' '))}</dd></div>`).join('');
  return `
    <p class="field-label" style="margin-bottom:4px">Current assessment <span class="badge badge-plain ${tone}">${esc(label)}</span></p>
    <p class="d-lede">${esc(a.summary)}</p>
    ${a.differences.length ? `<ul class="assess-diff">${a.differences.map(d => `<li>${icon('alert-triangle', 'icon-xs')}${esc(d)}</li>`).join('')}</ul>` : ''}
    ${facts ? `<dl class="d-grid" style="margin-top:8px">${facts}</dl>` : ''}
    <p class="subtle" style="font-size:12px;margin-top:6px">Assessed against policy ${esc(a.assessed.policy_version)}${a.assessed.rule_version ? ` and rule ${esc(a.assessed.rule_version)}` : ''} from the latest stored records${a.assessed.last_validated_at ? `; findings last revalidated ${esc(fmtDate(a.assessed.last_validated_at))}` : ''}.${a.successor ? ` Current finding: <a href="#/reconciliation?finding=${esc(a.successor)}&lifecycle=all">#${esc(shortId(a.successor))}</a>.` : ''}</p>
    <details class="assess-raised"${a.stale_original ? '' : ' open'}>
      <summary>As raised on ${esc(fmtDate(a.raised.created_at))}${a.stale_original ? ' — no longer current' : ''}</summary>
      <p>${esc(a.raised.explanation)}</p>
      <p class="subtle">Rule ${esc(a.raised.rule_version || '—')} · ${a.raised.evidence ? `${plural(a.raised.evidence.length, 'source record')} as evidence when raised` : esc(a.raised.evidence_note)}</p>
    </details>`;
}

function rxRenderDrawer({ data: f, audit }) {
  const index = rx.sorted.findIndex(item => item.id === f.id);
  const rule = RULES[f.rule_code] || {};
  const confidence = f.confidence === null || f.confidence === undefined
    ? 'Rule-based detection — no similarity score applies.'
    : f.rule_code === 'CANDIDATE_IDENTITY_MATCH'
      ? `${Math.round(f.confidence * 100)}% name-token similarity. This is a similarity measure, not a probability of identity or misconduct.`
      : 'Exact protected-identifier comparison (deterministic).';

  $('#drawerInner').innerHTML = `
    <header class="drawer-head">
      <div class="drawer-bar">
        <div class="drawer-nav">
          ${index >= 0 ? `
            <button type="button" class="icon-btn icon-btn-sm bordered" data-step="-1" aria-label="Previous finding in results" aria-keyshortcuts="K" title="Previous finding (K)" ${index === 0 ? 'disabled' : ''}>${icon('chevron-left', 'icon-sm')}</button>
            <button type="button" class="icon-btn icon-btn-sm bordered" data-step="1" aria-label="Next finding in results" aria-keyshortcuts="J" title="Next finding (J)" ${index === rx.sorted.length - 1 ? 'disabled' : ''}>${icon('chevron-right', 'icon-sm')}</button>
            <span>${index + 1} of ${rx.sorted.length} in results <span class="drawer-keys" aria-hidden="true"><kbd>J</kbd> <kbd>K</kbd></span></span>` : '<span>Not in the current result list</span>'}
        </div>
        ${rxCloseButton()}
      </div>
      <div class="drawer-badges">${sevBadge(f.severity)}${statusBadge(f.review_status)}${lifecycleBadge(f)}<span class="badge badge-plain tone-neutral">${esc(categoryLabel(f.category))}</span></div>
      <h2 class="drawer-title" id="drawerTitle">${esc(f.title)}</h2>
      <div class="drawer-meta">
        <span>Finding <button type="button" class="copy-btn" data-copy="${esc(f.id)}" title="Copy the full finding ID" aria-label="Copy finding ID ${esc(f.id)}">#${esc(shortId(f.id))}${icon('copy', 'icon-xs')}</button></span>
        <span>${esc(recordContext(f))}</span>
        <span>Detected ${esc(fmtDate(f.created_at))}</span>
      </div>
    </header>
    <div class="drawer-body">
      ${rxLifecycleNotice(f)}
      <section class="d-section">
        <h3>${icon('info')}Why this was flagged</h3>
        ${rxAssessmentHtml(f)}
        <dl class="d-grid">
          <div class="d-kv"><dt>Rule triggered</dt><dd>${esc(ruleLabel(f.rule_code))}<code>${esc(f.rule_code)} · ${esc(f.rule_version || '')}</code></dd></div>
          <div class="d-kv"><dt>What the rule checks</dt><dd>${esc(rule.checks || 'See explanation.')}</dd></div>
          <div class="d-kv"><dt>Match strength</dt><dd>${esc(confidence)}</dd></div>
        </dl>
      </section>

      <section class="d-section" aria-label="Interpretation">
        <h3>${icon('scale')}Interpretation</h3>
        <div class="interp">
          <div class="means"><h4>${icon('info', 'icon-xs')}What this indicates</h4>${esc(rule.means || f.assessment?.summary || f.explanation)}</div>
          <div class="not"><h4>${icon('shield', 'icon-xs')}What it does not establish</h4>${esc(rule.notMeans || 'A finding supports human review; it is not proof of misconduct.')}</div>
        </div>
      </section>

      ${rxAssistSection(f)}
      ${rxEvidenceSection(f)}
      ${rxProcessingSection(f)}

      <section class="d-section">
        <h3>${icon('arrow-right')}${f.automation?.required_action ? 'Required action' : 'Recommended next action'}</h3>
        <p class="d-lede">${esc(f.automation?.required_action || f.recommended_action)}</p>
        ${f.automation?.required_action && f.automation.outcome !== 'safely_matched' && f.recommended_action && f.recommended_action !== f.automation.required_action ? `<p class="subtle" style="font-size:12.5px;margin-top:6px">Rule guidance: ${esc(f.recommended_action)}</p>` : ''}
      </section>

      ${isHistorical(f) ? '' : `<section class="d-section lab-entry">
        <h3>${icon('flask')}Evidence Impact Lab</h3>
        <p class="muted" style="font-size:13px">Stage a source-backed correction to one of these records and see what the real rules and identity policy would do, on an isolated copy. Nothing is saved and nothing here is a decision.</p>
        <button type="button" class="btn btn-secondary btn-sm" data-lab-finding="${esc(f.id)}">${icon('flask', 'icon-sm')}Explore impact</button>
      </section>`}
      ${rxProvenanceSection(f)}
      ${rxHistorySection(f, audit)}
      ${isHistorical(f) ? rxHistoricalDecisionNote(f) : rxDecisionSection(f)}
    </div>`;

  $('#drawerInner .drawer-body').scrollTop = 0;
  $('#assistBtn')?.addEventListener('click', () => rxRunAssist(f));
  if (!isHistorical(f)) rxBindDecisionForm(f);
  /* Re-rendering removed the focused control; keep focus inside the dialog. */
  if (!$('#findingDrawer').contains(document.activeElement)) $('#drawerClose').focus();
}

function rxBindDecisionForm(f) {
  const form = $('#decisionForm');
  const note = $('#decisionNote');
  const error = $('#decisionError');
  const showError = message => { error.innerHTML = `${icon('alert-octagon', 'icon-sm')}<span>${esc(message)}</span>`; error.hidden = false; };

  note.addEventListener('input', () => {
    $('#noteCount').textContent = `${note.value.length} / 1000`;
    if (note.value.trim()) { note.removeAttribute('aria-invalid'); error.hidden = true; }
  });
  form.addEventListener('change', () => { if (form.outcome.value) error.hidden = true; });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const outcome = form.outcome.value;
    if (!outcome) { showError('Choose an outcome before recording the decision.'); $('input[name="outcome"]', form).focus(); return; }
    if (!note.value.trim()) {
      note.setAttribute('aria-invalid', 'true');
      showError('Add a note. Every decision needs a reason in the audit history.');
      note.focus();
      return;
    }
    const meta = OUTCOMES[outcome];
    if (meta.confirm) {
      const ok = await confirmDialog({
        title: outcome === 'dismissed' ? 'Dismiss this finding?' : 'Confirm this discrepancy?',
        body: `<p>This resolves <strong>${esc(f.title)}</strong> as <strong>${esc(meta.past)}</strong> and appends your note to the audit history.</p><p>Resolved findings can later be reopened only for further verification.</p>`,
        confirmLabel: meta.label
      });
      if (!ok) return;
    }

    const submit = $('#decisionSubmit');
    submit.classList.add('is-busy');
    submit.disabled = true;
    try {
      await api(`/api/v1/findings/${encodeURIComponent(f.id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ outcome, note: note.value.trim() })
      });
      toast('The finding, review counts and audit history have been updated.', { tone: 'success', title: `Decision recorded: ${meta.past}` });
      await Promise.all([rxLoad({ keepPage: true }), refreshPrincipal()]);
      if (rx.openId === f.id) await rxOpenFinding(f.id);
    } catch (err) {
      showError(err.message);
      toast(err.message, { tone: 'error', title: 'Decision not saved' });
      submit.classList.remove('is-busy');
      submit.disabled = false;
    }
  });
}

/* ── Event Bindings ───────────────────────────── */
$('#rxSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  rxApply(rxReadInputs());
});
$('#rxQuery').addEventListener('input', () => { $('#rxClearQuery').hidden = !$('#rxQuery').value; });
$('#rxClearQuery').addEventListener('click', () => {
  $('#rxQuery').value = '';
  rxApply(rxReadInputs());
  $('#rxQuery').focus();
});
$$('#rxFilters select').forEach(select => select.addEventListener('change', () => rxApply(rxReadInputs())));
$('#rxClearAll').addEventListener('click', rxClearAll);
$('#rxSummary').addEventListener('click', event => {
  const button = event.target.closest('[data-lifecycle]');
  if (button) rxApply({ ...rx.filters, lifecycle: button.dataset.lifecycle });
});
$('#rxChips').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (!button) return;
  rxApply({ ...rx.filters, [button.dataset.remove]: '' });
  ($('#rxChips [data-remove]') || $('#rxQuery')).focus();
});
$('#rxFilterToggle').addEventListener('click', event => {
  if (mobileQuery.matches) { rxOpenSheet(); return; }
  const panel = $('#rxFilters');
  const open = !panel.classList.contains('is-open');
  panel.classList.toggle('is-open', open);
  event.currentTarget.setAttribute('aria-expanded', String(open));
});
const rxSheet = $('#rxFilterSheet');
rxSheet.addEventListener('close', () => {
  rxRestoreFilters();
  $('#rxFilterToggle').setAttribute('aria-expanded', 'false');
  $('#rxFilterToggle').focus();
});
rxSheet.addEventListener('click', event => {
  if (event.target.closest('#rxSheetClose, #rxSheetDone') || event.target === rxSheet) rxSheet.close();
  if (event.target.closest('#rxSheetClear')) rxApply({ ...Object.fromEntries(activeRxParams().map(key => [key, ''])), q: rx.filters.q });
});
mobileQuery.addEventListener('change', () => { if (!mobileQuery.matches && rxSheet.open) rxSheet.close(); });

$('#rxExport').addEventListener('click', event => downloadFindings(rx.filters, event.currentTarget));

$('#rxTable thead').addEventListener('click', event => {
  const th = event.target.closest('th[data-sort]');
  if (!th || !rx.response) return;
  const key = th.dataset.sort;
  rx.sort = rx.sort.key === key
    ? { key, dir: rx.sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: key === 'severity' ? 'desc' : 'asc' };
  rx.page = 1;
  rxRenderRows();
  $('.sort-btn', th).focus();
});

$('#rxRows').addEventListener('click', event => {
  if (event.target.closest('a, button')) return;
  const row = event.target.closest('tr[data-id]');
  if (row) location.hash = rxFindingHref(row.dataset.id);
});

$('#rxPager').addEventListener('click', event => {
  const button = event.target.closest('[data-page]');
  if (!button) return;
  rx.page += Number(button.dataset.page);
  rxRenderRows();
  $('#rxTable').scrollIntoView({ block: 'start', behavior: 'smooth' });
});

const findingDrawer = $('#findingDrawer');
findingDrawer.addEventListener('click', event => {
  if (event.target.closest('#drawerClose')) { findingDrawer.close(); return; }
  const step = event.target.closest('[data-step]');
  if (step) {
    const index = rx.sorted.findIndex(item => item.id === rx.openId) + Number(step.dataset.step);
    const next = rx.sorted[index];
    if (next) {
      replaceRoute('reconciliation', { ...rx.filters, finding: next.id });
      rxOpenFinding(next.id);
    }
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) { copyText(copy.dataset.copy, 'Finding ID', copy); return; }
  if (event.target.closest('[data-toggle-records]')) {
    rx.showAllRecords = !rx.showAllRecords;
    if (rx.detail) rxRenderDrawer(rx.detail);
    return;
  }
  /* Click on the backdrop (outside the drawer panel) closes it */
  if (event.target === findingDrawer) {
    const rect = findingDrawer.getBoundingClientRect();
    if (event.clientX < rect.left) findingDrawer.close();
  }
});

/* J / K step through the result list while reading evidence (not while typing a note). */
findingDrawer.addEventListener('keydown', event => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, textarea, select')) return;
  const key = event.key.toLowerCase();
  if (key !== 'j' && key !== 'k') return;
  const button = $(`#drawerInner [data-step="${key === 'j' ? 1 : -1}"]`);
  if (!button || button.disabled) return;
  event.preventDefault();
  button.click();
});

findingDrawer.addEventListener('close', () => {
  const closedId = rx.openId;
  rx.openId = null;
  rx.detail = null;
  $$('#rxRows tr.is-selected').forEach(row => row.classList.remove('is-selected'));
  if (parseRoute().view === 'reconciliation') replaceRoute('reconciliation', rx.filters);
  const rowLink = closedId && $(`#rxRows tr[data-id="${CSS.escape(closedId)}"] [data-finding-link]`);
  /* The reviewed row may have left the filtered list after a decision; fall back
     to the first result, then the search field, so focus never drops to the page. */
  const target = rowLink || (rx.returnFocus?.isConnected ? rx.returnFocus : null)
    || (parseRoute().view === 'reconciliation' ? $('#rxRows [data-finding-link]') || $('#rxQuery') : null);
  target?.focus();
});
