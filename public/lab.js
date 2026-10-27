/* EduTrace AI — Evidence Impact Lab and decision receipts
   SIH 26263 · Opened from a finding or a potential match. A reviewer stages one source-backed
   correction, the server runs the real reconciliation pipeline on an isolated copy and returns the
   difference. Nothing is saved. Committed decisions carry a receipt that can be re-verified.
   ──────────────────────────────────────────────── */
'use strict';

const LAB_LABEL = 'SIMULATION ONLY — NO AUTHORITATIVE RECORD CHANGED';
const LAB_STATE = {
  supporting: { label: 'Supporting', tone: 'tone-success', icon: 'check-circle' },
  missing: { label: 'Missing', tone: 'st-awaiting_verification', icon: 'minus-circle' },
  conflicting: { label: 'Conflicting', tone: 'tone-danger', icon: 'alert-triangle' },
  not_comparable: { label: 'Not comparable', tone: 'tone-neutral', icon: 'help' }
};
const LAB_PATH_TONE = { institution_reference: 'info', reviewer_confirmed: 'info', not_recognised: 'warning', rejected: 'danger' };
const LAB_OUTCOME = { auto_linked: 'Linked automatically by the policy', needs_investigation: 'Needs investigation', candidate_for_review: 'Candidate for review', insufficient_evidence: 'Insufficient evidence', not_linked: 'Not linked', same_source_record: 'Same source record' };
const LAB_FIELD_HELP = {
  apaar_id: '12 digits, as issued. Shown masked in every result.',
  student_name: 'As the institution records it.',
  date_of_birth: 'DD/MM/YYYY or YYYY-MM-DD.',
  programme: 'As the institution records it, for example BTECH CSE.',
  academic_session: 'For example 2026-27.',
  enrolment_status: 'active, transferred, completed or withdrawn.'
};

const lab = { context: null, info: null, result: null, records: new Map(), staged: { record_id: '', field: '', value: '', kind: '', reference: '' }, opener: null, token: 0 };

/* ── Opening, closing, discarding ─────────────── */
async function labOpen(context, opener) {
  const same = lab.context && JSON.stringify(lab.context) === JSON.stringify(context);
  if (!same) labDiscard({ keepContext: false });
  lab.context = context;
  lab.opener = opener || document.activeElement;
  const dialog = $('#labDialog');
  if (!dialog.open) dialog.showModal();
  if (same && lab.info) { labRender(); return; }
  const token = ++lab.token;
  $('#labBody').innerHTML = skeletonLines(8);
  try {
    const qs = context.finding_id ? `finding=${encodeURIComponent(context.finding_id)}` : `link=${encodeURIComponent(context.link_id)}`;
    const info = (await api(`/api/v1/evidence/checklist?${qs}`)).data;
    if (token !== lab.token) return;
    lab.info = info;
    const records = labContextRecords();
    lab.staged.record_id = lab.staged.record_id && records.some(r => r.record_id === lab.staged.record_id) ? lab.staged.record_id : records[0]?.record_id || '';
    lab.staged.field = lab.staged.field || info.fields[0]?.key || '';
    await labLoadRecords(records);
    if (token !== lab.token) return;
    labRender();
    $('#labTitle').focus();
  } catch (error) {
    if (token !== lab.token) return;
    $('#labBody').innerHTML = errorState(error.message);
  }
}

/* Current values of the records the lab can stage against, for display only (identifiers masked by the server). */
async function labLoadRecords(records) {
  await Promise.all(records.filter(r => !lab.records.has(r.record_id)).map(async r => {
    try { lab.records.set(r.record_id, (await api(`/api/v1/records/${encodeURIComponent(r.record_id)}`)).data); } catch { /* shown without the current value */ }
  }));
}

function labContextRecords() {
  const current = lab.info?.current;
  if (!current) return [];
  return (current.kind === 'finding' ? current.evidence : current.records).filter(r => r.record_id && r.available !== false);
}

/* Discard: the result, the staged values and the graph overlay all go. Nothing was stored, so nothing is undone. */
function labDiscard({ keepContext = true } = {}) {
  lab.result = null;
  lab.staged = { record_id: keepContext ? lab.staged.record_id : '', field: keepContext ? lab.staged.field : '', value: '', kind: '', reference: '' };
  if (!keepContext) { lab.info = null; lab.context = null; lab.records.clear(); }
  if (typeof gExitSimulation === 'function') gExitSimulation({ silent: true });
}

