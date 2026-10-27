// Evidence Impact Lab: what one source-backed correction to one source record would change.
//
// Nothing here re-implements a rule. A simulation runs the official correction workflow — the
// institution re-sends the row with the corrected value (commitImport: lineage classification,
// reconciliation, identity policy auto-link-2, automation), and, when lineage proposes a
// correction candidate, a reviewer confirms it (decideCorrection + processAll, exactly as
// POST /api/v1/corrections/:id/decision does) — on a structuredClone of the data. A second clone
// runs the same pipeline without the change, and the report is the difference between the two.
//
// Isolation: every step mutates only its clone. Both clones are dropped when the call returns.
// Nothing is saved, no receipt is created, no model is called, and the caller's `db` is never
// written (tests compare it byte for byte). The report holds no new random ids or wall-clock
// times, so the same state and the same staged change always give the same report.
const { mask, canAccess, isCurrent, isActiveRecord, allowedFinding, CAPACITY_RULE } = require('./engine');
const { commitImport, processAll } = require('./pipeline');
const { decideCorrection } = require('./lineage');
const { AUTO_LINK_POLICY, usableId } = require('./identity');
const { decisionFor, REVIEWABLE, DECISIONS } = require('./matches');
const { integrityGraph } = require('./graph');
const { assessFinding } = require('./assessment');

const SIMULATION_LABEL = 'SIMULATION ONLY — NO AUTHORITATIVE RECORD CHANGED';
const SIMULATED_FILE = 'simulated-correction.csv';
const ROW_FIELDS = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'institution_name', 'programme', 'academic_session', 'admission_year', 'enrolment_status', 'seat_category', 'source_reference'];
const STATUSES = ['active', 'transferred', 'completed', 'withdrawn'];
const clean = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');

