// Current assessment of a finding, kept apart from the explanation recorded when it was raised.
//
// A finding's `explanation` is written once, when the finding is raised, and is never rewritten:
// it is audit history (notifications, receipts and the condition key rely on it). The pipeline keeps
// a finding when the same condition recurs, so that text can describe a state that no longer holds,
// for example a competing candidate that a later correction removed.
//
// The current assessment is recomputed at read time from the latest stored records and identity
// links, with the same rules and the same text builders that raise findings (src/engine.js). For a
// condition that still holds, its summary is word for word what a newly raised finding would say.
// Nothing here writes to the data.
const { isActiveRecord, isCurrent, validate, sameEvidence, CAPACITY_RULE, GROUP_TEXT, CONCURRENT_EXPLANATION, validationExplanation, candidateExplanation, capacityExplanation, capacityState, capacityKey } = require('./engine');
const { AUTO_LINK_POLICY } = require('./identity');

const VALIDATION_RULES = new Set(['APAAR_MISSING', 'APAAR_MALFORMED', 'REQUIRED_FIELD_MISSING']);
const GROUP_RULES = new Set(['DUPLICATE_IDENTIFIER', 'IDENTIFIER_ATTRIBUTE_CONFLICT']);
const COMPETING = /(\d+) records are equally plausible candidates/;

// Records and links indexed once per data object.
const indexes = new WeakMap();
function indexOf(db) {
  let idx = indexes.get(db);
  if (!idx || idx.records.size !== db.sourceRecords.length) {
    idx = { records: new Map(db.sourceRecords.map(r => [r.id, r])), active: db.sourceRecords.filter(isActiveRecord) };
    indexes.set(db, idx);
  }
  return idx;
}
// Active records sharing an identifier fingerprint, and identity links per group, in their original order. Built on
// first use; the link index follows the identity-link array, which the pipeline replaces as a whole.
function groupOf(idx, fp) {
  if (!idx.byFingerprint) { idx.byFingerprint = new Map(); idx.active.forEach(r => { if (!r.apaar_fingerprint) return; if (!idx.byFingerprint.has(r.apaar_fingerprint)) idx.byFingerprint.set(r.apaar_fingerprint, []); idx.byFingerprint.get(r.apaar_fingerprint).push(r); }); }
  return idx.byFingerprint.get(fp) || [];
}
const linkGroups = new WeakMap();
function linksOfGroup(db, key) {
  const list = db.identityLinks || [];
  let entry = linkGroups.get(list);
  if (!entry || entry.length !== list.length) { const map = new Map(); list.forEach(l => { if (!map.has(l.group_key)) map.set(l.group_key, []); map.get(l.group_key).push(l); }); entry = { length: list.length, map }; linkGroups.set(list, entry); }
  return entry.map.get(key) || [];
}

// What the rule says about the finding's condition in the latest data.
function recompute(db, f, idx) {
  const evidence = f.evidence.map(id => idx.records.get(id)).filter(Boolean);
  if (VALIDATION_RULES.has(f.rule_code)) {
    const r = evidence[0];
    if (!r) return { present: null, summary: f.explanation, basis: 'stored', facts: [] };
    const issue = isActiveRecord(r) && validate(r).find(i => i.code === f.rule_code && (!f.field || i.field === f.field));
    return issue
      ? { present: true, summary: validationExplanation(issue.field, r), basis: 'recomputed', facts: [] }
      : { present: false, summary: 'The latest stored version of this record no longer has this problem. The finding is cleared at the next reconciliation run.', basis: 'recomputed', facts: [] };
  }
  if (GROUP_RULES.has(f.rule_code) || f.rule_code === 'POTENTIAL_CONCURRENT_ENROLMENT') {
    const fp = evidence[0]?.apaar_fingerprint;
    const group = fp ? groupOf(idx, fp) : [];
    if (group.length < 2) return { present: false, summary: 'Fewer than two current source records share this identifier now, so the condition no longer holds.', basis: 'recomputed', facts: [{ key: 'records_sharing_identifier', value: group.length }] };
    const conflicts = new Set(group.map(r => `${r.normalized_name}|${r.date_of_birth}`)).size > 1;
    const links = linksOfGroup(db, `fp:${fp}`);
    const facts = [{ key: 'records_sharing_identifier', value: group.length }, { key: 'automatically_linked_pairs', value: links.filter(l => l.outcome === 'auto_linked').length }, { key: 'pairs_needing_investigation', value: links.filter(l => l.outcome === 'needs_investigation').length }];
    if (f.rule_code === 'POTENTIAL_CONCURRENT_ENROLMENT') {
      const active = group.filter(r => r.enrolment_status === 'active');
      const present = new Set(active.map(r => r.institution_code)).size > 1 && new Set(active.map(r => r.academic_session)).size === 1;
      return { present, summary: present ? CONCURRENT_EXPLANATION : 'The records sharing this identifier are no longer active at more than one institution in the same session.', basis: 'recomputed', facts: [...facts, { key: 'active_institutions', value: new Set(active.map(r => r.institution_code)).size }] };
    }
    const ruleNow = conflicts ? 'IDENTIFIER_ATTRIBUTE_CONFLICT' : 'DUPLICATE_IDENTIFIER';
    return ruleNow === f.rule_code
      ? { present: true, summary: GROUP_TEXT[ruleNow].explanation, basis: 'recomputed', facts }
      : { present: false, reclassified_as: ruleNow, summary: `The records sharing this identifier now meet a different rule (${GROUP_TEXT[ruleNow].title.toLowerCase()}): ${GROUP_TEXT[ruleNow].explanation}`, basis: 'recomputed', facts };
  }
  if (f.rule_code === 'CANDIDATE_IDENTITY_MATCH') {
    const link = (db.identityLinks || []).find(l => l.method === 'name_dob_similarity' && sameEvidence(l.records, f.evidence));
    if (!link) return { present: false, summary: `Under policy ${AUTO_LINK_POLICY.version} these records are no longer compared as a pair.`, basis: 'recomputed', facts: [] };
    const facts = [{ key: 'pair_outcome', value: link.outcome }, { key: 'competing_candidates', value: link.competing_candidates || 0 }, { key: 'missing_fields', value: link.missing_fields.join(', ') || 'none' }];
    return link.outcome === 'candidate_for_review'
      ? { present: true, summary: candidateExplanation(link), basis: 'recomputed', facts }
      : { present: false, summary: `The pair is no longer a candidate under policy ${AUTO_LINK_POLICY.version}: ${link.reason}`, basis: 'recomputed', facts };
  }
  if (f.rule_code === CAPACITY_RULE) {
    const rule = (db.capacityRules || []).find(x => capacityKey(x) === f.condition_key);
    if (!rule) return { present: false, summary: 'The capacity rule this finding was raised under is no longer configured.', basis: 'recomputed', facts: [] };
    const state = capacityState(idx.active, rule);
    const facts = [{ key: 'observed_active', value: state.observed_active }, { key: 'permitted_capacity', value: state.permitted_capacity }];
    return state.exceeded
      ? { present: true, summary: capacityExplanation(state), basis: 'recomputed', facts }
      : { present: false, summary: `${state.observed_active} active enrolments are now counted against the configured prototype capacity ${state.permitted_capacity}, so the limit is no longer exceeded.`, basis: 'recomputed', facts };
  }
  return { present: null, summary: f.explanation, basis: 'stored', facts: [] };
}