function labClose({ discard = true } = {}) {
  const dialog = $('#labDialog');
  if (discard) labDiscard({ keepContext: false });
  if (dialog.open) dialog.close();
  if (discard && lab.opener?.isConnected) lab.opener.focus();
}

/* ── Rendering ────────────────────────────────── */
/* Row numbers repeat across programmes in one file, so the record id is shown too. */
const labRef = r => (r.hypothetical ? 'Simulated new row (not stored)' : `${r.institution_code} row ${r.source_row} (${r.record_id})${r.simulated_version ? ' · corrected version (simulated)' : ''}`);
const labRefs = refs => refs.map(labRef).join(' ↔ ');
const labStateChip = s => { const meta = LAB_STATE[s] || { label: s, tone: 'tone-neutral', icon: 'info' }; return `<span class="badge badge-plain ${meta.tone}">${icon(meta.icon, 'icon-xs')}${esc(meta.label)}</span>`; };

function labRender() {
  const info = lab.info;
  const current = info.current;
  $('#labBody').innerHTML = `
    <p class="lab-intro">Stage one correction to a source record, supported by the institution's evidence. The server runs the real rules and identity policy <code>${esc(current?.policy_version || 'auto-link-2')}</code> on an isolated copy and compares it with the current data. ${state.readOnly ? '' : 'Nothing is saved, and nothing here is a decision.'}</p>
    <div class="lab-grid">
      <section class="lab-card" aria-labelledby="labCurrentH">
        <h3 id="labCurrentH">${icon('eye', 'icon-sm')}Current outcome</h3>
        ${labCurrentHtml(current)}
      </section>
      <section class="lab-card" aria-labelledby="labChecklistH">
        <h3 id="labChecklistH">${icon('check-circle', 'icon-sm')}Minimum evidence <span class="subtle">from the rules</span></h3>
        ${labChecklistHtml(info.checklist)}
      </section>
    </div>
    ${labFormHtml()}
    <div id="labResult">${lab.result ? labResultHtml(lab.result) : ''}</div>`;
  labBind();
}

function labCurrentHtml(c) {
  if (!c) return '<p class="muted">The finding or pair is not available.</p>';
  if (c.kind === 'finding') return `
    <p class="lab-title">${esc(c.title)}</p>
    <div class="drawer-badges">${sevBadge(c.severity)}${statusBadge(c.review_status)}<span class="badge badge-plain tone-neutral">${esc(ruleLabel(c.rule_code))}</span></div>
    <dl class="gp-kv"><dt>Records</dt><dd>${esc(labRefs(c.evidence))}</dd><dt>Processing</dt><dd>${esc((c.processing_outcome || '—').replaceAll('_', ' '))}</dd><dt>Required action</dt><dd>${esc(c.required_action || '—')}</dd></dl>`;
  return `
    <p class="lab-title">${esc(labRefs(c.records))}</p>
    <div class="drawer-badges"><span class="badge badge-plain tone-neutral">${esc(LAB_OUTCOME[c.outcome] || c.outcome)}</span>${c.decision ? `<span class="badge badge-plain st-resolved">${esc(c.decision.label)} (user decision)</span>` : ''}</div>
    <p class="lab-reason">${esc(c.reason)}</p>
    <dl class="gp-kv"><dt>Agree</dt><dd>${esc(c.agreeing_fields.join(', ') || 'none')}</dd><dt>Conflict</dt><dd>${esc(c.conflicting_fields.join(', ') || 'none')}</dd><dt>Missing</dt><dd>${esc(c.missing_fields.join(', ') || 'none')}</dd></dl>`;
}

