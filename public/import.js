/* EduTrace AI — Import Wizard
   SIH 26263 · Select source → map columns → preview & validate → confirm → summary.
   Every count shown before import comes from the server's dry run; the summary
   shows the server's committed batch exactly as returned.
   ──────────────────────────────────────────────── */
'use strict';

const IMP_STEPS = ['Select source', 'Map columns', 'Preview & validate', 'Confirm import', 'Import summary'];
const IMP_MAX_BYTES = 2 * 1024 * 1024;

const IMP_FIELD_HELP = {
  apaar_id: 'Optional. Missing or malformed values are imported and raised as validation findings.',
  student_name: 'Full name as recorded by the institution.',
  date_of_birth: 'Used for conservative candidate matching. DD/MM/YYYY or YYYY-MM-DD.',
  institution_code: 'Short code such as NITM. Decides which institution each row belongs to.',
  institution_name: 'Descriptive name, stored for provenance only.',
  programme: 'Programme or course, e.g. BTECH CSE.',
  academic_session: 'Academic session, e.g. 2026-27.',
  admission_year: 'Year of admission, stored for provenance.',
  enrolment_status: 'Active, transferred, completed or withdrawn. “Enrolled” maps to active.',
  seat_category: 'Admission or seat category, stored for provenance.'
};

const IMP_ISSUES = {
  APAAR_MISSING: { tone: 'warn', text: 'APAAR ID missing — imports with a validation finding.' },
  APAAR_MALFORMED: { tone: 'warn', text: 'APAAR ID format needs correction — imports with a validation finding.' }
};

const imp = {
  step: 1,
  file: null,
  csv: null,
  preview: null,
  mapping: {},
  suggested: {},
  suggestedBy: {},
  assist: null,
  result: null,
  error: null,
  retry: null,
  loading: false,
  submitting: false,
  token: 0,
  role: null,
  institutions: [],
  institution: 'NITM',
  idempotencyKey: null,
  multi: false
};

/* ── Route Integration ────────────────────────── */
registerView('import', {
  enter() {
    if ((imp.role && imp.role !== state.role) || (state.runtime?.mode === 'synthetic-test' && imp.institution !== state.institution)) impReset();
    imp.role = state.role;
    if (state.role === 'institution') { imp.institution = state.runtime?.mode === 'synthetic-test' ? state.institution : 'NITM'; imp.multi = false; }
    impRender();
    impLoadHistory();
    impLoadCorrections();
  }
});

/* Possible corrections: a later row that may replace an earlier version of the same source record.
   Confirming supersedes the earlier version (kept for audit) and re-runs reconciliation; it never
   links two students. Only rows the server classed as uncertain appear here. */
const IMP_CHANGE = { filled: 'added', replaced: 'changed', removed: 'removed' };
async function impLoadCorrections() {
  const card = $('#impCorrectionsCard');
  let list;
  try { list = (await api('/api/v1/corrections')).data; } catch { card.hidden = true; return; }
  card.hidden = !list.length;
  $('#impCorrectionsCount').textContent = list.length ? `${list.length} pending` : '';
  $('#impCorrections').innerHTML = `<ul class="corr-list">${list.map(c => `
    <li class="corr-item" data-corr="${esc(c.id)}">
      <p class="corr-where"><strong>${esc(c.institution_code)}</strong> ${esc(c.earlier_record.source_file)} row ${esc(c.earlier_record.source_row)} <span aria-hidden="true">→</span><span class="sr-only"> may be replaced by </span> ${esc(c.later_record.source_file)} row ${esc(c.later_record.source_row)}</p>
      <ul class="corr-changes">${c.changes.map(ch => `<li><strong>${esc(ch.label)}</strong> ${esc(IMP_CHANGE[ch.kind] || ch.kind)}${ch.kind !== 'filled' ? `: <span class="mono">${esc(ch.from ?? '—')}</span> → <span class="mono">${esc(ch.to ?? '—')}</span>` : ''}</li>`).join('')}</ul>
      <p class="corr-why">${esc(c.reasons.join(' '))}</p>
      <label class="field-label" for="corrNote-${esc(c.id)}">Decision note <span class="req">Required</span></label>
      <textarea class="textarea corr-note" id="corrNote-${esc(c.id)}" rows="2" maxlength="1000"></textarea>
      <p class="field-error" hidden></p>
      <div class="corr-actions">
        <button type="button" class="btn btn-secondary btn-xs" data-corr-decision="reject">Keep both</button>
        <button type="button" class="btn btn-primary btn-xs" data-corr-decision="confirm">Confirm correction</button>
        <a class="link-btn" href="${routeHash('profile', { record: c.later_record.record_id, tab: 'sources' })}">Open record</a>
      </div>
    </li>`).join('')}</ul>`;
  $$('[data-corr-decision]', $('#impCorrections')).forEach(button => button.addEventListener('click', impDecideCorrection));
}