// Fields a reviewer may stage, with the same normalisation the engine applies and a format check.
// The check only rejects values the engine could not use; it says nothing about whether a value is true.
const FIELDS = {
  apaar_id: { label: 'APAAR identifier', identity: true, parse: v => { const s = clean(v).replace(/[\s-]/g, ''); return /^\d{12}$/.test(s) ? s : new Error('An APAAR identifier must be 12 digits after removing spaces and hyphens.'); } },
  student_name: { label: 'Student name', identity: true, parse: v => { const s = clean(v); return s.length >= 2 && s.length <= 120 && /\p{L}/u.test(s) && /^[\p{L}\p{M}\p{N} .'-]+$/u.test(s) ? s : new Error('A student name must be 2–120 characters: letters (digits allowed), spaces, apostrophes, hyphens or full stops.'); } },
  date_of_birth: { label: 'Date of birth', identity: true, parse: v => parseDate(clean(v)) },
  programme: { label: 'Programme', identity: false, parse: v => { const s = clean(v).toUpperCase(); return s.length >= 2 && s.length <= 60 && /^[A-Z0-9][A-Z0-9 &().\/-]*$/.test(s) ? s : new Error('A programme must be 2–60 letters, digits, spaces or & ( ) . / -.'); } },
  academic_session: { label: 'Academic session', identity: false, parse: v => { const m = clean(v).match(/^(\d{4})-(\d{2})$/); return m && (Number(m[1]) + 1) % 100 === Number(m[2]) ? m[0] : new Error('An academic session must look like 2026-27.'); } },
  enrolment_status: { label: 'Enrolment status', identity: false, parse: v => { const s = clean(v).toLocaleLowerCase('en-IN'); return STATUSES.includes(s) ? s : new Error(`An enrolment status must be one of ${STATUSES.join(', ')}.`); } }
};
const EVIDENCE_KINDS = {
  institution_resubmission: 'Corrected file or row from the source institution',
  institution_record: 'The institution\'s own student record (registrar or admission file)',
  authorised_document: 'An authorised identity or admission document seen by the institution'
};

class LabError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

function parseDate(raw) {
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/); const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const [y, m, d] = dmy ? [dmy[3], dmy[2], dmy[1]].map(Number) : iso ? [iso[1], iso[2], iso[3]].map(Number) : [];
  if (!y) return new Error('A date of birth must be DD/MM/YYYY or YYYY-MM-DD.');
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return new Error('That date of birth is not a real calendar date.');
  if (y < 1900 || date.getTime() > Date.now()) return new Error('A date of birth must be between 1900 and today.');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const shown = (field, value) => (field === 'apaar_id' ? (value ? mask(value) : 'Not provided') : value || 'Not provided');
const stateOfValue = (field, value) => (!value ? 'missing' : field === 'apaar_id' && !/^\d{12}$/.test(value) ? 'malformed' : 'present');

// ── Input validation: everything is checked before any copy is made ───────────────
function stageCorrection(db, p, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new LabError(400, 'The simulation request must be an object.', 'invalid_request');
  const record = typeof input.record_id === 'string' ? db.sourceRecords.find(r => r.id === input.record_id) : null;
  // Missing and out-of-scope records get the same answer, so a rejection reveals nothing.
  if (!record || !canAccess(p, record)) throw new LabError(404, 'Source record not found.', 'record_not_found');
  if (!isActiveRecord(record)) throw new LabError(409, `This version was already superseded by ${record.superseded_by}. Simulate against the current version instead.`, 'record_superseded');
  const spec = FIELDS[input.field];
  if (!spec) throw new LabError(400, `Unsupported field. Use one of: ${Object.keys(FIELDS).join(', ')}.`, 'unsupported_field');
  if (typeof input.value !== 'string' || !input.value.trim()) throw new LabError(400, 'Enter the proposed value. A simulation never removes a value.', 'missing_value');
  const value = spec.parse(input.value);
  if (value instanceof Error) throw new LabError(400, value.message, 'malformed_value');
  if (value === String(record[input.field] ?? '')) throw new LabError(400, 'The proposed value is the same as the current value, so there is nothing to simulate.', 'no_change');
  const evidence = input.evidence || {};
  if (!EVIDENCE_KINDS[evidence.kind]) throw new LabError(400, 'Choose the source evidence that supports the proposed value.', 'missing_provenance');
  const reference = clean(evidence.reference);
  if (reference.length < 3 || reference.length > 200) throw new LabError(400, 'Describe where the evidence is held (3–200 characters), for example a registrar letter reference.', 'missing_provenance');
  if (/\d{12}/.test(reference.replace(/[\s-]/g, ''))) throw new LabError(400, 'Do not put identifiers in the evidence reference; describe the document instead.', 'provenance_contains_identifier');
  const context = resolveContext(db, p, input.context);
  return { record, field: input.field, value, evidence: { kind: evidence.kind, kind_label: EVIDENCE_KINDS[evidence.kind], reference }, context };
}

function resolveContext(db, p, context) {
  if (!context) return null;
  if (context.finding_id) {
    const f = db.findings.find(x => x.id === context.finding_id);
    if (!f || !allowedFinding(f, db, p)) throw new LabError(404, 'Finding not found.', 'context_not_found');
    return { kind: 'finding', id: f.id };
  }
  if (context.link_id) {
    const l = (db.identityLinks || []).find(x => x.id === context.link_id);
    const records = new Map(db.sourceRecords.map(r => [r.id, r]));
    if (!l || !l.records.every(id => records.get(id) && canAccess(p, records.get(id)))) throw new LabError(404, 'Potential match not found.', 'context_not_found');
    return { kind: 'link', id: l.id };
  }
  return null;
}

// A deterministic "now" for the simulated run: just after the latest event in the data.
function simulationTime(db) {
  const times = [
    ...(db.importBatches || []).map(b => b.created_at), ...(db.auditEvents || []).map(e => e.at), ...(db.automationRuns || []).map(r => r.at),
    ...(db.lineageEvents || []).map(e => e.at), ...Object.values(db.matchDecisions || {}).map(d => d.at), ...(db.notifications || []).map(n => n.created_at),
    ...(db.findings || []).flatMap(f => [f.created_at, f.lifecycle_changed_at, f.last_validated_at])
  ].map(t => Date.parse(t)).filter(Number.isFinite);
  return new Date((times.length ? Math.max(...times) : Date.parse('2026-01-01T00:00:00.000Z')) + 60000).toISOString();
}

// ── State views (shared by the report, the checklist and the overlay) ─────────────
function view(state, p, original, canonOf = id => id) {
  const records = new Map(state.sourceRecords.map(r => [r.id, r]));
  const ref = id => {
    const canon = canonOf(id); const r = records.get(id);
    if (!r) return { record_id: canon, available: false };
    return { record_id: canon, institution_code: r.institution_code, source_file: r.source_file, source_row: r.source_row, ...(canon !== id ? { simulated_version: true } : {}), ...(!original.records.has(id) && canon === id ? { hypothetical: true } : {}) };
  };
  const visibleRecord = id => { const r = records.get(id); return Boolean(r && canAccess(p, r)); };
  const evidenceKey = ids => [...new Set(ids.map(canonOf))].sort().join('|');
  const finding = f => ({
    finding_id: original.findings.has(f.id) ? f.id : null, rule_code: f.rule_code, title: f.title, category: f.category, severity: f.severity,
    review_status: f.review_status, lifecycle_status: f.lifecycle_status || 'current', processing_outcome: f.automation?.outcome || null,
    automated: Boolean(f.decision?.automated), evidence: [...new Set(f.evidence.map(canonOf))].map(id => ref(f.evidence.find(x => canonOf(x) === id)))
  });
  const link = l => {
    const ids = [...new Set(l.records.map(canonOf))].sort();
    if (ids.length < 2) return null;
    const d = decisionFor(state, l);
    return {
      pair_key: ids.join('|'), link_id: original.links.has(l.id) ? l.id : null, records: l.records.map(ref), method: l.method, outcome: l.outcome, reason: l.reason,
      agreeing_fields: l.agreeing_fields, similar_fields: l.similar_fields || [], conflicting_fields: l.conflicting_fields, missing_fields: l.missing_fields,
      disqualifiers: l.disqualifiers || [], competing_candidates: l.competing_candidates || 0, withdrawn: Boolean(l.withdrawn), policy_version: l.policy_version,
      decision: d ? { decision: d.decision, label: DECISIONS[d.decision]?.label || d.decision, final: Boolean(DECISIONS[d.decision]?.final) } : null
    };
  };
  const currentFindings = state.findings.filter(f => isCurrent(f) && allowedFinding(f, state, p));
  const links = new Map();
  for (const l of state.identityLinks || []) {
    if (!l.records.every(visibleRecord)) continue;
    const v = link(l);
    if (v && (!links.has(v.pair_key) || links.get(v.pair_key).outcome === 'same_source_record')) links.set(v.pair_key, v);
  }
  return { state, original, records, ref, evidenceKey, finding, currentFindings, links, visibleRecord, canonOf };
}

// ── Before/after comparison ───────────────────────────────────────────────────────
function compareFindings(base, sim, focus) {
  const B = base.currentFindings.map(f => ({ f, key: f.rule_code === CAPACITY_RULE ? `cap|${f.condition_key}` : base.evidenceKey(f.evidence) }));
  const S = sim.currentFindings.map(f => ({ f, key: f.rule_code === CAPACITY_RULE ? `cap|${f.condition_key}` : sim.evidenceKey(f.evidence) }));
  const pairs = []; const usedB = new Set(); const usedS = new Set();
  const pass = (test, kind) => B.forEach(b => { if (usedB.has(b)) return; const s = S.find(x => !usedS.has(x) && test(b, x)); if (s) { usedB.add(b); usedS.add(s); pairs.push({ b, s, kind }); } });
  pass((b, s) => b.f.rule_code === s.f.rule_code && b.key === s.key, 'same');
  pass((b, s) => b.f.rule_code === s.f.rule_code && b.f.condition_key && b.f.condition_key === s.f.condition_key, 'evidence_changed');
  pass((b, s) => b.f.rule_code !== s.f.rule_code && (b.key === s.key || (b.f.condition_key && b.f.condition_key === s.f.condition_key)), 'reclassified');
  const touches = f => f.evidence.some(id => focus.has(base.canonOf(id)) || focus.has(sim.canonOf(id)));
  const open = f => f.review_status !== 'resolved';
  const out = { resolved: [], remain_open: [], created: [], reclassified: [], reopened: [], superseded: [], other_open_unchanged: 0 };
  for (const { b, s, kind } of pairs) {
    const before = base.finding(b.f); const after = sim.finding(s.f);
    if (kind === 'reclassified') { out.reclassified.push({ before, after, rule: `${b.f.rule_code} → ${s.f.rule_code}`, reason: assessFinding(sim.state, s.f).summary }); continue; }
    const recomputed = b.f.id !== s.f.id || kind === 'evidence_changed';
    if (open(b.f) && !open(s.f)) out.resolved.push({ before, after, how: s.f.decision?.automated ? 'automatically_matched' : 'resolved', reason: s.f.decision?.note || null });
    else if (!open(b.f) && open(s.f)) {
      const later = sim.state.findings.find(f => f.id === b.f.id);
      const reason = b.f.decision?.automated && s.f.id === b.f.id ? 'The automatic match no longer satisfies the policy; the finding returns to manual review.'
        : later?.lifecycle_status === 'superseded' ? `${later.lifecycle_reason} The earlier review outcome stays with the superseded finding in the history; the recomputed finding starts pending.`
        : 'The finding returns to manual review in the simulated state.';
      out.reopened.push({ before, after, reason });
    }
    else if (open(b.f) && open(s.f)) { if (touches(b.f) || touches(s.f)) out.remain_open.push({ before, after, recomputed, evidence_changed: kind === 'evidence_changed' || b.key !== s.key }); else out.other_open_unchanged++; }
  }
  const simById = new Map(sim.state.findings.map(f => [f.id, f]));
  for (const b of B.filter(x => !usedB.has(x))) {
    const later = simById.get(b.f.id);
    const how = later?.lifecycle_status === 'cleared' ? (later.lifecycle_cause === 'correction' ? 'cleared_by_correction' : 'cleared') : later?.lifecycle_status === 'superseded' ? 'superseded' : 'no_longer_generated';
    out.resolved.push({ before: base.finding(b.f), after: null, how, reason: later?.lifecycle_reason || 'The rule no longer produces this condition in the simulated state.' });
  }
  for (const s of S.filter(x => !usedS.has(x))) out.created.push({ after: sim.finding(s.f), reason: assessFinding(sim.state, s.f).summary });
  for (const b of B) { const later = simById.get(b.f.id); if (later?.lifecycle_status === 'superseded') out.superseded.push({ before: base.finding(b.f), reason: later.lifecycle_reason }); }
  return out;
}

const FIELD_OF = { identifier: 'apaar_id', student_name: 'student_name', date_of_birth: 'date_of_birth' };
function compareLinks(base, sim, focus) {
  const touches = l => l.pair_key.split('|').some(id => focus.has(id));
  const fieldsDiffer = (a, b) => ['agreeing_fields', 'similar_fields', 'conflicting_fields', 'missing_fields', 'disqualifiers'].some(k => [...a[k]].sort().join() !== [...b[k]].sort().join());
  const out = { unresolved_remaining: [], changed: [], new_pairs: [], no_longer_compared: [], competing: [], contradicted: [], withdrawn: [], decisions_no_longer_applying: [] };
  for (const [key, b] of base.links) {
    const s = sim.links.get(key);
    if (!s) { if (touches(b)) { out.no_longer_compared.push({ before: b }); if (b.decision) out.decisions_no_longer_applying.push({ pair: b.records, decision: b.decision, reason: 'The pair is no longer compared in the simulated state; the decision stays in the history.' }); } continue; }
    const changed = b.outcome !== s.outcome || fieldsDiffer(b, s) || b.withdrawn !== s.withdrawn || b.competing_candidates !== s.competing_candidates || Boolean(b.decision) !== Boolean(s.decision);
    if (changed) out.changed.push({ before: b, after: s });
    else if (REVIEWABLE.has(s.outcome) && !s.decision?.final && touches(s)) out.unresolved_remaining.push({ pair: s });
    if (b.decision && !s.decision) out.decisions_no_longer_applying.push({ pair: s.records, decision: b.decision, reason: 'Reviewer decisions are keyed to the identity evidence of both records; once that evidence changes the decision no longer applies to the pair and it returns to review. The decision stays in the history.' });
    if (s.withdrawn && !b.withdrawn) out.withdrawn.push({ pair: s, reason: s.reason });
    const gained = s.conflicting_fields.filter(f => !b.conflicting_fields.includes(f));
    if (gained.length) out.contradicted.push({ pair: s, fields: gained, reason: s.reason });
  }
  for (const [key, s] of sim.links) {
    if (base.links.has(key)) continue;
    if (!touches(s)) continue;
    out.new_pairs.push({ after: s });
    if (s.conflicting_fields.length) out.contradicted.push({ pair: s, fields: s.conflicting_fields, reason: s.reason });
  }
  for (const s of sim.links.values()) if (s.competing_candidates && touches(s)) out.competing.push({ pair: s });
  const extra = (sim.state.identityLinkEvents || []).slice((base.state.identityLinkEvents || []).length).filter(e => e.action === 'automatic_link_withdrawn');
  extra.forEach(e => { const ids = [...new Set(e.records.map(sim.canonOf))]; if (ids.every(id => sim.visibleRecord(id) || base.visibleRecord(id))) out.withdrawn.push({ pair: { pair_key: ids.sort().join('|'), records: e.records.map(sim.ref) }, reason: e.reason }); });
  return out;
}

function compareEvidence(base, sim, staged, version, focus) {
  const before = staged.record[staged.field] || '';
  const after = version ? version[staged.field] || '' : staged.value;
  const out = { staged_field: { field: staged.field, label: FIELDS[staged.field].label, before: shown(staged.field, before), after: shown(staged.field, after), before_state: stateOfValue(staged.field, before), after_state: stateOfValue(staged.field, after) }, populated: [], conflicts_remaining: [], newly_supporting: [], newly_conflicting: [], still_insufficient: [], records_affected: [] };
  for (const [key, s] of sim.links) {
    if (!key.split('|').some(id => focus.has(id))) continue;
    const b = base.links.get(key);
    for (const field of ['identifier', 'student_name', 'date_of_birth']) {
      const was = b ? (b.agreeing_fields.includes(field) ? 'agree' : b.conflicting_fields.includes(field) ? 'conflict' : b.missing_fields.includes(field) ? 'missing' : b.similar_fields.includes(field) ? 'similar' : null) : null;
      const now = s.agreeing_fields.includes(field) ? 'agree' : s.conflicting_fields.includes(field) ? 'conflict' : s.missing_fields.includes(field) ? 'missing' : s.similar_fields.includes(field) ? 'similar' : null;
      const item = { pair: s.records, field: FIELD_OF[field], result_before: was, result_after: now };
      if (was === 'missing' && now && now !== 'missing') out.populated.push(item);
      if (was === 'conflict' && now === 'conflict') out.conflicts_remaining.push(item);
      if (was !== 'agree' && now === 'agree') out.newly_supporting.push(item);
      if (was !== 'conflict' && now === 'conflict') out.newly_conflicting.push(item);
      if (now === 'missing') out.still_insufficient.push({ ...item, reason: `${FIELD_OF[field].replaceAll('_', ' ')} is missing on at least one record of this pair.` });
    }
    s.disqualifiers.forEach(d => out.still_insufficient.push({ pair: s.records, field: null, result_before: null, result_after: d, reason: `Policy disqualifier: ${d.replaceAll('_', ' ')}.` }));
  }
  // Records whose processing status differs: the corrected record and anything it is compared with.
  const status = (v, id) => v.records.get(id)?.processing?.status || null;
  const ids = new Set([...base.records.keys()].filter(base.visibleRecord));
  for (const id of ids) {
    const simId = id === staged.record.id && version && sim.canonOf(version.id) === id ? version.id : id;
    const was = status(base, id); const now = status(sim, simId);
    if (was !== now || id === staged.record.id) out.records_affected.push({ record: base.ref(id), before: was, after: now });
  }
  if (version && sim.canonOf(version.id) === version.id) out.records_affected.push({ record: sim.ref(version.id), before: null, after: status(sim, version.id) });
  return out;
}

// ── Rule-derived evidence checklist ───────────────────────────────────────────────
// Every item names the rule condition it comes from (validate() in src/engine.js, reconcile() and
// policy auto-link-2 in src/identity.js). Items describe what must be verified and where; they never
// carry a value, and they never suggest copying a value from another record.
const POLICY = AUTO_LINK_POLICY.conditions;
const VERIFY_SOURCE = 'The source institution\'s own student record (admission or registrar file), re-sent in a corrected file with the institution reference.';
function idState(r) { return !r.apaar_id ? 'missing' : usableId(r) ? 'usable' : 'malformed'; }

function linkChecklist(v, l) {
  const [a, b] = l.records.map(id => v.records.get(id));
  if (!a || !b) return { items: [], limitations: ['A record of this pair is not available in your access scope.'] };
  const refs = [v.ref(a.id), v.ref(b.id)];
  const items = [];
  const sa = idState(a); const sb = idState(b);
  const idS = sa === 'usable' && sb === 'usable' ? (usableId(a) === usableId(b) ? 'supporting' : 'conflicting') : sa === 'missing' || sb === 'missing' ? 'missing' : 'not_comparable';
  items.push({ field: 'apaar_id', label: 'APAAR identifier', state: idS, per_record: [{ record: refs[0], state: sa }, { record: refs[1], state: sb }],
    rule: { id: `${AUTO_LINK_POLICY.version}#1`, text: POLICY[0] },
    blocker: idS !== 'supporting',
    verify: idS === 'missing' ? 'Obtain the APAAR ID for each record that lacks one from its own institution. If both then carry the same well-formed identifier the policy can compare them; different identifiers mean different students.'
      : idS === 'not_comparable' ? 'A malformed identifier is never identifier evidence. The institution must re-send the identifier as issued (12 digits).'
      : idS === 'conflicting' ? 'The records carry different well-formed identifiers, which the policy treats as different students. Verify each identifier at its source before any other conclusion.'
      : 'The well-formed identifiers agree (protected fingerprint comparison; local format check only, not APAAR verification).',
    source: VERIFY_SOURCE });
  const name = l.name_comparison?.result;
  const nameState = name === 'exact' || name === 'equivalent' ? 'supporting' : name === 'missing' ? 'missing' : name === 'conflict' ? 'conflicting' : 'not_comparable';
  items.push({ field: 'student_name', label: 'Student name', state: nameState, per_record: [{ record: refs[0], state: a.student_name ? 'present' : 'missing' }, { record: refs[1], state: b.student_name ? 'present' : 'missing' }],
    rule: { id: `${AUTO_LINK_POLICY.version}#2`, text: POLICY[1] }, blocker: nameState !== 'supporting',
    verify: nameState === 'not_comparable' ? 'The names are similar but not identical or equivalent (for example an initial). Verify the name as recorded by each institution; similarity alone never links records.'
      : nameState === 'conflicting' ? 'The names differ. Verify which name each institution holds for the student; do not change a name to match the other record.'
      : nameState === 'missing' ? 'A name is missing. Obtain it from the institution\'s record.' : 'The names agree after the documented comparison folding.',
    source: VERIFY_SOURCE });
  const dobState = !a.date_of_birth || !b.date_of_birth ? 'missing' : a.date_of_birth === b.date_of_birth ? 'supporting' : 'conflicting';
  items.push({ field: 'date_of_birth', label: 'Date of birth', state: dobState, per_record: [{ record: refs[0], state: a.date_of_birth ? 'present' : 'missing' }, { record: refs[1], state: b.date_of_birth ? 'present' : 'missing' }],
    rule: { id: `${AUTO_LINK_POLICY.version}#3`, text: POLICY[2] }, blocker: dobState !== 'supporting',
    verify: dobState === 'missing' ? 'A date of birth is missing. Obtain it from that institution\'s record; it is never inferred from the other record.'
      : dobState === 'conflicting' ? 'The dates of birth differ. Verify each against the institution\'s record; do not change one to match the other.'
      : 'The dates of birth agree after normalisation.',
    source: VERIFY_SOURCE });
  if (l.method === 'protected_identifier_exact' && l.outcome === 'needs_investigation' && !(l.disqualifiers || []).length) {
    const fp = a.apaar_fingerprint;
    const others = v.state.sourceRecords.filter(r => isActiveRecord(r) && r.apaar_fingerprint === fp && r.id !== a.id && r.id !== b.id && v.visibleRecord(r.id));
    items.push({ field: 'identifier_group', label: 'Other records sharing the identifier', state: 'conflicting', per_record: others.map(r => ({ record: v.ref(r.id), state: 'differs' })),
      rule: { id: `${AUTO_LINK_POLICY.version}#4`, text: POLICY[3] }, blocker: true,
      verify: 'Another record sharing this identifier has a different name or date of birth, so the identifier cannot safely link any record in the group until that record is verified.', source: VERIFY_SOURCE });
  }
  if (l.competing_candidates) items.push({ field: 'competing_candidates', label: 'Competing candidates', state: 'conflicting', per_record: [],
    rule: { id: 'candidate-blocking', text: 'A record proposed against more than one other record is ambiguous; at most one pairing can be right (src/identity.js, competing candidates).' }, blocker: false,
    verify: `${l.competing_candidates} records are equally plausible candidates. A usable identifier on each is needed to tell them apart.`, source: VERIFY_SOURCE });
  const limitations = ['Local format checks only: no authoritative APAAR verification is connected.'];
  if (l.method === 'name_dob_similarity') limitations.push('Name and date of birth never link records on their own under the policy; a shared usable identifier is required for any automatic association.');
  return { items, limitations };
}

const VALIDATION_RULES = { APAAR_MISSING: 'missing', APAAR_MALFORMED: 'not_comparable', REQUIRED_FIELD_MISSING: 'missing' };
function findingChecklist(v, f) {
  const refs = f.evidence.filter(v.visibleRecord).map(v.ref);
  if (VALIDATION_RULES[f.rule_code]) {
    const field = f.field || 'apaar_id';
    return { items: [{ field, label: FIELDS[field]?.label || field.replaceAll('_', ' '), state: VALIDATION_RULES[f.rule_code], per_record: refs.map(record => ({ record, state: VALIDATION_RULES[f.rule_code] === 'missing' ? 'missing' : 'malformed' })),
      rule: { id: `validate/${f.rule_code}`, text: f.rule_code === 'APAAR_MISSING' ? 'validate(): an empty APAAR identifier raises APAAR_MISSING.' : f.rule_code === 'APAAR_MALFORMED' ? 'validate(): an identifier that is not 12 digits after removing spaces and hyphens raises APAAR_MALFORMED.' : `validate(): ${field} is a required value.` },
      blocker: true, verify: f.automation?.required_action || 'The institution must supply the value in a corrected file.', source: VERIFY_SOURCE }], limitations: ['The finding clears only when a corrected version of the source row is stored; the value is never inferred.'] };
  }
  if (f.rule_code === CAPACITY_RULE) return { items: [], limitations: ['This finding depends on the configured prototype capacity and on how many active enrolments are counted. No single field correction is required, and EduTrace cannot decide which records should count. Review the configured limit and the counted records.'] };
  if (f.rule_code === 'POTENTIAL_CONCURRENT_ENROLMENT') {
    const recs = f.evidence.map(id => v.records.get(id)).filter(r => r && v.visibleRecord(r.id));
    return { items: [
      { field: 'apaar_id', label: 'APAAR identifier', state: 'supporting', per_record: recs.map(r => ({ record: v.ref(r.id), state: idState(r) })), rule: { id: 'reconcile/POTENTIAL_CONCURRENT_ENROLMENT', text: 'The same well-formed identifier occurs in active enrolments at more than one institution in the same session.' }, blocker: false, verify: 'The shared identifier is what raises this finding (local format check only).', source: VERIFY_SOURCE },
      { field: 'enrolment_status', label: 'Enrolment status and session', state: 'conflicting', per_record: recs.map(r => ({ record: v.ref(r.id), state: `${r.enrolment_status} · ${r.academic_session}` })), rule: { id: 'reconcile/POTENTIAL_CONCURRENT_ENROLMENT', text: 'The condition holds while the records are active at different institutions in one session.' }, blocker: true, verify: f.automation?.required_action || 'Request transfer or approved dual-programme evidence from both institutions.', source: 'Transfer certificate or approved dual-programme letter from each institution.' }
    ], limitations: ['Whether the enrolment is legitimate (a transfer or an approved dual programme) is not held in any field; it needs documentary evidence and a reviewer decision.'] };
  }
  const links = (v.state.identityLinks || []).filter(l => (f.identity_link_ids || []).includes(l.id) && l.records.every(v.visibleRecord));
  if (!links.length) return { items: [], limitations: [`No rule dependency map is defined for ${f.rule_code} without an identity link; the checklist cannot be derived reliably.`] };
  const items = []; const seen = new Set(); const limitations = new Set();
  for (const l of links) {
    const c = linkChecklist(v, l);
    c.limitations.forEach(x => limitations.add(x));
    for (const item of c.items) {
      const key = `${item.field}|${item.state}|${item.per_record.map(x => x.record.record_id).sort().join(',')}`;
      if (!seen.has(key)) { seen.add(key); items.push({ ...item, link_id: v.original.links.has(l.id) ? l.id : null }); }
    }
  }
  if (f.review_status === 'resolved' && f.decision?.automated) limitations.add('This finding was resolved automatically under the policy; nothing blocks it.');
  return { items, limitations: [...limitations] };
}

function contextChecklist(v, context) {
  if (!context) return null;
  if (context.kind === 'finding') {
    const f = v.state.findings.find(x => x.id === context.id);
    if (!f) return { present: false, items: [], limitations: [] };
    return { present: true, ...findingChecklist(v, f) };
  }
  const l = (v.state.identityLinks || []).find(x => x.id === context.id);
  if (!l) return { present: false, items: [], limitations: [] };
  return { present: true, ...linkChecklist(v, l) };
}

// The current authoritative outcome of the finding or pair the lab was opened from.
function currentOutcome(v, context) {
  if (!context) return null;
  if (context.kind === 'finding') {
    const f = v.state.findings.find(x => x.id === context.id);
    const a = f && assessFinding(v.state, f);
    return f && { kind: 'finding', ...v.finding(f), required_action: f.automation?.required_action || null, explanation: a.summary, explanation_as_raised: f.explanation, raised_at: f.created_at || null, stale_original: a.stale_original };
  }
  const l = (v.state.identityLinks || []).find(x => x.id === context.id);
  const out = l && [...v.links.values()].find(x => x.link_id === l.id);
  return out && { kind: 'link', ...out };
}

// Public checklist for an existing finding or pair (GET, no simulation).
function evidenceChecklist(db, p, context) {
  const resolved = resolveContext(db, p, context);
  if (!resolved) throw new LabError(400, 'Name a finding or a potential match.', 'missing_context');
  const original = { records: new Set(db.sourceRecords.map(r => r.id)), findings: new Set(db.findings.map(f => f.id)), links: new Set((db.identityLinks || []).map(l => l.id)) };
  const v = view(db, p, original);
  return { context: resolved, current: currentOutcome(v, resolved), checklist: contextChecklist(v, resolved), fields: Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label, identity: f.identity })), evidence_kinds: Object.entries(EVIDENCE_KINDS).map(([key, label]) => ({ key, label })), label: SIMULATION_LABEL };
}