function labChecklistHtml(checklist) {
  if (!checklist) return '<p class="muted">No checklist for this case.</p>';
  if (checklist.present === false) return `<p class="muted">This finding or pair is no longer current here${checklist.limitations?.length ? `: ${esc(checklist.limitations[0])}` : '.'}</p>`;
  const items = checklist.items.map(item => `
    <li class="lab-check ${item.blocker && item.state !== 'supporting' ? 'is-blocker' : ''}">
      <div class="lab-check-head">${labStateChip(item.state)}<strong>${esc(item.label)}</strong>${item.blocker && item.state !== 'supporting' ? '<span class="badge badge-plain tone-danger">Hard blocker</span>' : item.state !== 'supporting' ? '<span class="badge badge-plain tone-neutral">Review context</span>' : ''}</div>
      <p>${esc(item.verify)}</p>
      ${item.per_record?.length ? `<ul class="lab-per-record">${item.per_record.map(p => `<li><button type="button" class="link-btn" data-lab-record="${esc(p.record.record_id)}">${esc(labRef(p.record))}</button> <span class="subtle">${esc(String(p.state).replaceAll('_', ' '))}</span></li>`).join('')}</ul>` : ''}
      <details class="lab-rule"><summary>Rule ${esc(item.rule.id)}</summary><p>${esc(item.rule.text)}</p>${item.source ? `<p class="subtle">Authorised source: ${esc(item.source)}</p>` : ''}</details>
    </li>`).join('');
  return `${items ? `<ul class="lab-checklist">${items}</ul>` : '<p class="muted">No field-level evidence applies.</p>'}
    ${(checklist.limitations || []).map(l => `<p class="lab-limit">${icon('info', 'icon-xs')}${esc(l)}</p>`).join('')}`;
}

function labFormHtml() {
  const records = labContextRecords();
  const s = lab.staged;
  const detail = lab.records.get(s.record_id);
  const currentValue = detail?.comparison?.[s.field];
  const fields = lab.info.fields;
  const blocked = state.readOnly;
  return `
    <form class="lab-form" id="labForm" novalidate aria-labelledby="labStageH">
      <h3 id="labStageH">${icon('sliders', 'icon-sm')}Stage a correction</h3>
      ${blocked ? `<div class="callout info">${icon('shield')}<div><strong>Simulations are not available in the read-only demo.</strong> The server rejects every request that is not a read, including this one. The current outcome and the evidence checklist above are shown from the synthetic data.</div></div>` : ''}
      <div class="lab-fields">
        <div class="field"><label class="field-label" for="labRecord">Source record</label>
          <select class="select" id="labRecord" ${blocked ? 'disabled' : ''}>${records.map(r => `<option value="${esc(r.record_id)}" ${r.record_id === s.record_id ? 'selected' : ''}>${esc(labRef(r))} · ${esc(r.source_file)}</option>`).join('')}</select></div>
        <div class="field"><label class="field-label" for="labField">Field</label>
          <select class="select" id="labField" ${blocked ? 'disabled' : ''}>${fields.map(f => `<option value="${esc(f.key)}" ${f.key === s.field ? 'selected' : ''}>${esc(f.label)}</option>`).join('')}</select></div>
        <div class="field"><span class="field-label">Current value</span><p class="lab-current-value ${currentValue ? 'mono' : 'muted'}">${esc(currentValue || 'Not provided')}</p></div>
        <div class="field"><label class="field-label" for="labValue">Proposed value <span class="req">Required</span></label>
          <input class="input" id="labValue" autocomplete="off" spellcheck="false" value="${esc(s.value)}" aria-describedby="labValueHelp" ${blocked ? 'disabled' : ''}>
          <span class="field-help" id="labValueHelp">${esc(LAB_FIELD_HELP[s.field] || '')} Never copy a value from another record; enter what the institution's evidence shows.</span></div>
      </div>
      <fieldset class="lab-evidence"><legend>${icon('file', 'icon-xs')}Source evidence for the proposed value <span class="req">Required</span></legend>
        <div class="lab-fields">
          <div class="field"><label class="field-label" for="labKind">Evidence</label>
            <select class="select" id="labKind" ${blocked ? 'disabled' : ''}><option value="">Choose the source…</option>${lab.info.evidence_kinds.map(k => `<option value="${esc(k.key)}" ${k.key === s.kind ? 'selected' : ''}>${esc(k.label)}</option>`).join('')}</select></div>
          <div class="field"><label class="field-label" for="labReference">Where it is held</label>
            <input class="input" id="labReference" maxlength="200" autocomplete="off" value="${esc(s.reference)}" placeholder="For example: registrar letter REG/2026/114" aria-describedby="labRefHelp" ${blocked ? 'disabled' : ''}>
            <span class="field-help" id="labRefHelp">Describe the document; do not paste identifiers. EduTrace does not see or verify it.</span></div>
        </div>
      </fieldset>
      <p class="field-error" id="labError" role="alert" hidden></p>
      <div class="lab-actions">
        <button type="button" class="btn btn-ghost" id="labReturn">${icon('arrow-left', 'icon-sm')}Return to the record</button>
        <span class="spacer"></span>
        ${lab.result ? `<button type="button" class="btn btn-secondary" id="labDiscard">${icon('trash', 'icon-sm')}Discard simulation</button>` : ''}
        <button type="submit" class="btn btn-primary" id="labRun" ${blocked ? 'disabled' : ''}>${icon('flask', 'icon-sm')}Run simulation</button>
      </div>
    </form>`;
}