async function impDecideCorrection(event) {
  const button = event.currentTarget;
  const item = button.closest('[data-corr]');
  const decision = button.dataset.corrDecision;
  const note = $('.corr-note', item).value.trim();
  const error = $('.field-error', item);
  if (!note) { error.textContent = 'Add a note explaining why.'; error.hidden = false; $('.corr-note', item).setAttribute('aria-invalid', 'true'); $('.corr-note', item).focus(); return; }
  if (decision === 'confirm' && !(await confirmDialog({ title: 'Confirm this correction?', body: '<p>The later row becomes the current version. The earlier row is kept unchanged for audit but no longer used for reconciliation, identity matching or capacity.</p><p>This does not link or merge students; identity matching is re-evaluated under the normal policy.</p>', confirmLabel: 'Confirm correction' }))) return;
  button.disabled = true; button.dataset.state = 'busy';
  try {
    const result = (await api(`/api/v1/corrections/${encodeURIComponent(item.dataset.corr)}/decision`, { method: 'POST', body: JSON.stringify({ decision, note, ...(decision === 'confirm' ? { confirm: true } : {}) }) })).data;
    toast(decision === 'confirm' ? `Correction confirmed. ${plural(result.findings_resolved_by_correction, 'finding')} resolved by it; reconciliation was re-run.` : 'Both rows kept as separate records.', { tone: 'success', title: 'Decision recorded' });
    await impLoadCorrections();
    $('#h-imp-corrections')?.focus();
    refreshPrincipal();
  } catch (err) {
    button.disabled = false; delete button.dataset.state;
    error.textContent = err.message; error.hidden = false;
  }
}

function impReset() {
  imp.token++;
  Object.assign(imp, { step: 1, file: null, csv: null, preview: null, mapping: {}, suggested: {}, suggestedBy: {}, assist: null, result: null, error: null, retry: null, loading: false, submitting: false, multi: false, idempotencyKey: null });
  if (state.role === 'institution') imp.institution = state.runtime?.mode === 'synthetic-test' ? state.institution : 'NITM';
}

async function impLoadHistory() {
  const el = $('#impHistory');
  el.innerHTML = skeletonLines(4);
  try {
    const response = await api('/api/v1/imports');
    imp.institutions = response.institutions;
    if (!imp.institutions.some(i => i.code === imp.institution)) imp.institution = imp.institutions[0]?.code || 'NITM';
    renderImportList(el, { status: 'fulfilled', value: response }, 4);
    if (imp.step === 1 && !imp.submitting) impRender();
  } catch (error) {
    renderImportList(el, { status: 'rejected', reason: error }, 4);
  }
}

/* ── Derived State ────────────────────────────── */
function impMissingRequired() {
  return imp.preview ? imp.preview.unmapped_required_fields : [];
}

function impMaxStep() {
  if (imp.result) return 5;
  if (!imp.preview) return 1;
  if (impMissingRequired().length) return 2;
  return 4;
}

function impImportable() {
  const dry = imp.preview?.dry_run;
  return dry ? dry.ready + dry.with_warnings : 0;
}

function impFieldLabel(key) {
  return imp.preview?.fields.find(field => field.key === key)?.label || key.replaceAll('_', ' ');
}

/* ── Rendering ────────────────────────────────── */
function impRender() {
  const focusedId = document.activeElement?.id;
  impRenderStepper();
  const panel = $('#impPanel');
  panel.innerHTML = [impStep1, impStep2, impStep3, impStep4, impStep5][imp.step - 1]();
  if (focusedId && $(`#${CSS.escape(focusedId)}`)) $(`#${CSS.escape(focusedId)}`).focus();
}

function impRenderStepper() {
  const max = impMaxStep();
  $('#impStepper').innerHTML = IMP_STEPS.map((label, index) => {
    const step = index + 1;
    const current = step === imp.step;
    const done = step < imp.step || (imp.result && step < 5);
    const locked = step > max || (imp.result && step < 5);
    return `<li><button type="button" class="step-btn${done ? ' is-done' : ''}" data-goto="${step}" ${current ? 'aria-current="step"' : ''} ${locked && !current ? 'disabled' : ''}
      aria-label="${esc(`Step ${step} of 5: ${label}${done ? ', completed' : ''}${current ? ', current step' : ''}`)}">
      <span class="step-num">${done ? icon('check') : step}</span><span class="step-text">${esc(label)}</span>
    </button></li>`;
  }).join('');
}

function impHead(title, sub) {
  return `<div class="card-head"><div><h2 class="card-title" id="impStepTitle" tabindex="-1">${esc(title)}</h2><p class="card-sub">${sub}</p></div></div>`;
}

function impErrorCallout() {
  if (!imp.error) return '';
  const title = imp.retry === 'confirm' ? 'The import was not completed' : imp.retry === 'preview' ? 'The file could not be checked' : 'This file cannot be used';
  const actions = [
    imp.retry && imp.retryable ? `<button type="button" class="btn btn-secondary btn-xs" data-retry>${icon('rotate', 'icon-xs')}Try again</button>` : '',
    imp.retry === 'confirm' ? '' : `<label class="btn btn-ghost btn-xs" for="impFileRetry">${icon('upload', 'icon-xs')}Choose another file<input type="file" id="impFileRetry" accept=".csv,text/csv" class="sr-only"></label>`
  ].join('');
  return `<div class="callout danger imp-error" role="alert">${icon('alert-octagon')}<div><strong>${title}</strong><p>${esc(imp.error)}</p>
    ${imp.retry === 'confirm' && imp.retryable ? '<p class="imp-error-note">The server did not confirm the batch. Check Audit history before retrying if you are unsure whether it was saved.</p>' : ''}
    <div class="imp-error-actions">${actions}</div></div></div>`;
}