// Differences between what was recorded when the finding was raised and the current assessment.
function differences(f, now, raisedEvidence) {
  const out = [];
  if (now.present === false) out.push('The condition described when the finding was raised no longer holds in the latest data.');
  else if (now.basis === 'recomputed' && now.summary !== f.explanation) out.push('The explanation recorded when the finding was raised no longer matches the latest data.');
  const before = Number(f.explanation.match(COMPETING)?.[1] || 0);
  const after = now.facts.find(x => x.key === 'competing_candidates')?.value;
  if (f.rule_code === 'CANDIDATE_IDENTITY_MATCH' && after !== undefined && before !== after) out.push(`Competing candidates: ${before} when raised, ${after} now.`);
  if (raisedEvidence && raisedEvidence.length !== f.evidence.length) out.push(`Evidence: ${raisedEvidence.length} source ${raisedEvidence.length === 1 ? 'record' : 'records'} when raised, ${f.evidence.length} now (resubmitted rows were added).`);
  const cap = now.facts.find(x => x.key === 'observed_active')?.value;
  if (f.capacity && cap !== undefined && cap !== f.capacity.observed_active) out.push(`Active enrolments counted: ${f.capacity.observed_active} when raised, ${cap} now.`);
  if (now.reclassified_as) out.push(`The condition is now classified as ${now.reclassified_as}.`);
  return out;
}

function assessFinding(db, f, p = null) {
  const idx = indexOf(db);
  const raised = {
    explanation: f.explanation, title: f.title, created_at: f.created_at || null, rule_version: f.rule_version || null,
    evidence: f.original_evidence ? [...f.original_evidence] : null,
    evidence_note: f.original_evidence ? null : 'The evidence at the time this finding was raised was not recorded separately (findings raised before this field existed). The audit history lists any records added later.'
  };
  const history = (db.auditEvents || []).filter(e => e.finding_id === f.id).sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .map(e => ({ at: e.at, action: e.action, actor: e.actor, system: Boolean(e.system), note: e.note || null }));
  const assessed = { policy_version: AUTO_LINK_POLICY.version, rule_version: f.rule_version || null, last_validated_at: f.last_validated_at || f.created_at || null, basis: 'latest stored source records and identity links' };
  if (!isCurrent(f)) {
    const summary = f.lifecycle_status === 'superseded'
      ? 'Historical: this finding was superseded by a recomputed finding for the same condition. Review the current finding instead.'
      : f.lifecycle_status === 'cleared' ? `Historical: the condition is no longer present${f.lifecycle_cause === 'correction' ? ' because a corrected version of a source record replaced the one it was raised on' : ''}.`
      : 'Historical finding.';
    return { status: f.lifecycle_status, condition_present: false, summary, reason: f.lifecycle_reason || null, changed_at: f.lifecycle_changed_at || null, successor: f.superseded_by || null, stale_original: f.explanation !== summary, differences: ['This finding is historical. Its explanation describes the state when it was raised.'], facts: [], basis: 'lifecycle', review: { status: f.review_status, decided: Boolean(f.decision), automated: Boolean(f.decision?.automated) }, raised, history, assessed };
  }
  const now = recompute(db, f, idx);
  // A principal sees counts only for what is in scope; findings themselves are already scope-checked.
  const scoped = p && p.role !== 'regulator' ? now.facts.filter(x => !['records_sharing_identifier', 'automatically_linked_pairs', 'pairs_needing_investigation', 'active_institutions'].includes(x.key)) : now.facts;
  return {
    status: 'current', condition_present: now.present, summary: now.summary, basis: now.basis, reclassified_as: now.reclassified_as || null,
    stale_original: now.present === false || (now.basis === 'recomputed' && now.summary !== f.explanation),
    differences: differences(f, now, raised.evidence), facts: scoped,
    review: { status: f.review_status, decided: Boolean(f.decision), automated: Boolean(f.decision?.automated), required_action: f.automation?.required_action || null },
    raised, history, assessed
  };
}

module.exports = { assessFinding };