function labList(title, items, render, empty) {
  if (!items.length) return empty ? `<div class="lab-list"><h4>${esc(title)}</h4><p class="muted">${esc(empty)}</p></div>` : '';
  return `<div class="lab-list"><h4>${esc(title)} <span class="subtle">${items.length}</span></h4><ul>${items.map(render).join('')}</ul></div>`;
}
const labWhy = cause => (cause ? `<details class="lab-rule"><summary>Why</summary><p>${esc(cause)}</p></details>` : '');
const labFindingLine = (f, note = '') => `<strong>${esc(ruleLabel(f.rule_code))}</strong> · ${esc(labRefs(f.evidence))} ${sevBadge(f.severity)} ${statusBadge(f.review_status)}${note}`;
const labPairLine = p => `<strong>${esc(labRefs(p.records))}</strong> · ${esc(LAB_OUTCOME[p.outcome] || p.outcome)}`;

function labResultHtml(r) {
  const f = r.findings; const id = r.identity; const ev = r.evidence; const x = r.explanation;
  const counts = [
    ['would resolve', f.resolved.length], ['newly created', f.created.length], ['reclassified', f.reclassified.length], ['back to review', f.reopened.length],
    ['pairs changed', id.changed.length + id.new_pairs.length + id.no_longer_compared.length], ['decisions no longer applying', id.decisions_no_longer_applying.length]
  ];
  return `
    <section class="lab-results" aria-labelledby="labResultH" tabindex="-1" id="labResultSection">
      <h3 id="labResultH">${icon('scale', 'icon-sm')}Simulated impact</h3>
      <p class="lab-headline">${esc(x.headline)}</p>
      <p class="subtle lab-meta">Evaluated by the real pipeline on an isolated copy as of ${esc(fmtDate(r.diagnostics.evaluated_as_of))} · ${esc(r.diagnostics.pipeline.length)} pipeline ${r.diagnostics.pipeline.length === 1 ? 'step' : 'steps'} · not saved · no receipt · no audit event · no model call</p>
      <div class="callout ${LAB_PATH_TONE[r.correction_path.kind] || 'info'}">${icon(r.correction_path.kind === 'not_recognised' ? 'alert-triangle' : 'info')}<div><strong>${esc(r.correction_path.label)}.</strong> ${esc(r.correction_path.explanation)}</div></div>
      ${r.staged.warnings.map(w => `<div class="callout warning">${icon('alert-triangle')}<div>${esc(w)}</div></div>`).join('')}

      <div class="lab-compare">
        <div class="lab-col"><p class="lab-col-label">Current</p><p><strong>${esc(r.staged.field_label)}</strong>: <span class="mono">${esc(r.staged.before)}</span></p>${r.current ? labCurrentHtml(r.current) : ''}</div>
        <div class="lab-col is-sim"><p class="lab-col-label">Simulated</p><p><strong>${esc(r.staged.field_label)}</strong>: <span class="mono">${esc(r.staged.after)}</span></p>
          <p class="subtle">Evidence: ${esc(r.staged.evidence.kind_label)} — ${esc(r.staged.evidence.reference)}. ${esc(r.staged.provenance_note)}</p>
          ${r.checklist.after ? labChecklistHtml(r.checklist.after) : ''}</div>
      </div>

      <ul class="lab-counts">${counts.map(([label, n]) => `<li class="${n ? 'has-change' : ''}"><strong>${n}</strong> ${esc(label)}</li>`).join('')}</ul>

      <div class="lab-sections">
        <section><h4>${icon('alert-triangle', 'icon-xs')}Findings</h4>
          ${labList('Would resolve', f.resolved, i => `<li>${labFindingLine(i.before, ` <span class="subtle">${esc(i.how.replaceAll('_', ' '))}</span>`)}${labWhy(i.reason)}</li>`)}
          ${labList('Newly created', f.created, i => `<li>${labFindingLine(i.after)}${labWhy(i.reason)}</li>`)}
          ${labList('Severity or classification would change', f.reclassified, i => `<li>${labFindingLine(i.before)} → <strong>${esc(ruleLabel(i.after.rule_code))}</strong> ${sevBadge(i.after.severity)}${labWhy(i.reason)}</li>`)}
          ${labList('Would return to manual review', f.reopened, i => `<li>${labFindingLine(i.before)}${labWhy(i.reason)}</li>`)}
          ${labList('Would remain open', f.remain_open, i => `<li>${labFindingLine(i.after, i.recomputed ? ' <span class="subtle">re-evaluated</span>' : '')}</li>`, 'No open finding on these records would remain.')}
          ${f.superseded.length ? `<p class="subtle">${plural(f.superseded.length, 'finding')} would be superseded by a recomputed finding for the same condition; history is kept.</p>` : ''}
          ${f.other_open_unchanged ? `<p class="subtle">${plural(f.other_open_unchanged, 'other open finding')} unaffected.</p>` : ''}
        </section>
        <section><h4>${icon('git-merge', 'icon-xs')}Identity candidates</h4>
          ${labList('State would change', id.changed, i => `<li><strong>${esc(labRefs(i.after.records))}</strong> · ${esc(LAB_OUTCOME[i.before.outcome] || i.before.outcome)} → ${esc(LAB_OUTCOME[i.after.outcome] || i.after.outcome)}${labWhy(i.after.reason)}</li>`)}
          ${labList('Compared for the first time', id.new_pairs, i => `<li>${labPairLine(i.after)}${labWhy(i.after.reason)}</li>`)}
          ${labList('No longer compared', id.no_longer_compared, i => `<li>${labPairLine(i.before)}</li>`)}
          ${labList('Remain unresolved', id.unresolved_remaining, i => `<li>${labPairLine(i.pair)}${labWhy(i.pair.reason)}</li>`)}
          ${labList('Competing candidates that remain plausible', id.competing, i => `<li>${labPairLine(i.pair)} · ${esc(i.pair.competing_candidates)} candidates</li>`)}
          ${labList('Contradicted by the staged evidence', id.contradicted, i => `<li>${labPairLine(i.pair)} · conflicting: ${esc(i.fields.join(', '))}</li>`)}
          ${labList('Automatic links the policy would withdraw', id.withdrawn, i => `<li><strong>${esc(labRefs(i.pair.records))}</strong>${labWhy(i.reason)}</li>`)}
          ${labList('User decisions that would no longer apply', id.decisions_no_longer_applying, i => `<li><strong>${esc(labRefs(i.pair))}</strong> · ${esc(i.decision.label)}${labWhy(i.reason)}</li>`)}
          ${!id.changed.length && !id.new_pairs.length && !id.no_longer_compared.length && !id.unresolved_remaining.length ? '<p class="muted">No identity relationship involving these records would change.</p>' : ''}
        </section>
        <section><h4>${icon('columns', 'icon-xs')}Evidence</h4>
          <p><strong>${esc(ev.staged_field.label)}</strong>: ${esc(ev.staged_field.before_state)} → ${esc(ev.staged_field.after_state)}</p>
          ${labList('Missing, would become populated', ev.populated, i => `<li>${esc(labRefs(i.pair))} · ${esc(i.field.replaceAll('_', ' '))}</li>`)}
          ${labList('Would become supporting', ev.newly_supporting, i => `<li>${esc(labRefs(i.pair))} · ${esc(i.field.replaceAll('_', ' '))}: ${esc(i.result_before || 'not compared')} → agrees</li>`)}
          ${labList('Conflicts that remain', ev.conflicts_remaining, i => `<li>${esc(labRefs(i.pair))} · ${esc(i.field.replaceAll('_', ' '))}</li>`)}
          ${labList('Newly conflicting', ev.newly_conflicting, i => `<li>${esc(labRefs(i.pair))} · ${esc(i.field.replaceAll('_', ' '))}</li>`)}
          ${labList('Still insufficient', ev.still_insufficient, i => `<li>${esc(labRefs(i.pair))} · ${esc(i.reason)}</li>`)}
          ${labList('Source records affected', ev.records_affected, i => `<li>${esc(labRef(i.record))} · ${esc((i.before || 'not stored').replaceAll('_', ' '))} → ${esc((i.after || 'not stored').replaceAll('_', ' '))}</li>`)}
        </section>
      </div>

      <section class="lab-explain"><h4>${icon('info', 'icon-xs')}Decision explanation</h4>
        ${labList('What would change', x.changed, i => `<li>${esc(i.text)}<details class="lab-rule"><summary>Rule ${esc(i.rule)}</summary><p>${esc(i.cause || 'See the rule.')}</p></details></li>`, 'Nothing. A simulation with no change is a valid result.')}
        ${labList('What would not change', x.unchanged, i => `<li>${esc(i)}</li>`)}
        ${labList('Why it would remain unresolved', x.unresolved, i => `<li>${esc(i)}</li>`)}
        ${labList('Evidence needed to reassess', x.evidence_needed, i => `<li><strong>${esc(i.label)}</strong> (${esc(i.state.replace('_', ' '))}): ${esc(i.verify)} <span class="subtle">Source: ${esc(i.source)}</span></li>`)}
        <ul class="lab-caveats">${x.caveats.map(c => `<li>${icon('shield', 'icon-xs')}${esc(c)}</li>`).join('')}</ul>
        <p class="subtle">${esc(r.scope_note)}</p>
      </section>

      <div class="lab-actions">
        ${r.graph_overlay ? `<button type="button" class="btn btn-secondary" id="labShowGraph">${icon('graph', 'icon-sm')}Show on the integrity graph</button>` : ''}
        <span class="spacer"></span>
        <a class="btn btn-ghost" href="${lab.context?.link_id ? routeHash('matches', { match: lab.context.link_id }) : routeHash('import')}" id="labOfficial">${icon('arrow-right', 'icon-sm')}${lab.context?.link_id ? 'Back to the comparison' : 'Corrections workflow'}</a>
        <button type="button" class="btn btn-secondary" id="labDiscard2">${icon('trash', 'icon-sm')}Discard simulation</button>
      </div>
    </section>`;
}