/* Honest processing state: an indeterminate bar while a real request is in
   flight. The server does not report partial progress, so no percentage is shown. */
function impProcessing(title, detail) {
  return `<div class="proc" role="status" aria-live="polite">
    <span class="proc-bar" role="progressbar" aria-label="${esc(title)}" aria-valuetext="In progress"><span></span></span>
    <div class="proc-text"><strong>${esc(title)}</strong><span>${esc(detail)}</span></div>
  </div>`;
}

/* Step 1 — Select source */
function impStep1() {
  const regulator = state.role === 'regulator';
  const options = (imp.institutions.length ? imp.institutions : [{ code: imp.institution, name: '' }])
    .map(i => `<option value="${esc(i.code)}" ${i.code === imp.institution ? 'selected' : ''}>${esc(i.code)}${i.name ? ` · ${esc(i.name)}` : ''}</option>`).join('');
  const sizeKb = imp.file ? (imp.file.size / 1024).toFixed(1) : 0;
  /* Read-only demo: no file input at all, so nothing is uploaded. The server rejects imports regardless. */
  if (state.readOnly) return `${impHead('Select source', 'Imports are turned off in the read-only demo.')}
    <div class="card-body">
      <div class="callout info">${icon('shield')}<div><strong>Uploads are disabled in this demo.</strong> The server rejects every import request, so no file is sent or stored here. The import history and possible corrections on this page come from the synthetic dataset, which went through the same import pipeline.</div></div>
    </div>`;

  const source = imp.file ? `
    <div class="file-card">
      <span class="dz-icon">${icon('file')}</span>
      <div style="min-width:0">
        <div class="file-name" title="${esc(imp.file.name)}">${esc(imp.file.name)}</div>
        <div class="file-meta">${sizeKb} KB · CSV${imp.preview && !imp.loading ? ` · ${plural(imp.preview.total_rows, 'data row')} · ${plural(imp.preview.headers.length, 'column')}` : ''}</div>
        ${imp.preview && !imp.loading ? `<div class="file-status ok">${icon('check-circle', 'icon-xs')}Checked by the server · ${plural(impImportable(), 'row')} importable with the current settings</div>` : ''}
        ${!imp.preview && !imp.loading && imp.error ? `<div class="file-status bad">${icon('alert-octagon', 'icon-xs')}Not usable yet — see the message above</div>` : ''}
      </div>
      <div class="file-actions">
        <label class="btn btn-secondary btn-sm" for="impFileReplace">${icon('upload')}Replace<input type="file" id="impFileReplace" accept=".csv,text/csv" class="sr-only"></label>
        <button type="button" class="btn btn-ghost btn-sm" id="impRemove">${icon('trash')}Remove</button>
      </div>
    </div>` : `
    <label class="dropzone" id="impDrop" for="impFile">
      <input type="file" id="impFile" accept=".csv,text/csv">
      <span class="dz-icon">${icon('file-up', 'icon-lg')}</span>
      <span class="dz-title">Drag a CSV file here, or <u>browse files</u></span>
      <span class="dz-help">The first row must contain column headers. One file creates one import batch.</span>
      <span class="dz-specs">
        <span class="badge badge-plain tone-neutral">CSV only</span>
        <span class="badge badge-plain tone-neutral">Up to 2 MB</span>
        <span class="badge badge-plain tone-neutral">Up to 5,000 rows</span>
        <span class="badge badge-plain tone-neutral">XLSX not supported in this build</span>
      </span>
    </label>`;

  if (state.runtime?.mode === 'synthetic-test') return `${impHead('Select synthetic source', 'Upload a synthetic CSV for the selected test institution.')}
    <div class="card-body">
      <div class="callout info">${icon('flask')}<div><strong>Ephemeral synthetic test data only.</strong> Use filenames beginning with “synthetic-”, names like “Synthetic Student TEST-001”, the selected institution’s fixed synthetic name and code, and synthetic programme/session markers. For a valid identifier-format check, use a 12-digit synthetic ID in the reserved 99999999xxxx range; “SYNTH-ID-…” values are also accepted for malformed-ID testing. Remove any non-empty unmapped columns. This in-memory dataset is discarded when the server restarts.</div></div>
      ${source}
      ${imp.loading ? impProcessing('Checking the file on the server…', 'Parsing the CSV and running a dry-run row check. Nothing is saved.') : ''}
      ${impErrorCallout()}
    </div>
    <div class="imp-actions"><span class="subtle" style="font-size:12.5px">Step 1 of 5</span><span class="spacer"></span><button type="button" class="btn btn-primary" data-goto="2" ${!imp.preview || imp.loading ? 'disabled' : ''}>Continue to column mapping${icon('arrow-right')}</button></div>`;

  return `${impHead('Select source', 'Choose the CSV file and the institution it belongs to. Nothing is saved until you confirm the import.')}
    <div class="card-body">
      ${impErrorCallout()}
      ${source}
      ${imp.loading ? impProcessing('Checking the file on the server…', 'Parsing the CSV, suggesting column mappings and running a dry-run row check. Nothing is saved.') : ''}
      <div class="source-grid">
        <div class="field">
          <label class="field-label" for="impInstitution">Source institution</label>
          <select class="select" id="impInstitution" ${!regulator || imp.multi ? 'disabled' : ''}>${options}</select>
          <span class="field-help">${regulator
            ? (imp.multi ? 'Not used in multi-institution mode — each row’s own institution code decides.' : 'Rows with a different institution code are skipped and listed.')
            : 'Institution users can import only their own institution’s records.'}</span>
        </div>
        ${regulator ? `
          <label class="check" for="impMulti">
            <input type="checkbox" id="impMulti" ${imp.multi ? 'checked' : ''}>
            <span><strong>Regulator-only: import rows from multiple known institutions</strong>
            <span>Each row is kept only if its institution code is a known institution (NITM, RCA or SVU). Unknown codes are skipped and listed.</span></span>
          </label>` : `
          <div class="callout info">${icon('building')}<div>You are using the <strong>NITM institution</strong> demo role. The server rejects attempts to import another institution’s records.</div></div>`}
      </div>
    </div>
    <div class="imp-actions">
      <span class="subtle" style="font-size:12.5px">Step 1 of 5</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" data-goto="2" ${imp.preview && !imp.loading ? '' : 'disabled'}>Continue to column mapping${icon('arrow-right')}</button>
    </div>`;
}