// ── Graph overlay ─────────────────────────────────────────────────────────────────
function graphOverlay(base, sim, p, staged, focusId, changedPairs = new Set()) {
  const g0 = integrityGraph(base.state, p); const g1 = integrityGraph(sim.state, p);
  const node = id => (id.startsWith('record:') ? `record:${sim.canonOf(id.slice(7))}` : id);
  const edgeKey = (e, map) => `${e.type}|${[map(e.source), map(e.target)].sort().join('|')}`;
  const before = new Map(g0.edges.filter(e => e.type !== 'source').map(e => [edgeKey(e, id => id), e]));
  const after = new Map(g1.edges.filter(e => e.type !== 'source').map(e => [edgeKey(e, node), e]));
  const pairLink = (a, b) => sim.links.get([a.slice(7), b.slice(7)].sort().join('|')) || null;
  const edges = [];
  for (const [key, e] of after) {
    if (before.has(key)) continue;
    const [source, target] = [node(e.source), node(e.target)];
    edges.push({ id: `sim:${key}`, source, target, change: 'added', relationship: e.type, evidence: { ...(e.evidence || {}), link: pairLink(source, target) } });
  }
  for (const [key, e] of before) {
    const pairKey = [e.source.slice(7), e.target.slice(7)].sort().join('|');
    if (!after.has(key)) edges.push({ id: `sim:${key}`, source: e.source, target: e.target, change: 'removed', relationship: e.type, authoritative_edge_id: e.id, evidence: { ...(e.evidence || {}), link: pairLink(e.source, e.target) } });
    // Kept, but the evidence behind it changes, or it touches the corrected record: marked as affected.
    else if (changedPairs.has(pairKey) || [e.source, e.target].includes(`record:${focusId}`)) edges.push({ id: `sim:affected:${key}`, source: e.source, target: e.target, change: 'affected', relationship: e.type, authoritative_edge_id: e.id, evidence: { ...(after.get(key).evidence || {}), link: pairLink(e.source, e.target), link_before: base.links.get(pairKey) || null } });
  }
  const nodes = new Map();
  // Finding ids that exist only in the simulated copy are random; only authoritative ids are passed on.
  const findingIds = f => ({ ...f, id: base.original.findings.has(f.id) ? f.id : null });
  const add = (id, graph, map) => { const n = graph.nodes.find(x => map(x.id) === id); if (n && !nodes.has(id)) nodes.set(id, { ...n, id, detail: n.detail ? { ...n.detail, id: id.startsWith('record:') ? id.slice(7) : n.detail.id, findings: (n.detail.findings || []).map(findingIds) } : n.detail, hypothetical: Boolean(n.detail && !base.records.has(id.slice(7))) }); };
  edges.forEach(e => [e.source, e.target].forEach(id => { add(id, g1, node); add(id, g0, x => x); }));
  add(`record:${focusId}`, g0, x => x); add(`record:${focusId}`, g1, node);
  if (!nodes.has(`record:${focusId}`)) {
    const r = base.records.get(focusId);
    nodes.set(`record:${focusId}`, { id: `record:${focusId}`, type: 'record', label: `${r.institution_code} · Row ${r.source_row}`, institution_code: r.institution_code, detail: { id: r.id, source_file: r.source_file, source_row: r.source_row, institution_code: r.institution_code, programme: r.programme, academic_session: r.academic_session, enrolment_status: r.enrolment_status, student_name: r.student_name, apaar_id: mask(r.apaar_id), findings: [], source_batch: r.import_id || 'Seeded demo data' }, hypothetical: false });
  }
  [...nodes.values()].filter(n => n.type === 'record').forEach(n => { const id = `institution:${n.institution_code}`; if (!nodes.has(id)) add(id, g0, x => x); if (!nodes.has(id)) add(id, g1, x => x); });
  return { label: SIMULATION_LABEL, focus: `record:${focusId}`, staged_field: staged.field, nodes: [...nodes.values()], edges, unchanged_relationships: [...after.keys()].filter(k => before.has(k)).length };
}