/* ── Interaction ──────────────────────────────── */
function labReadForm() {
  lab.staged = { record_id: $('#labRecord')?.value || '', field: $('#labField')?.value || '', value: $('#labValue')?.value || '', kind: $('#labKind')?.value || '', reference: $('#labReference')?.value || '' };
}

function labShowError(message) {
  const el = $('#labError');
  el.innerHTML = `${icon('alert-octagon', 'icon-sm')}<span>${esc(message)}</span>`;
  el.hidden = false;
}

function labBind() {
  $('#labRecord')?.addEventListener('change', async () => { labReadForm(); await labLoadRecords(labContextRecords()); labRender(); $('#labRecord').focus(); });
  $('#labField')?.addEventListener('change', () => { labReadForm(); lab.staged.value = ''; labRender(); $('#labField').focus(); });
  $('#labReturn').addEventListener('click', () => labClose());
  [$('#labDiscard'), $('#labDiscard2')].forEach(button => button?.addEventListener('click', () => { labDiscard(); labRender(); $('#labValue')?.focus(); toast('The simulation and its staged values were discarded. No record was changed, so nothing needed undoing.', { title: 'Simulation discarded' }); }));
  $('#labShowGraph')?.addEventListener('click', () => { gShowSimulation(lab.result.graph_overlay); labClose({ discard: false }); go('graph'); });
  $$('[data-lab-record]', $('#labBody')).forEach(button => button.addEventListener('click', () => hxRecordDialog(button.dataset.labRecord, button)));
  $('#labForm').addEventListener('submit', async event => {
    event.preventDefault();
    labReadForm();
    const s = lab.staged;
    if (!s.value.trim()) { labShowError('Enter the proposed value.'); $('#labValue').focus(); return; }
    if (!s.kind || s.reference.trim().length < 3) { labShowError('The source evidence is incomplete. Choose the evidence and say where it is held; a correction without source evidence cannot be assessed.'); (s.kind ? $('#labReference') : $('#labKind')).focus(); return; }
    $('#labError').hidden = true;
    const button = $('#labRun');
    try {
      const result = await withFeedback(button, () => api('/api/v1/simulations/correction', { method: 'POST', body: JSON.stringify({ record_id: s.record_id, field: s.field, value: s.value, evidence: { kind: s.kind, reference: s.reference }, context: lab.context }) }), { done: 'Simulated', failed: 'Not run' });
      lab.result = result.data;
      if (typeof gx !== 'undefined' && gx.sim) gExitSimulation({ silent: true });
      labRender();
      $('#labResultSection')?.focus();
    } catch (error) {
      if (error.status === 403 && error.readOnly) labShowError(error.message);
      else labShowError(error.message);
    }
  });
}