/* Step 2 — Map columns */
const IMP_SUGGESTION_SOURCE = {
  alias: 'Matched a known header name for this field.',
  header_similarity: 'Header text is similar to this field name. Check the sample value.',
  model: 'Suggested by the configured model from header names and value shapes. Advisory; check it.'
};

function impStep2() {
  const data = imp.preview;
  const missing = impMissingRequired();
  const required = data.fields.filter(field => field.required);
  const optional = data.fields.filter(field => !field.required);
  const requiredMapped = required.filter(field => imp.mapping[field.key]).length;
  const used = Object.values(imp.mapping);
  const unused = data.headers.filter(header => !used.includes(header));

  const row = field => {
    const value = imp.mapping[field.key] || '';
    const isMissing = field.required && !value;
    const duplicates = value ? Object.entries(imp.mapping).filter(([key, header]) => key !== field.key && header === value).map(([key]) => impFieldLabel(key)) : [];
    const suggested = value && imp.suggested[field.key] === value;
    const sample = value ? data.header_samples?.[value] : '';
    const hint = isMissing
      ? `<p class="map-hint err">Required — choose the column that holds the ${esc(field.label.toLowerCase())}.</p>`
      : duplicates.length
        ? `<p class="map-hint warn">Also mapped to ${esc(duplicates.join(', '))}. Check this is intentional — one column will fill both fields.</p>`
        : value
          ? `<p class="map-hint">${sample ? `First value: “${esc(sample)}”` : 'Column is empty in every row'}</p>`
          : '<p class="map-hint">Not imported</p>';
    return `<div class="map-row${isMissing ? ' is-missing' : ''}">
      <div class="map-field">
        <span class="map-state ${value ? 'ok' : isMissing ? 'bad' : ''}" aria-hidden="true">${icon(value ? 'check' : isMissing ? 'x' : 'minus-circle')}</span>
        <div>
          <div class="map-name">${esc(field.label)} ${field.required ? '<span class="req">Required</span>' : '<span class="opt">Optional</span>'}${suggested ? ` <span class="auto${imp.suggestedBy[field.key] === 'model' ? ' is-model' : ''}" title="${esc(IMP_SUGGESTION_SOURCE[imp.suggestedBy[field.key]] || IMP_SUGGESTION_SOURCE.alias)}">${imp.suggestedBy[field.key] === 'model' ? 'Suggested by model' : imp.suggestedBy[field.key] === 'header_similarity' ? 'Suggested · similar header' : 'Suggested'}</span>` : ''}</div>
          <p class="map-desc">${esc(IMP_FIELD_HELP[field.key] || '')}</p>
        </div>
      </div>
      <div class="map-control">
        <label class="sr-only" for="map-${field.key}">Source column for ${esc(field.label)}</label>
        <select class="select${value ? ' is-set' : ''}" id="map-${field.key}" data-map="${field.key}" ${isMissing ? 'aria-invalid="true"' : ''} aria-describedby="maphint-${field.key}">
          <option value="">Do not map</option>
          ${data.headers.map(header => `<option value="${esc(header)}" ${header === value ? 'selected' : ''}>${esc(header)}</option>`).join('')}
        </select>
        <div id="maphint-${field.key}">${hint}</div>
      </div>
    </div>`;
  };

  const assist = imp.assist;
  const modelFields = Object.values(imp.suggestedBy).filter(source => source === 'model').length;
  const assistNote = !assist ? '' : assist.used && modelFields
    ? `${icon('flask', 'icon-xs')}<span><strong>${plural(modelFields, 'suggestion')} from ${esc(assist.model || 'the configured model')}</strong> (advisory). Only header names and value shapes were sent — no cell values.</span>`
    : `${icon('info', 'icon-xs')}<span>Suggestions use known header names and header-text similarity only. ${assist.available ? 'Model assistance was not needed for this file.' : 'Model assistance is not configured.'}</span>`;

  return `${impHead('Map columns', `Match each EduTrace field to a column in <strong>${esc(imp.file.name)}</strong>. Suggestions come from common header names — check them before continuing.`)}
    <div class="card-body">
      ${impErrorCallout()}
      <div class="map-summary" role="status" aria-live="polite">
        <span><strong>${requiredMapped} of ${required.length}</strong> required fields mapped</span>
        <span class="map-progress" aria-hidden="true"><div style="width:${requiredMapped / required.length * 100}%"></div></span>
        <span>${plural(used.length, 'field')} mapped in total</span>
      </div>
      ${assistNote ? `<p class="map-assist">${assistNote}</p>` : ''}
      ${imp.loading ? impProcessing('Re-checking rows with the new mapping…', 'Sample values and row outcomes update when the server responds.') : ''}
      ${missing.length ? `<div class="callout danger" style="margin-bottom:16px">${icon('alert-octagon')}<div>Map the required ${missing.length === 1 ? 'field' : 'fields'} before continuing: <strong>${esc(missing.map(impFieldLabel).join(', '))}</strong>.</div></div>` : ''}
      <div class="map-groups${imp.loading ? ' is-stale' : ''}"${imp.loading ? ' aria-busy="true"' : ''}>
      <div class="map-group">
        <div class="map-group-title"><span>Required fields</span><span>${requiredMapped}/${required.length}</span></div>
        ${required.map(row).join('')}
      </div>
      <div class="map-group">
        <div class="map-group-title"><span>Optional fields</span><span>${optional.filter(field => imp.mapping[field.key]).length}/${optional.length}</span></div>
        ${optional.map(row).join('')}
      </div>
      </div>
      ${unused.length ? `<p class="field-help" style="margin-top:16px">Columns not imported: ${unused.map(header => `<span class="badge badge-plain tone-neutral">${esc(header)}</span>`).join(' ')}</p>` : ''}
    </div>
    <div class="imp-actions">
      <button type="button" class="btn btn-secondary" data-goto="1">${icon('arrow-left')}Back</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" data-goto="3" ${missing.length || imp.loading ? 'disabled' : ''}>Continue to preview${icon('arrow-right')}</button>
    </div>`;
}