// ── Explanation, written from the comparison only ─────────────────────────────────
const RULE_NAMES = { APAAR_MISSING: 'Identifier missing', APAAR_MALFORMED: 'Identifier format', REQUIRED_FIELD_MISSING: 'Required value missing', DUPLICATE_IDENTIFIER: 'Repeated identifier', IDENTIFIER_ATTRIBUTE_CONFLICT: 'Identifier conflict', POTENTIAL_CONCURRENT_ENROLMENT: 'Concurrent enrolment', CANDIDATE_IDENTITY_MATCH: 'Candidate match', [CAPACITY_RULE]: 'Intake limit' };
const where = refs => refs.map(r => (r.hypothetical ? 'the simulated row' : `${r.institution_code} row ${r.source_row}${r.simulated_version ? ' (corrected)' : ''}`)).join(' ↔ ');
const COMPARED = { identifier: 'identifier', student_name: 'name', date_of_birth: 'date of birth' };
const fieldResult = (l, f) => (l.agreeing_fields.includes(f) ? 'agrees' : l.conflicting_fields.includes(f) ? 'conflicts' : l.missing_fields.includes(f) ? 'missing' : l.similar_fields.includes(f) ? 'similar' : 'not compared');
function fieldDelta(b, s) { return Object.keys(COMPARED).filter(f => fieldResult(b, f) !== fieldResult(s, f)).map(f => `${COMPARED[f]} ${fieldResult(b, f)} → ${fieldResult(s, f)}`); }
const OUTCOME_LABEL = { auto_linked: 'linked automatically by the policy', needs_investigation: 'needs investigation', candidate_for_review: 'candidate for review', insufficient_evidence: 'insufficient evidence', not_linked: 'not linked', same_source_record: 'same source record' };
function explain(path, findings, identity, evidence, after) {
  const changed = [];
  findings.resolved.forEach(x => changed.push({ text: `${RULE_NAMES[x.before.rule_code] || x.before.rule_code} for ${where(x.before.evidence)} would ${x.how === 'automatically_matched' ? 'be resolved automatically' : 'no longer be current'}.`, rule: x.before.rule_code, cause: x.reason }));
  findings.created.forEach(x => changed.push({ text: `A new ${RULE_NAMES[x.after.rule_code] || x.after.rule_code} finding would be raised for ${where(x.after.evidence)}.`, rule: x.after.rule_code, cause: x.reason }));
  findings.reclassified.forEach(x => changed.push({ text: `${where(x.before.evidence)}: ${RULE_NAMES[x.before.rule_code]} would become ${RULE_NAMES[x.after.rule_code]} (severity ${x.before.severity} → ${x.after.severity}).`, rule: x.rule, cause: x.reason }));
  findings.reopened.forEach(x => changed.push({ text: `${RULE_NAMES[x.before.rule_code]} for ${where(x.before.evidence)} would return to manual review.`, rule: x.before.rule_code, cause: x.reason }));
  identity.changed.forEach(x => {
    const delta = fieldDelta(x.before, x.after);
    const text = x.before.outcome === x.after.outcome
      ? `Pair ${where(x.after.records)} would stay ${OUTCOME_LABEL[x.after.outcome] || x.after.outcome}${delta.length ? `, with ${delta.join('; ')}` : ''}.`
      : `Pair ${where(x.after.records)}: ${OUTCOME_LABEL[x.before.outcome] || x.before.outcome} → ${OUTCOME_LABEL[x.after.outcome] || x.after.outcome}${delta.length ? ` (${delta.join('; ')})` : ''}.`;
    changed.push({ text, rule: x.after.policy_version, cause: x.after.reason });
  });
  identity.new_pairs.forEach(x => changed.push({ text: `Pair ${where(x.after.records)} would be compared for the first time: ${OUTCOME_LABEL[x.after.outcome] || x.after.outcome}.`, rule: x.after.policy_version, cause: x.after.reason }));
  identity.no_longer_compared.forEach(x => changed.push({ text: `Pair ${where(x.before.records)} would no longer be compared.`, rule: x.before.policy_version, cause: 'The corrected values no longer place these records in the same comparison block (shared identifier, date of birth or folded name).' }));
  identity.decisions_no_longer_applying.forEach(x => changed.push({ text: `The reviewer decision "${x.decision.label}" on ${where(x.pair)} would no longer apply to the current evidence.`, rule: 'matchDecisions (evidence key)', cause: x.reason }));
  const unchanged = [];
  if (findings.other_open_unchanged) unchanged.push(`${findings.other_open_unchanged} other open ${findings.other_open_unchanged === 1 ? 'finding is' : 'findings are'} unaffected.`);
  findings.remain_open.forEach(x => {
    const name = `${RULE_NAMES[x.before.rule_code] || x.before.rule_code} for ${where(x.after.evidence)}`;
    if (x.before.review_status !== x.after.review_status) changed.push({ text: `${name} would stay open but move from ${x.before.review_status.replaceAll('_', ' ')} to ${x.after.review_status.replaceAll('_', ' ')}.`, rule: x.before.rule_code, cause: 'The finding is recomputed with the corrected evidence; review status lives on each finding, so the recomputed finding starts pending and the earlier status stays in the history.' });
    else unchanged.push(`${name} would stay open${x.recomputed ? ' (re-evaluated on the corrected version)' : ''}.`);
  });
  identity.unresolved_remaining.forEach(x => unchanged.push(`Pair ${where(x.pair.records)} would remain ${OUTCOME_LABEL[x.pair.outcome]}: ${x.pair.reason}`));
  const blockers = (after?.items || []).filter(i => i.blocker && i.state !== 'supporting');
  const unresolved = after && after.present === false ? [] : blockers.map(i => `${i.label}: ${i.state.replace('_', ' ')} — ${i.verify}`);
  const headline = path.kind === 'not_recognised' ? 'The official workflow would not record this as a correction of the selected record.'
    : changed.length ? `${changed.length} ${changed.length === 1 ? 'outcome would' : 'outcomes would'} change if this correction were confirmed.`
    : 'No outcome would change. The rules and the identity policy give the same result with the staged value.';
  const caveats = [
    'This is a simulation. No source record, finding, identity link, decision, notification or audit event was changed.',
    'A real correction must arrive from the institution and be confirmed through the corrections workflow; other changes made before then can lead to a different result.',
    'An outcome produced by the policy in this simulation is not a recommendation to link or merge records, and no simulated outcome is a reviewer decision.'
  ];
  return { headline, changed, unchanged, unresolved, evidence_needed: blockers.map(i => ({ field: i.field, label: i.label, state: i.state, verify: i.verify, source: i.source })), caveats, no_change: changed.length === 0 };
}