$('#labClose').addEventListener('click', () => labClose());
$('#labDialog').addEventListener('cancel', event => { event.preventDefault(); labClose(); });

/* ── Decision receipts ────────────────────────── */
const RECEIPT_STATUS = {
  verified: { label: 'Verified', tone: 'tone-success', icon: 'check-circle', text: 'The digest matches the receipt content and the audit entry records the same decision.' },
  mismatch: { label: 'Digest mismatch', tone: 'tone-danger', icon: 'alert-octagon', text: 'The receipt content was changed after it was written.' },
  audit_mismatch: { label: 'Audit mismatch', tone: 'tone-danger', icon: 'alert-triangle', text: 'The receipt is intact, but the audit entry no longer records the same decision.' },
  invalid: { label: 'Invalid', tone: 'tone-danger', icon: 'alert-octagon', text: 'The receipt does not follow the receipt schema.' },
  missing: { label: 'No receipt', tone: 'tone-neutral', icon: 'info', text: 'No receipt is recorded for this decision.' }
};
const RECEIPT_KIND = { identity_match_decision: 'Identity match decision', finding_review_decision: 'Finding review decision', correction_decision: 'Correction decision' };

async function receiptOpen(id, opener) {
  const dialog = $('#receiptDialog');
  dialog.dataset.receiptId = id; /* not data-receipt: that attribute opens a receipt on click */
  receiptOpen.opener = opener || document.activeElement;
  if (!dialog.open) dialog.showModal();
  $('#receiptBody').innerHTML = skeletonLines(8);
  try {
    const data = (await api(`/api/v1/receipts/${encodeURIComponent(id)}`)).data;
    if (dialog.dataset.receiptId !== id) return;
    $('#receiptBody').innerHTML = receiptHtml(data);
    $('#receiptVerify').addEventListener('click', event => receiptVerify(event.currentTarget, id));
  } catch (error) {
    $('#receiptBody').innerHTML = errorState(error.message);
  }
}