function impOutcomeBadge(outcome) {
  if (!outcome) return '<span class="subtle">—</span>';
  if (outcome.outcome === 'skipped') return `<span class="badge tone-neutral">${icon('minus-circle')}Skipped</span>`;
  if (outcome.outcome === 'rejected') return `<span class="badge tone-danger">${icon('x')}Rejected</span>`;
  if (outcome.validation_issues?.length) return `<span class="badge tone-warning">${icon('alert-triangle')}Import + finding</span>`;
  return `<span class="badge tone-info">${icon('check')}Ready</span>`;
}

function impOutcomeMessages(outcome) {
  if (!outcome) return '';
  if (outcome.outcome === 'imported') {
    return outcome.validation_issues?.length
      ? `<ul class="issue-list">${outcome.validation_issues.map(code => `<li class="${IMP_ISSUES[code]?.tone || 'warn'}">${icon('alert-triangle')}${esc(IMP_ISSUES[code]?.text || code)}</li>`).join('')}</ul>`
      : '';
  }
  const cls = outcome.outcome === 'rejected' ? 'bad' : 'skip';
  return `<ul class="issue-list"><li class="${cls}">${icon(outcome.outcome === 'rejected' ? 'alert-octagon' : 'info')}${esc(outcome.reason)}</li></ul>`;
}

function impStatRow(items) {
  return `<div class="stat-row">${items.map(item => `
    <div class="stat ${item.cls || ''}">
      <div class="stat-label">${icon(item.iconName)}${esc(item.label)}</div>
      <div class="stat-value">${fmtNum(item.value)}</div>
    </div>`).join('')}</div>`;
}