// ── The simulation ────────────────────────────────────────────────────────────────
// runSimulation keeps the isolated states for the correctness tests; the API uses simulateCorrection,
// which returns only the report, so both copies are released when the request ends.
function runSimulation(db, p, input) {
  const staged = stageCorrection(db, p, input);
  const { record, field, value } = staged;
  const at = simulationTime(db);
  const original = { records: new Set(db.sourceRecords.map(r => r.id)), findings: new Set(db.findings.map(f => f.id)), links: new Set((db.identityLinks || []).map(l => l.id)) };
  const steps = [];

  // Baseline: the same pipeline on an unchanged copy, so the report shows only the effect of the change.
  const baseState = structuredClone(db);
  processAll(baseState, { at, reason: 'in the simulation baseline', origin: 'simulation' });

  // Simulated: the institution re-sends the row with the corrected value (the official import path).
  const simState = structuredClone(db);
  const row = Object.fromEntries(ROW_FIELDS.map(key => [key, key === field ? value : String(record[key] ?? '')]));
  const batch = commitImport(simState, { parsed: { headers: ROW_FIELDS, rows: [row], row_numbers: [record.source_row] }, mapping: Object.fromEntries(ROW_FIELDS.map(k => [k, k])), batchInstitution: record.institution_code, multiInstitution: false, filename: SIMULATED_FILE, at });
  steps.push('commitImport: lineage classification, reconciliation, identity policy and automation on the isolated copy');
  const version = simState.sourceRecords.find(r => r.import_id === batch.id) || null;
  let path;
  if (!version) path = { kind: 'rejected', label: 'Row rejected', explanation: batch.row_outcomes[0]?.reason || 'The import pipeline did not accept the row.' };
  else if (version.lineage?.relation === 'correction' && version.lineage.supersedes === record.id) path = { kind: 'institution_reference', label: 'Correction applied on import', explanation: `The row carries the institution reference ${record.source_reference}, so lineage records it as the next version of the record and supersedes the earlier one without a reviewer step.` };
  else {
    const candidate = (simState.correctionCandidates || []).find(c => c.status === 'pending' && c.later === version.id && c.earlier === record.id);
    if (candidate) {
      decideCorrection(simState, p, candidate.id, { decision: 'confirm', confirm: true, note: 'Simulation: confirmed only in an isolated copy.' });
      processAll(simState, { at, reason: 'after a confirmed correction', origin: 'correction' });
      steps.push('decideCorrection (confirm) and processAll, as the corrections route does, on the isolated copy');
      path = { kind: 'reviewer_confirmed', label: 'Correction candidate, then reviewer confirmation', explanation: `Lineage would propose the row as a possible correction (${candidate.reasons.join(' ')}). The impact shown is after a reviewer confirms it.` };
    } else path = { kind: 'not_recognised', label: 'Not recognised as a correction', explanation: record.source_reference ? 'Lineage would not treat this row as a correction of the selected record.' : 'The record has no institution reference, and lineage only proposes a correction without one when the row fills missing values for the same name, programme and session, or keeps the same usable identifier. This row would be stored as a separate source record. The impact below shows that, not a correction. Ask the institution to re-send the row with its own record reference.' };
  }
  const supersedes = version && simState.sourceRecords.find(r => r.id === record.id)?.superseded_by === version.id;
  const canonOf = id => (supersedes && id === version.id ? record.id : id);
  const base = view(baseState, p, original);
  const sim = view(simState, p, original, canonOf);
  const contextRecords = staged.context ? (staged.context.kind === 'finding' ? db.findings.find(f => f.id === staged.context.id).evidence : db.identityLinks.find(l => l.id === staged.context.id).records) : [];
  const focus = new Set([record.id, ...(version ? [canonOf(version.id)] : []), ...contextRecords]);

  const findings = compareFindings(base, sim, focus);
  const identity = compareLinks(base, sim, focus);
  const evidence = compareEvidence(base, sim, staged, version, focus);
  const simContext = mapContext(staged.context, base, sim);
  const checklist = { before: contextChecklist(view(db, p, original), staged.context), after: simContext ? contextChecklist(sim, simContext) : (staged.context ? { present: false, items: [], limitations: ['In the simulated state this finding or pair is no longer current.'] } : null) };
  const warnings = [];
  const counterpart = contextRecords.filter(id => id !== record.id).map(id => db.sourceRecords.find(r => r.id === id)).filter(Boolean);
  if (counterpart.some(r => String(r[field] ?? '') === value)) warnings.push('The proposed value is the same as the value on the other record in this case. Agreement with another record is not evidence: use this value only if the institution\'s own record shows it.');
  if (FIELDS[field].identity) warnings.push('This is an identity value. Its correction changes the evidence key of every pair the record is in, so earlier reviewer decisions on those pairs stop applying.');

  const report = {
    label: SIMULATION_LABEL, simulation: true, committed: false,
    staged: { record: base.ref(record.id), field, field_label: FIELDS[field].label, before: shown(field, record[field]), after: shown(field, version ? version[field] : value), evidence: staged.evidence, provenance_note: 'Declared by the reviewer for this simulation. EduTrace has not seen or verified the document.', warnings },
    correction_path: path,
    current: currentOutcome(view(db, p, original), staged.context),
    findings, identity, evidence, checklist,
    explanation: explain(path, findings, identity, evidence, checklist.after),
    graph_overlay: version ? graphOverlay(base, sim, p, staged, record.id, new Set([...identity.changed.map(x => x.after.pair_key), ...identity.withdrawn.map(x => x.pair.pair_key)])) : null,
    scope_note: p.role === 'regulator' ? 'All institutions are in your access scope.' : 'Only findings and relationships whose records are all in your access scope are shown.',
    diagnostics: { evaluated_as_of: at, pipeline: steps, isolated_copies: 2, persisted: false, receipts_created: 0, audit_events_written_to_authoritative_history: 0, model_calls: 0 }
  };
  return { report, baseState, simState, canonOf, version };
}
function simulateCorrection(db, p, input) { return runSimulation(db, p, input).report; }

function mapContext(context, base, sim) {
  if (!context) return null;
  if (context.kind === 'finding') {
    const f = base.state.findings.find(x => x.id === context.id);
    if (!f) return null;
    const key = f.rule_code === CAPACITY_RULE ? `cap|${f.condition_key}` : base.evidenceKey(f.evidence);
    const s = sim.currentFindings.find(x => x.rule_code === f.rule_code && (x.rule_code === CAPACITY_RULE ? `cap|${x.condition_key}` : sim.evidenceKey(x.evidence)) === key)
      || sim.currentFindings.find(x => x.rule_code === f.rule_code && f.condition_key && x.condition_key === f.condition_key);
    return s ? { kind: 'finding', id: s.id } : null;
  }
  const l = (base.state.identityLinks || []).find(x => x.id === context.id);
  const key = l && [...new Set(l.records)].sort().join('|');
  const s = key && (sim.state.identityLinks || []).find(x => [...new Set(x.records.map(sim.canonOf))].sort().join('|') === key);
  return s ? { kind: 'link', id: s.id } : null;
}

module.exports = { SIMULATION_LABEL, FIELDS, EVIDENCE_KINDS, LabError, stageCorrection, simulationTime, runSimulation, simulateCorrection, evidenceChecklist };