async function receiptVerify(button, id) {
  try {
    const data = await withFeedback(button, async () => (await api(`/api/v1/receipts/${encodeURIComponent(id)}`)).data, { done: 'Checked', failed: 'Check failed' });
    $('#receiptStatus').innerHTML = receiptStatusHtml(data.verification);
    toast(`${RECEIPT_STATUS[data.verification.status]?.label || data.verification.status}: ${data.verification.detail}`, { tone: data.verification.status === 'verified' ? 'success' : 'error', title: 'Receipt re-verified' });
  } catch (error) { toast(error.message, { tone: 'error', title: 'Verification unavailable' }); }
}

function receiptStatusHtml(v) {
  const meta = RECEIPT_STATUS[v.status] || RECEIPT_STATUS.invalid;
  return `<div class="callout ${v.status === 'verified' ? 'success' : v.status === 'missing' ? 'info' : 'danger'}">${icon(meta.icon)}<div><strong>${esc(meta.label)}.</strong> ${esc(v.detail || meta.text)}
    <dl class="gp-kv receipt-digest"><dt>Stored SHA-256</dt><dd class="mono">${esc(v.stored_digest || '—')}</dd><dt>Recomputed</dt><dd class="mono">${esc(v.recomputed_digest || '—')}</dd><dt>Audit entry</dt><dd>${esc((v.audit?.status || '—').replaceAll('_', ' '))}</dd></dl>
    ${(v.sources || []).length ? `<p class="subtle">Source versions: ${esc(v.sources.map(s => `${s.record_id} ${s.status.replaceAll('_', ' ')}`).join(' · '))}</p>` : ''}</div></div>`;
}