/* Step 3 — Preview & validate */
function impStep3() {
  const data = imp.preview;
  const dry = data.dry_run;
  const attention = dry.attention;
  const attentionTotal = dry.with_warnings + dry.rejected + dry.skipped;

  return `${impHead('Preview & validate', 'The server has checked every row against the import rules. Nothing has been saved yet.')}
    <div class="card-body">
      ${impErrorCallout()}
      ${impStatRow([
        { label: 'Rows detected', value: data.total_rows, iconName: 'file' },
        { label: 'Ready to import', value: dry.ready, iconName: 'check-circle', cls: 'ok' },
        { label: 'With warnings', value: dry.with_warnings, iconName: 'alert-triangle', cls: 'warn' },
        { label: 'Rejected', value: dry.rejected, iconName: 'alert-octagon', cls: 'bad' },
        { label: 'Skipped (scope)', value: dry.skipped, iconName: 'minus-circle', cls: 'muted-stat' }
      ])}
      <div class="callout info" style="margin-top:14px">${icon('shield')}<div>APAAR checks are <strong>local format checks only</strong> (12 digits after removing spaces and hyphens). A well-formed identifier is not authoritatively verified, and no government system is contacted.</div></div>

      <div class="sub-head"><h3>First ${data.sample.length} rows after mapping</h3><span>Identifiers masked</span></div>
      <div class="card table-card" style="box-shadow:none">
        <div class="table-scroll"><table class="data-table compact stackable">
          <caption class="sr-only">Preview of the first ${data.sample.length} mapped rows with their validation result</caption>
          <thead><tr><th scope="col">Row</th><th scope="col">Student</th><th scope="col">Institution</th><th scope="col" class="col-hide-md">Programme · session</th><th scope="col" class="col-hide-md">Status</th><th scope="col">APAAR</th><th scope="col" style="min-width:230px">Result</th></tr></thead>
          <tbody>${data.sample.map(sample => `
            <tr>
              <td data-label="Row" class="num">${sample.row}</td>
              <td data-label="Student" class="cell-wide nowrap">${esc(sample.name)}</td>
              <td data-label="Institution">${esc(sample.institution_code || '—')}</td>
              <td data-label="Programme · session" class="col-hide-md">${esc(sample.programme || '—')}<div class="cell-sub">${esc(sample.academic_session || '')}</div></td>
              <td data-label="Status" class="col-hide-md">${esc(sample.enrolment_status || '—')}</td>
              <td data-label="APAAR" class="mono nowrap">${esc(sample.apaar)}</td>
              <td data-label="Result" class="cell-wide">${impOutcomeBadge(sample.outcome)}${impOutcomeMessages(sample.outcome)}</td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>

      <div class="sub-head"><h3>Rows needing attention</h3><span>${attentionTotal ? `${plural(attentionTotal, 'row')} across the whole file` : 'None'}</span></div>
      ${attention.length ? `
        <div class="card table-card" style="box-shadow:none">
          <div class="table-scroll"><table class="data-table compact stackable">
            <caption class="sr-only">Rows that will be rejected, skipped or imported with a validation finding</caption>
            <thead><tr><th scope="col">Source row</th><th scope="col">Outcome</th><th scope="col">Reason</th></tr></thead>
            <tbody>${attention.map(item => `
              <tr><td data-label="Source row" class="num">${item.source_row}</td><td data-label="Outcome">${impOutcomeBadge(item)}</td><td data-label="Reason" class="cell-wide">${impOutcomeMessages(item)}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>
        ${attentionTotal > attention.length ? `<p class="field-help" style="margin-top:8px">Showing the first ${attention.length} of ${attentionTotal}. The import summary lists every row outcome.</p>` : ''}`
        : `<div class="callout success">${icon('check-circle')}<div>Every row passed the import checks.</div></div>`}
    </div>
    <div class="imp-actions">
      <button type="button" class="btn btn-secondary" data-goto="2">${icon('arrow-left')}Back to mapping</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary" data-goto="4">Continue to confirm${icon('arrow-right')}</button>
    </div>`;
}

/* Step 4 — Confirm import */
function impStep4() {
  const dry = imp.preview.dry_run;
  const importable = impImportable();
  const institution = imp.institutions.find(i => i.code === dry.batch_institution);
  const mode = dry.multi_institution
    ? 'Multi-institution (regulator)'
    : `Single institution · ${dry.batch_institution}${institution ? ` · ${institution.name}` : ''}`;

  const confirmationText = state.runtime?.mode === 'synthetic-test'
    ? 'Review what will be committed. The batch stays in this ephemeral synthetic test session, and institution-scoped reconciliation runs immediately.'
    : 'Review what will be committed. The batch is written to the local demo database and reconciliation runs immediately.';
  return `${impHead('Confirm import', confirmationText)}
    <div class="card-body">
      ${impErrorCallout()}
      <dl class="summary-dl">
        <div><dt>Source file</dt><dd>${esc(imp.file.name)}</dd></div>
        <div><dt>Import mode</dt><dd>${esc(mode)}</dd></div>
        <div><dt>Rows to import</dt><dd class="big">${fmtNum(importable)}</dd></div>
        <div><dt>Rows to reject (missing required values)</dt><dd class="big">${fmtNum(dry.rejected)}</dd></div>
        <div><dt>Rows to skip (institution scope)</dt><dd class="big">${fmtNum(dry.skipped)}</dd></div>
        <div><dt>Expected identifier validation findings</dt><dd class="big">${fmtNum(dry.with_warnings)}</dd></div>
      </dl>
      <div class="callout" style="margin-top:14px">${icon('info')}<div>These figures come from the server’s pre-import check. <strong>Final counts are reported by the server after the batch is committed.</strong> Cross-record findings — repeated identifiers, identity conflicts, concurrent enrolments, candidate matches and capacity checks — are computed during import and appear in the summary.</div></div>
      ${imp.submitting ? `<div style="margin-top:14px">${impProcessing('Importing and reconciling…', `Writing ${plural(importable, 'row')} as one batch, then re-running duplicate, conflict, concurrent-enrolment, candidate-match and capacity checks. Results appear when the server confirms the batch.`)}</div>` : ''}
      ${importable ? '' : `<div class="callout warning" style="margin-top:12px">${icon('alert-triangle')}<div>No rows can be imported with the current mapping and source institution. Go back to adjust the mapping or institution.</div></div>`}
    </div>
    <div class="imp-actions">
      <button type="button" class="btn btn-secondary" data-goto="3" ${imp.submitting ? 'disabled' : ''}>${icon('arrow-left')}Back</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-primary${imp.submitting ? ' is-busy' : ''}" id="impConfirm" ${importable && !imp.submitting ? '' : 'disabled'}>${icon('upload')}Import ${plural(importable, 'row')}</button>
    </div>`;
}

/* Step 5 — Import summary (server response, verbatim counts) */
function impStep5() {
  const batch = imp.result.data;
  const attention = batch.row_outcomes.filter(item => item.outcome !== 'imported' || item.validation_issues?.length);
  return `<div class="card-body" style="padding-top:20px">
      <div class="result-hero">
        <span class="dz-icon">${icon('check-circle', 'icon-lg')}</span>
        <div>
          <h2 id="impStepTitle" tabindex="-1">Import completed — ${plural(batch.imported, 'row')} saved</h2>
          <p>Confirmed by the server as batch <span class="mono">${esc(batch.id)}</span> · ${esc(batch.source_file)}. ${batch.findings_created ? `Reconciliation created ${plural(batch.findings_created, 'new finding')}.` : 'Reconciliation created no new findings.'}</p>
        </div>
      </div>
      ${impStatRow([
        { label: 'Rows detected', value: batch.rows_detected, iconName: 'file' },
        { label: 'Imported', value: batch.imported, iconName: 'check-circle', cls: 'ok' },
        { label: 'Rejected', value: batch.rejected, iconName: 'alert-octagon', cls: batch.rejected ? 'bad' : '' },
        { label: 'Skipped', value: batch.skipped, iconName: 'minus-circle', cls: 'muted-stat' },
        { label: 'Findings created', value: batch.findings_created, iconName: 'reconcile', cls: batch.findings_created ? 'warn' : '' }
      ])}
      <p class="reconcile-line">${icon('check', 'icon-sm')}${fmtNum(batch.rows_detected)} detected = ${fmtNum(batch.imported)} imported + ${fmtNum(batch.rejected)} rejected + ${fmtNum(batch.skipped)} skipped · ${plural(batch.validation_findings_created, 'validation finding')} among ${plural(batch.findings_created, 'new finding')}</p>
      ${batch.capacity_findings_superseded || batch.capacity_findings_cleared ? `<div class="callout info" style="margin-top:12px">${icon('history')}<div>Capacity was recomputed: ${plural(batch.capacity_findings_superseded, 'earlier capacity finding')} superseded and ${batch.capacity_findings_cleared} cleared. Historical findings keep their review history and are listed under <a href="#/reconciliation?lifecycle=historical">Lifecycle: Historical</a>.</div></div>` : ''}

      <div class="sub-head"><h3>Rows requiring attention</h3><span>${attention.length ? plural(attention.length, 'row') : 'None'}</span></div>
      ${attention.length ? `
        <div class="card table-card" style="box-shadow:none">
          <div class="table-scroll"><table class="data-table compact stackable">
            <caption class="sr-only">Rows that were rejected, skipped or imported with validation findings</caption>
            <thead><tr><th scope="col">Source row</th><th scope="col">Outcome</th><th scope="col">Detail</th></tr></thead>
            <tbody>${attention.slice(0, 300).map(item => `
              <tr><td data-label="Source row" class="num">${item.source_row}</td><td data-label="Outcome">${impOutcomeBadge(item).replace('Import + finding', 'Imported + finding').replace('Ready', 'Imported')}</td><td data-label="Detail" class="cell-wide">${impOutcomeMessages(item).replaceAll('imports with', 'imported with')}</td></tr>`).join('')}</tbody>
          </table></div>
        </div>
        ${attention.length > 300 ? `<p class="field-help" style="margin-top:8px">Showing the first 300 of ${attention.length}.</p>` : ''}`
        : `<div class="callout success">${icon('check-circle')}<div>Every detected row was imported without a validation issue.</div></div>`}
    </div>
    <div class="imp-actions">
      <button type="button" class="btn btn-secondary" id="impAnother">${icon('upload')}Import another file</button>
      <span class="spacer"></span>
      ${batch.findings_created
        ? `<a class="btn btn-primary" href="#/reconciliation?batch=${encodeURIComponent(batch.id)}">Review ${plural(batch.findings_created, 'new finding')}${icon('arrow-right')}</a>`
        : `<a class="btn btn-primary" href="#/reconciliation">Open reconciliation${icon('arrow-right')}</a>`}
    </div>`;
}

/* ── Actions ──────────────────────────────────── */
function impGoto(step) {
  if (step < 1 || step > impMaxStep()) return;
  if (imp.result && step < 5) return;
  imp.step = step;
  imp.error = null;
  impRender();
  $('#impStepTitle')?.focus({ preventScroll: true });
  $('#view-import').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function impHandleFile(file) {
  if (!file) return;
  imp.idempotencyKey = null;
  imp.result = null;
  imp.retry = null;
  if (!/\.csv$/i.test(file.name)) {
    imp.error = `“${file.name}” is not a CSV file. Export the spreadsheet as CSV (comma-separated values) and upload that file — XLSX is not parsed by this dependency-free build.`;
    impRender();
    return;
  }
  if (file.size > IMP_MAX_BYTES) {
    imp.error = `“${file.name}” is ${(file.size / 1024 / 1024).toFixed(1)} MB. The prototype accepts CSV files up to 2 MB — split the file into smaller batches.`;
    impRender();
    return;
  }
  imp.file = { name: file.name, size: file.size };
  imp.csv = await file.text();
  imp.preview = null;
  imp.mapping = {};
  imp.suggested = {};
  imp.step = 1;
  await impRunPreview({ initial: true });
}

async function impRunPreview({ initial = false } = {}) {
  if (!imp.csv) return;
  const token = ++imp.token;
  imp.loading = true;
  imp.error = null;
  imp.retry = null;
  impRender();
  try {
    const response = await api('/api/v1/imports/preview', {
      method: 'POST',
      body: JSON.stringify({ filename: imp.file.name, csv: imp.csv, mapping: imp.mapping, institution_code: imp.institution, multi_institution: imp.multi })
    });
    if (token !== imp.token) return;
    imp.preview = response.data;
    imp.mapping = { ...response.data.mapping };
    if (initial) {
      imp.suggested = { ...response.data.mapping };
      imp.suggestedBy = { ...(response.data.mapping_sources || {}) };
      imp.assist = response.data.model_assistance || null;
    }
  } catch (error) {
    if (token !== imp.token) return;
    imp.error = `${error.message}${/CSV/i.test(error.message) ? ' Fix the file and choose it again.' : ''}`;
    imp.retry = 'preview';
    imp.retryable = !(error.status && error.status < 500);
    if (initial) imp.preview = null;
  }
  imp.loading = false;
  if (imp.step > impMaxStep()) imp.step = impMaxStep();
  impRender();
}

async function impConfirm() {
  if (!imp.preview || imp.submitting) return;
  imp.submitting = true;
  imp.error = null;
  imp.retry = null;
  impRender();
  try {
    imp.idempotencyKey ||= crypto.randomUUID();
    const response = await api('/api/v1/imports/confirm', {
      method: 'POST',
      headers: { 'Idempotency-Key': imp.idempotencyKey },
      body: JSON.stringify({ filename: imp.file.name, csv: imp.csv, mapping: imp.mapping, institution_code: imp.institution, multi_institution: imp.multi })
    });
    imp.result = response;
    imp.step = 5;
    imp.submitting = false;
    impRender();
    $('#impStepTitle')?.focus({ preventScroll: true });
    toast(`${plural(response.data.imported, 'row')} imported, ${plural(response.data.findings_created, 'new finding')} created. Review the row summary and inspect any newly created findings.`, { tone: 'success', title: 'Import completed' });
    refreshPrincipal();
    impLoadHistory();
  } catch (error) {
    imp.submitting = false;
    imp.error = error.message;
    imp.retry = 'confirm';
    imp.retryable = !(error.status && error.status < 500);
    if (error.details?.fields?.length) imp.step = 2;
    impRender();
    toast(error.message, { tone: 'error', title: 'Import not completed' });
  }
}

/* ── Event Bindings (delegated; panel re-renders) ─ */
const impPanel = $('#impPanel');

impPanel.addEventListener('click', event => {
  const goto = event.target.closest('[data-goto]');
  if (goto && !goto.disabled) { impGoto(Number(goto.dataset.goto)); return; }
  if (event.target.closest('#impRemove')) { impReset(); impRender(); $('#impFile')?.focus(); return; }
  if (event.target.closest('#impConfirm')) { impConfirm(); return; }
  if (event.target.closest('[data-retry]')) { if (imp.retry === 'confirm') impConfirm(); else impRunPreview({ initial: !imp.preview }); return; }
  if (event.target.closest('#impAnother')) { impReset(); impRender(); $('#impFile')?.focus(); }
});

$('#impStepper').addEventListener('click', event => {
  const button = event.target.closest('[data-goto]');
  if (button && !button.disabled) impGoto(Number(button.dataset.goto));
});

impPanel.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'impFile' || target.id === 'impFileReplace' || target.id === 'impFileRetry') { impHandleFile(target.files[0]); return; }
  if (target.id === 'impInstitution') { imp.institution = target.value; imp.idempotencyKey = null; impRunPreview(); return; }
  if (target.id === 'impMulti') { imp.multi = target.checked; impRunPreview(); if (!imp.csv) impRender(); return; }
  if (target.dataset.map) {
    imp.idempotencyKey = null;
    if (target.value) imp.mapping[target.dataset.map] = target.value;
    else delete imp.mapping[target.dataset.map];
    impRunPreview();
  }
});

['dragenter', 'dragover'].forEach(type => impPanel.addEventListener(type, event => {
  const zone = event.target.closest('#impDrop');
  if (!zone) return;
  event.preventDefault();
  zone.classList.add('is-drag');
}));
['dragleave', 'drop'].forEach(type => impPanel.addEventListener(type, event => {
  const zone = event.target.closest('#impDrop');
  if (!zone) return;
  event.preventDefault();
  if (type === 'dragleave' && zone.contains(event.relatedTarget)) return;
  zone.classList.remove('is-drag');
  if (type === 'drop') impHandleFile(event.dataTransfer.files[0]);
}));

/* Dropping a file elsewhere on the page must not navigate away from the app */
['dragover', 'drop'].forEach(type => window.addEventListener(type, event => {
  if (event.dataTransfer?.types?.includes('Files') && !event.target.closest('#impDrop')) event.preventDefault();
}));