function receiptHtml({ receipt: r, verification, limitations }) {
  const cmp = r.field_comparison || {};
  const fields = cmp.identity_links ? cmp.identity_links : [cmp];
  return `
    <div id="receiptStatus">${receiptStatusHtml(verification)}</div>
    <dl class="kv rd-prov">
      <div><dt>Receipt</dt><dd class="mono">${esc(r.receipt_id)} · schema ${esc(r.schema)} v${esc(r.schema_version)}</dd></div>
      <div><dt>Decision</dt><dd>${esc(RECEIPT_KIND[r.kind] || r.kind)} · <strong>${esc(String(r.action.decision).replaceAll('_', ' '))}</strong></dd></div>
      <div><dt>Recorded</dt><dd>${esc(fmtDate(r.decided_at))} <span class="mono subtle">${esc(r.decided_at)}</span></dd></div>
      <div><dt>User</dt><dd>${esc(r.actor.name)} · ${esc(r.actor.role)} · <span class="subtle">${esc(r.actor.authentication)}</span></dd></div>
      <div><dt>State</dt><dd>${esc(String(r.previous_state ?? '—').replaceAll('_', ' '))} → ${esc(String(r.resulting_state ?? '—').replaceAll('_', ' '))}</dd></div>
      <div><dt>Deterministic outcome</dt><dd>${esc(String(r.deterministic_outcome ?? '—').replaceAll('_', ' '))}</dd></div>
      <div><dt>Policy</dt><dd>${esc(r.policy.identity_policy)}${r.policy.finding_rule_version ? ` · rule ${esc(r.policy.finding_rule_version)}` : ''}</dd></div>
      <div><dt>Note</dt><dd>${esc(r.action.note || '—')}</dd></div>
      <div><dt>Audit entry</dt><dd class="mono">${esc(r.audit.store)} ${esc(r.audit.event_id || r.audit.key || '—')}</dd></div>
    </dl>
    <h3 class="rd-h">Source records at decision time</h3>
    <div class="table-scroll"><table class="data-table compact"><thead><tr><th scope="col">Record</th><th scope="col">Version</th><th scope="col">Provenance</th><th scope="col">Content SHA-256</th></tr></thead><tbody>
      ${r.source_records.map(s => `<tr><td class="mono">${esc(s.record_id)}</td><td>v${esc(s.version)} · ${esc(String(s.relation).replaceAll('_', ' '))}</td><td>${esc(s.institution_code)} · ${esc(s.source_file)} row ${esc(s.source_row)}${s.import_batch ? ` · ${esc(s.import_batch)}` : ''}</td><td class="mono" title="${esc(s.content_sha256)}">${esc(String(s.content_sha256).slice(0, 16))}…</td></tr>`).join('')}
    </tbody></table></div>
    <h3 class="rd-h">Field comparison</h3>
    ${cmp.changes ? `<ul class="hx-plain">${cmp.changes.map(c => `<li><strong>${esc(c.field.replaceAll('_', ' '))}</strong> ${esc(c.kind)}: <span class="mono">${esc(c.from ?? '—')}</span> → <span class="mono">${esc(c.to ?? '—')}</span></li>`).join('')}</ul>`
      : fields.filter(Boolean).map(l => `<dl class="gp-kv"><dt>Pair</dt><dd class="mono">${esc(l.link_id || '—')}</dd><dt>Outcome</dt><dd>${esc(LAB_OUTCOME[l.outcome] || l.outcome || '—')}</dd><dt>Agree</dt><dd>${esc((l.agreeing_fields || []).join(', ') || 'none')}</dd><dt>Conflict</dt><dd>${esc((l.conflicting_fields || []).join(', ') || 'none')}</dd><dt>Missing</dt><dd>${esc((l.missing_fields || []).join(', ') || 'none')}</dd></dl>`).join('') || `<p class="muted">${esc(cmp.note || 'No pairwise comparison.')}</p>`}
    <details class="lab-rule"><summary>Canonical serialisation and digest</summary><p>${esc(r.integrity.canonicalization)}: JSON with object keys sorted, no whitespace, arrays in stored order. The SHA-256 digest covers ${esc(r.integrity.covers)}.</p><p class="mono">${esc(r.integrity.digest)}</p></details>
    <h3 class="rd-h">Limits of this receipt</h3>
    <ul class="lab-caveats">${limitations.map(l => `<li>${icon('info', 'icon-xs')}${esc(l)}</li>`).join('')}</ul>
    <div class="rd-actions"><button type="button" class="btn btn-secondary btn-sm" id="receiptVerify">${icon('rotate', 'icon-sm')}Verify again</button></div>`;
}

$('#receiptClose').addEventListener('click', () => { $('#receiptDialog').close(); receiptOpen.opener?.focus?.(); });

/* Entry points anywhere in the app: finding drawer, match detail, audit history. */
document.addEventListener('click', event => {
  const finding = event.target.closest('[data-lab-finding]');
  if (finding) { labOpen({ finding_id: finding.dataset.labFinding }, finding); return; }
  const link = event.target.closest('[data-lab-link]');
  if (link) { labOpen({ link_id: link.dataset.labLink }, link); return; }
  const receipt = event.target.closest('[data-receipt]');
  if (receipt) receiptOpen(receipt.dataset.receipt, receipt);
});
