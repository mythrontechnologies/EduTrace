// Potential matches, reviewer identity decisions and source-record profiles.
//
// A potential match is a persisted identity link (src/identity.js) whose outcome needs a person:
//   candidate_for_review  — no shared identifier; date of birth agrees and names are similar.
//   needs_investigation   — a protected identifier is shared but name or date of birth disagree.
// Nothing here creates links or changes source records. A reviewer decision is stored against
// the pair's evidence key (method + each record's identity evidence: institution, folded name,
// date of birth, identifier), so it survives revalidation and an unchanged resubmission, and no
// longer applies once that evidence changes. Decisions are written to the audit history of the
// finding that raised the pair. "Same person" is recorded as a reviewer
// confirmation; source records stay separate and are never merged or overwritten.
const crypto = require('node:crypto');
const { mask, canAccess, isCurrent } = require('./engine');
const { WEIGHTS, CANDIDATE_SIMILARITY, AUTO_LINK_POLICY } = require('./identity');
const { TASK_VERSIONS } = require('./ai-provider');

const REVIEWABLE = new Set(['candidate_for_review', 'needs_investigation']);
const DECISIONS = {
  same_person: { label: 'Same person', final: true },
  different_person: { label: 'Different people', final: true },
  needs_more_evidence: { label: 'Needs more evidence', final: false }
};
const METHODS = {
  protected_identifier_exact: { label: 'Exact protected-identifier match', kind: 'exact', description: 'Both records carry the same APAAR identifier, compared as a protected fingerprint. The identifier itself is never compared in clear or shown in full.' },
  name_dob_similarity: { label: 'Name similarity with matching date of birth', kind: 'similarity', description: 'Records without a shared usable identifier were grouped by date of birth and by folded name, and their names compared (identical, equivalent after folding, an initial, or word overlap). These are fixed rules, not a trained model, and never link records on their own.' }
};
// Reviewer-facing resolution of a pair: the policy outcome, unless a reviewer has decided.
const RESOLUTIONS = {
  AUTO_MATCHED: 'Matched automatically under policy', POTENTIAL_MATCH: 'Potential match', MATCH_WITHDRAWN: 'Automatic match withdrawn',
  SAME_PERSON_CONFIRMED: 'Same person (reviewer)', DIFFERENT_PERSON: 'Different people (reviewer)', NEEDS_MORE_EVIDENCE: 'Needs more evidence (reviewer)',
  INSUFFICIENT_EVIDENCE: 'Insufficient evidence', NO_SUPPORTED_MATCH: 'No supported match', SAME_SOURCE_RECORD: 'Same source record re-sent'
};
const DISQUALIFIERS = {
  identifier_conflict: 'Different well-formed identifiers', date_of_birth_conflict: 'Same identifier, different date of birth', name_conflict: 'Same identifier, different name',
  shared_malformed_identifier: 'Shared identifier value is malformed', competing_candidates: 'More than one equally plausible candidate'
};
function resolution(link, decision) {
  if (decision) return { same_person: 'SAME_PERSON_CONFIRMED', different_person: 'DIFFERENT_PERSON', needs_more_evidence: 'NEEDS_MORE_EVIDENCE' }[decision.decision];
  if (link.outcome === 'auto_linked') return 'AUTO_MATCHED';
  if (link.outcome === 'same_source_record') return 'SAME_SOURCE_RECORD';
  if (link.withdrawn) return 'MATCH_WITHDRAWN';
  if (REVIEWABLE.has(link.outcome)) return 'POTENTIAL_MATCH';
  return link.outcome === 'insufficient_evidence' ? 'INSUFFICIENT_EVIDENCE' : 'NO_SUPPORTED_MATCH';
}
function nextAction(link, decision) {
  if (decision?.decision === 'needs_more_evidence') return 'Wait for the requested evidence, then decide';
  if (decision) return 'None unless the evidence changes';
  if ((link.disqualifiers || []).includes('shared_malformed_identifier')) return 'Ask the institution to correct the identifier';
  if (link.outcome === 'needs_investigation') return 'Confirm the identifier and conflicting attribute with both institutions';
  if (link.competing_candidates) return 'Compare every candidate before deciding';
  if (link.missing_fields.includes('identifier')) return 'Request an identifier or source document';
  return 'Compare the source records and decide';
}
const IDENTITY_FIELDS = ['identifier', 'student_name', 'date_of_birth'];
const FIELD_LABELS = { identifier: 'APAAR identifier', student_name: 'Name', date_of_birth: 'Date of birth' };
const MAX_SCORE = WEIGHTS.identifier_agree + WEIGHTS.name_exact + WEIGHTS.dob_agree;

const pct = n => `${Math.round(n * 100)}%`;
const text = value => String(value ?? '').trim();
const searchText = value => text(value).normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
// A safe display label for lists: initials only, so a queue never shows full names.
const maskName = name => text(name).split(/\s+/).filter(Boolean).map(token => `${token[0].toUpperCase()}${'•'.repeat(Math.min(Math.max(token.length - 1, 2), 5))}`).join(' ') || 'Name not supplied';
const identifierCheck = r => !r.apaar_id ? 'missing' : /^\d{12}$/.test(r.apaar_id) ? 'locally_well_formed' : 'malformed';

function recordMap(db) { return new Map(db.sourceRecords.map(r => [r.id, r])); }
function findingFor(db, link) { return db.findings.find(f => f.id === link.finding_id) || db.findings.find(f => isCurrent(f) && (f.identity_link_ids || []).includes(link.id)) || null; }
function decisionFor(db, link) { const all = db.matchDecisions || {}; return (link.evidence_key && all[link.evidence_key]) || all[link.key] || null; }
function batchFor(db, r) { return r.import_id ? (db.importBatches || []).find(b => b.id === r.import_id) || null : null; }
function visibleLinkRecords(link, records, p) {
  const pair = link.records.map(id => records.get(id));
  return pair.every(r => r && canAccess(p, r)) ? pair : null;
}
// The record imported first is the reference; the later one is the incoming record.
function orderPair(pair) {
  return [...pair].sort((a, b) => String(a.imported_at || '').localeCompare(String(b.imported_at || '')) || String(a.id).localeCompare(String(b.id)));
}

function matchStatus(decision) { return decision ? decision.decision : 'needs_review'; }
function sourceRef(db, r) {
  const batch = batchFor(db, r);
  return { record_id: r.id, institution_code: r.institution_code, institution_name: (db.institutions || []).find(i => i.code === r.institution_code)?.name || r.institution_name || r.institution_code, source_file: r.source_file, source_row: r.source_row, import_id: r.import_id || null, import_label: batch ? batch.filename || batch.source_file || batch.id : 'Seeded synthetic data', imported_at: r.imported_at || batch?.created_at || null };
}
function whyCandidate(link) {
  const lower = list => list.map(f => FIELD_LABELS[f].toLowerCase()).join(' and ');
  const name = link.name_comparison || {};
  const names = name.result === 'exact' ? 'identical names' : name.result === 'equivalent' ? 'names that are equivalent after folding' : name.method === 'initials' ? 'names that differ only by an initial' : `${pct(link.name_similarity)} of name words in common`;
  if (link.method === 'protected_identifier_exact') {
    if ((link.disqualifiers || []).includes('shared_malformed_identifier')) return 'Both records carry the same identifier value, but it is not well-formed, so it cannot be used as identifier evidence.';
    const conflicts = link.conflicting_fields.filter(f => f !== 'identifier');
    if (conflicts.length) return `Both records carry the same identifier, but ${lower(conflicts)} ${conflicts.length > 1 ? 'differ' : 'differs'}. Which record is correct is not established.`;
    if (link.outcome === 'needs_investigation') return 'These two records agree, but another record sharing the identifier has a different name or date of birth.';
    return `Both records carry the same well-formed identifier, but ${link.missing_fields.includes('date_of_birth') ? 'a date of birth is missing' : `they have ${names}`}, so the policy requires a reviewer.`;
  }
  return `Dates of birth agree and the records have ${names} (review threshold ${pct(CANDIDATE_SIMILARITY)} of words), but no usable identifier is shared${link.competing_candidates ? `; ${link.competing_candidates} records are equally plausible candidates` : ''}.`;
}

function summaryEntry(db, link, pair, p) {
  const [reference, incoming] = orderPair(pair);
  const decision = decisionFor(db, link);
  const finding = findingFor(db, link);
  return {
    id: link.id, method: link.method, method_label: METHODS[link.method]?.label || link.method, method_kind: METHODS[link.method]?.kind || 'other',
    outcome: link.outcome, display_label: maskName(reference.student_name),
    sources: [sourceRef(db, reference), sourceRef(db, incoming)],
    agreeing_fields: link.agreeing_fields, similar_fields: link.similar_fields || [], conflicting_fields: link.conflicting_fields, missing_fields: link.missing_fields,
    matching_field_count: link.agreeing_fields.length + (link.similar_fields || []).length,
    disqualifiers: (link.disqualifiers || []).map(code => ({ code, label: DISQUALIFIERS[code] || code })), competing_candidates: link.competing_candidates || 0,
    name_similarity: link.name_similarity, name_comparison: link.name_comparison || null, score: link.score, score_max: MAX_SCORE,
    status: matchStatus(decision), decision: decision ? publicDecision(decision) : null,
    resolution: resolution(link, decision), resolution_label: RESOLUTIONS[resolution(link, decision)], recommended_action: nextAction(link, decision),
    sessions: [...new Set(pair.map(r => r.academic_session).filter(Boolean))], copies: 1,
    finding_id: finding?.id || null, finding_review_status: finding?.review_status || null, finding_title: finding?.title || null,
    why: whyCandidate(link), model_assessment: finding?.assist?.candidate_assessment ? { assessment: finding.assist.candidate_assessment.assessment, model: finding.assist.candidate_assessment.provenance?.model || null } : null
  };
}
function publicDecision(d) { return { decision: d.decision, label: DECISIONS[d.decision]?.label || d.decision, note: d.note, reviewer: d.reviewer, at: d.at, receipt_id: d.receipt_id || null, history: (d.history || []).map(({ decision, note, reviewer, at, receipt_id }) => ({ decision, label: DECISIONS[decision]?.label || decision, note, reviewer, at, receipt_id: receipt_id || null })) }; }

// Queue of reviewable links whose records are all in the principal's scope.
function listMatches(db, p, params = new URLSearchParams()) {
  const records = recordMap(db);
  const visible = (db.identityLinks || []).filter(l => REVIEWABLE.has(l.outcome)).map(l => ({ link: l, pair: visibleLinkRecords(l, records, p) })).filter(x => x.pair);
  // An unchanged resubmission creates new source records with the same identity evidence. Such
  // pairs share an evidence key and a decision, so they are shown once, using the latest records.
  const groups = new Map();
  visible.forEach(x => { const key = x.link.evidence_key || x.link.key; groups.set(key, [...(groups.get(key) || []), x]); });
  const latest = x => x.pair.map(r => String(r.imported_at || '')).sort().pop();
  const entries = [...groups.values()].map(group => {
    const chosen = [...group].sort((a, b) => latest(b).localeCompare(latest(a)) || a.link.id.localeCompare(b.link.id))[0];
    const entry = summaryEntry(db, chosen.link, chosen.pair, p);
    entry.copies = group.length;
    return { entry, pair: chosen.pair };
  });
  const q = searchText(params.get('q'));
  const institution = text(params.get('institution')).toUpperCase();
  const status = text(params.get('status'));
  const conflict = text(params.get('conflict'));
  const evidence = text(params.get('evidence'));
  const method = text(params.get('method'));
  const session = text(params.get('session'));
  const filtered = entries.filter(({ entry, pair }) => {
    if (session && !entry.sessions.includes(session)) return false;
    if (institution && !entry.sources.some(s => s.institution_code === institution)) return false;
    if (status && entry.status !== status) return false;
    if (conflict === 'none' ? entry.conflicting_fields.length : conflict && !entry.conflicting_fields.includes(conflict) && !(conflict === 'missing' && entry.missing_fields.length)) return false;
    if (evidence && !entry.agreeing_fields.includes(evidence)) return false;
    if (method && entry.method !== method) return false;
    if (q) {
      // Authorised reviewers can search by name, institution, file, row or link id; results stay masked.
      const haystack = [entry.id, ...pair.map(r => r.student_name), ...entry.sources.flatMap(s => [s.institution_code, s.institution_name, s.source_file, `row ${s.source_row}`])].map(searchText).join(' | ');
      if (!q.split(' ').every(token => haystack.includes(token))) return false;
    }
    return true;
  }).map(x => x.entry);
  const order = { needs_review: 0, needs_more_evidence: 1, same_person: 2, different_person: 2 };
  filtered.sort((a, b) => order[a.status] - order[b.status] || (a.method === b.method ? 0 : a.method === 'protected_identifier_exact' ? -1 : 1) || a.id.localeCompare(b.id));
  const all = entries.map(x => x.entry);
  return {
    data: filtered, total: all.length,
    counts: { needs_review: all.filter(e => e.status === 'needs_review').length, needs_more_evidence: all.filter(e => e.status === 'needs_more_evidence').length, decided: all.filter(e => DECISIONS[e.status]?.final).length },
    filter_options: {
      institutions: [...new Set(all.flatMap(e => e.sources.map(s => s.institution_code)))].sort(),
      statuses: ['needs_review', 'needs_more_evidence', 'same_person', 'different_person'],
      conflicts: ['identifier', 'student_name', 'date_of_birth', 'missing', 'none'],
      evidence: IDENTITY_FIELDS, methods: Object.keys(METHODS),
      sessions: [...new Set(all.flatMap(e => e.sessions))].sort()
    }
  };
}

// Field-by-field comparison. A field agrees only when both values are present and equal; a
// missing value is never shown as a match. Identifiers are compared by fingerprint and shown masked.
function compareFields(db, link, reference, incoming) {
  const ref = sourceRef(db, reference); const inc = sourceRef(db, incoming);
  const side = (r, s, value, extra = {}) => ({ value: value || null, source: { ...s, original_value: extra.original ?? null, transformation: extra.transformation ?? null }, ...extra.more });
  const original = (r, key) => { const v = r.original?.[key]; return v == null || v === '' ? null : String(v).slice(0, 120); };
  const fields = [];
  const push = (key, label, kind, a, b, state, note) => fields.push({ key, label, kind, reference: a, incoming: b, state, note });
  const plain = (key, label, kind, note) => {
    const a = text(reference[key]); const b = text(incoming[key]);
    const state = !a && !b ? 'missing_both' : !a || !b ? 'missing_one' : a === b ? 'agree' : kind === 'identity' ? 'conflict' : 'differs';
    push(key, label, kind, side(reference, ref, a, { original: original(reference, key), transformation: reference.transformations?.[key] }), side(incoming, inc, b, { original: original(incoming, key), transformation: incoming.transformations?.[key] }), state, note);
  };
  // Name: exact, equivalent after comparison folding, similar, or different (src/names.js).
  {
    const a = text(reference.student_name); const b = text(incoming.student_name);
    const result = link.name_comparison?.result;
    const state = !a && !b ? 'missing_both' : !a || !b ? 'missing_one' : result === 'exact' || reference.normalized_name === incoming.normalized_name ? 'agree' : result === 'equivalent' ? 'equivalent' : result === 'similar' || (!result && link.name_similarity >= CANDIDATE_SIMILARITY) ? 'similar' : 'conflict';
    push('student_name', 'Name', 'identity', side(reference, ref, a, { original: original(reference, 'student_name'), transformation: reference.transformations?.student_name }), side(incoming, inc, b, { original: original(incoming, 'student_name'), transformation: incoming.transformations?.student_name }), state,
      `${link.name_comparison?.note || (state === 'agree' ? 'Identical after trimming and Unicode normalisation.' : `${pct(link.name_similarity)} of name words match.`)}${state === 'similar' || state === 'equivalent' ? ' Similar or equivalent names are not proof of the same person.' : ''}`);
  }
  plain('date_of_birth', 'Date of birth', 'identity', 'Compared after normalising to YYYY-MM-DD.');
  {
    const checkA = identifierCheck(reference); const checkB = identifierCheck(incoming);
    const state = checkA === 'missing' && checkB === 'missing' ? 'missing_both' : checkA === 'missing' || checkB === 'missing' ? 'missing_one' : checkA === 'malformed' || checkB === 'malformed' ? 'not_comparable' : reference.apaar_fingerprint === incoming.apaar_fingerprint ? 'agree' : 'conflict';
    push('apaar_id', 'APAAR identifier', 'identity',
      side(reference, ref, reference.apaar_id ? mask(reference.apaar_id) : null, { transformation: reference.transformations?.apaar_id, more: { identifier_check: checkA, verification: 'not_verified' } }),
      side(incoming, inc, incoming.apaar_id ? mask(incoming.apaar_id) : null, { transformation: incoming.transformations?.apaar_id, more: { identifier_check: checkB, verification: 'not_verified' } }),
      state, 'Compared as a protected fingerprint and shown masked. No authoritative APAAR verification service is connected: a well-formed value is only locally well-formed, never verified.');
  }
  plain('institution_code', 'Institution', 'context', 'Different institutions are expected for a cross-institution candidate and are not an identity conflict.');
  plain('programme', 'Programme', 'context');
  plain('academic_session', 'Academic session', 'context');
  plain('admission_year', 'Admission year', 'context');
  plain('seat_category', 'Admission category', 'context');
  plain('enrolment_status', 'Enrolment status', 'context');
  return fields;
}

// ── Model explanation of a pair (advisory) ──
// The model receives field-level results only (agree / equivalent / similar / conflict / differs /
// missing / not comparable), the method, the policy outcome and contradictions — no names, dates
// or identifiers. Its answer is validated against those results (src/ai-provider.js) and stored
// against the pair's evidence key, template version and model; any change makes it stale.
const RESULT_OF = { agree: 'agree', equivalent: 'equivalent', similar: 'similar', conflict: 'conflict', differs: 'differs', missing_one: 'missing', missing_both: 'missing', not_comparable: 'not_comparable' };
const ACTION_LABELS = {
  request_identifier_or_source_document: 'Request an identifier or source document',
  confirm_conflicting_attribute_with_institutions: 'Confirm the conflicting attribute with both institutions',
  correct_malformed_identifier: 'Ask the institution to correct the identifier',
  compare_all_competing_candidates: 'Compare every candidate before deciding',
  compare_source_records_and_decide: 'Compare the source records and decide'
};
function matchExplanationInput(link, fields) {
  return {
    method: link.method, method_label: METHODS[link.method]?.label || link.method, policy_version: link.policy_version, policy_outcome: link.outcome,
    fields: fields.filter(f => f.kind === 'identity').map(f => ({ field: f.key === 'apaar_id' ? 'identifier' : f.key, kind: f.kind, result: RESULT_OF[f.state] || f.state })),
    context: fields.filter(f => f.kind === 'context').map(f => ({ field: f.key, result: f.state === 'agree' ? 'same' : f.state === 'differs' ? 'differs' : 'missing' })),
    name_comparison: link.name_comparison?.method || null, score: link.score, score_max: MAX_SCORE,
    disqualifiers: link.disqualifiers || [], competing_candidates: link.competing_candidates || 0, authoritative_verification: 'not available'
  };
}
const matchCacheKey = (link, input, model) => crypto.createHash('sha256').update(JSON.stringify([TASK_VERSIONS.match_explanation, model || null, link.evidence_key || link.key, input])).digest('hex');
function storedMatchExplanation(db, link, fields, provider) {
  const stored = (db.matchAssist || {})[link.evidence_key || link.key];
  if (!stored) return null;
  const current = stored.cache_key === matchCacheKey(link, matchExplanationInput(link, fields), provider?.status?.().model);
  const { cache_key, ...rest } = stored;
  return current ? rest : { stale: true, generated_at: stored.provenance?.generated_at || null, model: stored.provenance?.model || null };
}
function deterministicMatchExplanation(link, decision) {
  return { source: 'deterministic', summary: whyCandidate(link), agreeing_fields: [...link.agreeing_fields, ...(link.similar_fields || [])], conflicting_fields: link.conflicting_fields, missing_fields: link.missing_fields, limitations: matchExplanation(link, null, decision).limitations, recommended_action_label: nextAction(link, decision) };
}

async function explainMatch(db, p, linkId, provider) {
  const link = (db.identityLinks || []).find(l => l.id === linkId && REVIEWABLE.has(l.outcome));
  const pair = link && visibleLinkRecords(link, recordMap(db), p);
  if (!pair) throw new MatchError(404, 'Potential match not found.');
  const [reference, incoming] = orderPair(pair);
  const fields = compareFields(db, link, reference, incoming);
  const input = matchExplanationInput(link, fields);
  const status = provider.status();
  const key = matchCacheKey(link, input, status.model);
  const slot = link.evidence_key || link.key;
  const stored = (db.matchAssist || {})[slot];
  if (stored && stored.cache_key === key) { const { cache_key, ...rest } = stored; return { changed: false, result: { ...rest, cached: true, sent_fields: Object.keys(input) } }; }
  const decision = decisionFor(db, link);
  const result = await provider.run('match_explanation', input);
  if (result.ok) {
    const explanation = { source: 'model', ...result.output, recommended_action_label: ACTION_LABELS[result.output.recommended_action], provenance: result.provenance };
    db.matchAssist = { ...(db.matchAssist || {}), [slot]: { ...explanation, cache_key: key } };
    return { changed: true, result: { ...explanation, replaced_stale: Boolean(stored), sent_fields: Object.keys(input) } };
  }
  let changed = false;
  if (stored) { const next = { ...(db.matchAssist || {}) }; delete next[slot]; db.matchAssist = next; changed = true; }
  return { changed, result: { ...deterministicMatchExplanation(link, decision), model_unavailable_reason: result.reason, stale_model_explanation_withheld: Boolean(stored), sent_fields: Object.keys(input) } };
}

function aiContribution(db, finding, provider, link, fields) {
  const status = provider?.status?.() || null;
  const assessment = finding?.assist?.candidate_assessment;
  const explanation = finding?.assist?.explanation;
  return {
    provider: status ? { configured: status.configured, label: status.provider_label || status.provider, model: status.model, local: Boolean(status.local), health: status.health?.label || null, match_task_available: Boolean(status.tasks?.match_explanation?.available), candidate_task_available: Boolean(status.tasks?.candidate_assessment?.available), candidate_task_reason: status.tasks?.candidate_assessment?.reason || null } : null,
    match_explanation: link ? storedMatchExplanation(db, link, fields, provider) : null,
    candidate_assessment: assessment ? { assessment: assessment.assessment, name_relationship: assessment.name_relationship, rationale: assessment.rationale, model: assessment.provenance?.model || null, local: Boolean(assessment.provenance?.local), generated_at: assessment.provenance?.generated_at || null } : null,
    explanation: explanation ? { summary: explanation.summary, model: explanation.provenance?.model || null, generated_at: explanation.provenance?.generated_at || null } : null,
    effect: 'Advisory only. A model assessment never links, separates or merges records; only a reviewer decision is recorded.'
  };
}

function matchExplanation(link, finding, decision) {
  const method = METHODS[link.method] || { label: link.method, description: '' };
  const recommendation = decision?.decision === 'same_person' ? 'A reviewer recorded these records as the same person. The source records remain separate and unchanged.'
    : decision?.decision === 'different_person' ? 'A reviewer recorded these records as different people. They will not be presented as a candidate again unless the evidence changes.'
    : link.outcome === 'needs_investigation' ? 'Do not link. Ask both institutions to confirm the identifier and the conflicting attribute against an authoritative source document.'
    : 'Keep the records separate until an authorised identifier or source document confirms identity.';
  const uncertainty = link.outcome === 'needs_investigation'
    ? 'A shared identifier normally indicates the same student, but the conflicting attributes mean at least one record may carry a wrong identifier or a wrong attribute.'
    : link.missing_fields.includes('identifier') ? 'At least one record has no usable identifier, so identity rests on name and date of birth, which different students can share.' : null;
  return {
    method: link.method, method_label: method.label, method_kind: METHODS[link.method]?.kind || 'other', method_description: method.description,
    agreeing_fields: link.agreeing_fields, conflicting_fields: link.conflicting_fields, missing_fields: link.missing_fields,
    why: whyCandidate(link), recommendation, uncertainty, system_reason: link.reason, policy_version: link.policy_version,
    score: { value: link.score, max: MAX_SCORE, note: `A fixed weighting of field agreement (identifier ${WEIGHTS.identifier_agree}, exact or equivalent name ${WEIGHTS.name_exact}, similar name ${WEIGHTS.name_similar}, date of birth ${WEIGHTS.dob_agree}; conflicts subtract). It orders and explains evidence; it is not a calibrated probability and never decides an outcome.` },
    similar_fields: link.similar_fields || [], factors: link.factors || [], disqualifiers: (link.disqualifiers || []).map(code => ({ code, label: DISQUALIFIERS[code] || code })),
    competing_candidates: link.competing_candidates || 0, withdrawn: link.withdrawn || null,
    resolution: resolution(link, decision), resolution_label: RESOLUTIONS[resolution(link, decision)], next_action: nextAction(link, decision),
    policy: { version: link.policy_version, conditions: AUTO_LINK_POLICY.conditions, never: AUTO_LINK_POLICY.never, automatic: link.outcome === 'auto_linked' },
    limitations: [
      'No authoritative APAAR verification is connected; identifiers are only checked locally for format.',
      link.missing_fields.includes('identifier') ? 'Without a shared usable identifier, matching names and dates of birth can belong to different students.' : null,
      link.competing_candidates ? 'Another record is an equally plausible candidate, so at most one pairing can be right.' : null,
      link.conflicting_fields.length ? 'A conflicting attribute means at least one source record may be wrong; this comparison cannot tell which.' : null
    ].filter(Boolean),
    name_similarity: link.name_similarity, finding: finding ? { id: finding.id, rule_code: finding.rule_code, title: finding.title, review_status: finding.review_status, lifecycle_status: finding.lifecycle_status || 'current', required_action: finding.automation?.required_action || finding.recommended_action || null } : null
  };
}

function matchDetail(db, p, linkId, provider) {
  const link = (db.identityLinks || []).find(l => l.id === linkId && REVIEWABLE.has(l.outcome));
  if (!link) return null;
  const pair = visibleLinkRecords(link, recordMap(db), p);
  if (!pair) return null;
  const [reference, incoming] = orderPair(pair);
  const finding = findingFor(db, link);
  const decision = decisionFor(db, link);
  const fields = compareFields(db, link, reference, incoming);
  const history = (db.auditEvents || []).filter(e => finding && e.finding_id === finding.id).sort((a, b) => String(b.at).localeCompare(String(a.at))).map(e => ({ id: e.id, action: e.action, actor: e.actor, note: e.note, at: e.at, system: Boolean(e.system), link_id: e.link_id || null, from_state: e.from_state || null, to_state: e.to_state || null, receipt_id: e.receipt_id || null }));
  return {
    match: summaryEntry(db, link, pair, p),
    reference: { ...sourceRef(db, reference), role: 'reference', processing_status: reference.processing?.status || null },
    incoming: { ...sourceRef(db, incoming), role: 'incoming', processing_status: incoming.processing?.status || null },
    fields,
    explanation: matchExplanation(link, finding, decision),
    ai: aiContribution(db, finding, provider, link, fields),
    decisions: Object.entries(DECISIONS).map(([key, d]) => ({ key, label: d.label, final: d.final, requires_confirmation: key === 'same_person' })),
    decision: decision ? publicDecision(decision) : null,
    history
  };
}

class MatchError extends Error { constructor(status, message) { super(message); this.status = status; } }

// Records a reviewer decision. Final decisions (same / different) may only be reopened with
// "needs more evidence", mirroring the finding workflow. "Same person" needs explicit confirmation.
function decideMatch(db, p, linkId, input = {}) {
  const link = (db.identityLinks || []).find(l => l.id === linkId && REVIEWABLE.has(l.outcome));
  if (!link || !visibleLinkRecords(link, recordMap(db), p)) throw new MatchError(404, 'Potential match not found.');
  const decision = text(input.decision);
  if (!DECISIONS[decision]) throw new MatchError(400, 'Unsupported match decision. Use same_person, different_person or needs_more_evidence.');
  const note = text(input.note);
  if (!note) throw new MatchError(400, 'A decision note is required.');
  if (decision === 'same_person' && input.confirm !== true) throw new MatchError(400, 'Recording two records as the same person requires explicit confirmation (confirm: true).');
  const finding = findingFor(db, link);
  if (finding && !isCurrent(finding)) throw new MatchError(409, 'The finding for this pair is historical. Review the current finding instead.');
  const previous = decisionFor(db, link);
  if (previous && DECISIONS[previous.decision].final && decision !== 'needs_more_evidence') throw new MatchError(400, `This pair is already recorded as "${DECISIONS[previous.decision].label}". Reopen it with "Needs more evidence" before recording a different decision.`);
  if (previous && previous.decision === decision && !DECISIONS[decision].final) throw new MatchError(400, 'This pair is already waiting for more evidence.');
  const at = new Date().toISOString();
  const records = recordMap(db);
  const before = resolution(link, previous);
  const record = {
    decision, note: note.slice(0, 1000), reviewer: p.name, at, link_id: link.id, evidence_key: link.evidence_key || null, records: [...link.records], method: link.method,
    sources: link.records.map(id => sourceRef(db, records.get(id))),
    previous_state: before, new_state: resolution(link, { decision }),
    // The evidence the reviewer saw when deciding: field results and the policy outcome, no values.
    evidence: { agreeing_fields: link.agreeing_fields, similar_fields: link.similar_fields || [], conflicting_fields: link.conflicting_fields, missing_fields: link.missing_fields, disqualifiers: link.disqualifiers || [], score: link.score, outcome: link.outcome, policy_version: link.policy_version },
    history: previous ? [...(previous.history || []), { decision: previous.decision, note: previous.note, reviewer: previous.reviewer, at: previous.at, previous_state: previous.previous_state || null, new_state: previous.new_state || null, receipt_id: previous.receipt_id || null }] : []
  };
  const decisions = { ...(db.matchDecisions || {}) };
  if (link.evidence_key && decisions[link.key]) delete decisions[link.key];
  decisions[link.evidence_key || link.key] = record;
  db.matchDecisions = decisions;
  if (finding) {
    db.auditEvents.push({ id: `AUD-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`, finding_id: finding.id, link_id: link.id, action: `match_${decision}`, actor: p.name, note: record.note, at, from_state: record.previous_state, to_state: record.new_state, source_records: [...link.records] });
    // The finding's review status follows the decisions on all of its links.
    const links = (db.identityLinks || []).filter(l => (finding.identity_link_ids || []).includes(l.id) && REVIEWABLE.has(l.outcome));
    const decided = links.map(l => decisionFor(db, l));
    if (decided.some(d => d?.decision === 'needs_more_evidence')) finding.review_status = 'awaiting_verification';
    else if (decided.every(d => d && DECISIONS[d.decision].final)) {
      finding.review_status = 'resolved';
      finding.decision = { outcome: decided.length === 1 ? `match_${decided[0].decision}` : 'match_reviewed', note: record.note, reviewer: p.name, at };
    } else if (finding.review_status === 'awaiting_verification' && !decided.some(d => d?.decision === 'needs_more_evidence')) finding.review_status = 'pending';
  }
  return record;
}

// ── Source-record profile ──
// A read-only view built around one source record: the records joined to it by an automatic
// link or a reviewer's "same person" decision, plus every comparison involving them. The
// canonical attributes are derived for display only; source records are never changed.
function profile(db, p, recordId) {
  const records = recordMap(db);
  const root = records.get(recordId);
  if (!root || !canAccess(p, root)) return null;
  const links = db.identityLinks || [];
  const joins = links.filter(l => l.outcome === 'auto_linked' || l.outcome === 'same_source_record' || decisionFor(db, l)?.decision === 'same_person');
  const group = new Set([root.id]); const queue = [root.id];
  while (queue.length) {
    const current = queue.shift();
    joins.filter(l => l.records.includes(current)).forEach(l => l.records.forEach(other => {
      const r = records.get(other);
      if (!group.has(other) && r && canAccess(p, r)) { group.add(other); queue.push(other); }
    }));
  }
  const members = [...group].map(id => records.get(id)).sort((a, b) => String(a.academic_session).localeCompare(String(b.academic_session)) || String(a.imported_at || '').localeCompare(String(b.imported_at || '')));
  const hiddenMembers = joins.filter(l => l.records.some(id => group.has(id))).flatMap(l => l.records).filter(id => !group.has(id) && records.get(id) && !canAccess(p, records.get(id)));
  const attribute = (key, label, value = r => text(r[key])) => {
    const values = members.map(r => ({ value: value(r), record_id: r.id, institution_code: r.institution_code, source_row: r.source_row }));
    const distinct = [...new Set(values.map(v => v.value).filter(Boolean))];
    return { key, label, value: distinct.length === 1 ? distinct[0] : null, state: !distinct.length ? 'missing' : distinct.length === 1 ? (values.some(v => !v.value) ? 'partial' : 'consistent') : 'conflict', values };
  };
  const attributes = [
    attribute('student_name', 'Name'), attribute('date_of_birth', 'Date of birth'),
    { ...attribute('apaar_id', 'APAAR identifier', r => (r.apaar_id ? mask(r.apaar_id) : '')), verification: 'not_verified', note: 'Masked. Local format checks only; no authoritative verification.' },
    attribute('institution_code', 'Institution'), attribute('programme', 'Programme'), attribute('academic_session', 'Academic session'), attribute('enrolment_status', 'Enrolment status')
  ];
  const related = links.filter(l => l.records.some(id => group.has(id))).filter(l => l.records.every(id => records.get(id) && canAccess(p, records.get(id))));
  const memberFindings = db.findings.filter(f => f.evidence.some(id => group.has(id)) && f.evidence.every(id => records.get(id) && canAccess(p, records.get(id))));
  const findingIds = new Set(memberFindings.map(f => f.id));
  return {
    root_record_id: root.id, display_label: maskName(root.student_name),
    basis: members.length > 1 ? 'Source records joined by an automatic identifier link or a reviewer\'s "same person" decision. They are shown side by side; none has been merged or overwritten.' : 'A single source record. No other record is linked to it.',
    hidden_linked_records: hiddenMembers.length,
    attributes,
    processing: members.map(r => ({ record_id: r.id, institution_code: r.institution_code, source_row: r.source_row, status: r.processing?.status || null, identifier_check: identifierCheck(r) })),
    education: members.map(r => ({ record_id: r.id, institution_code: r.institution_code, institution_name: sourceRef(db, r).institution_name, programme: r.programme, academic_session: r.academic_session, admission_year: r.admission_year || null, enrolment_status: r.enrolment_status, source_file: r.source_file, source_row: r.source_row })),
    sources: members.map(r => ({ ...sourceRef(db, r), lineage: r.lineage ? { version: r.lineage.version, relation: r.lineage.relation } : null, superseded_by: r.superseded_by || null, student_name: r.student_name, date_of_birth: r.date_of_birth, apaar_id: r.apaar_id ? mask(r.apaar_id) : null, identifier_check: identifierCheck(r), original: Object.fromEntries(Object.entries(r.original || {}).map(([k, v]) => [k, k === 'apaar_id' && v ? mask(String(v).replace(/[\s-]/g, '')) : String(v ?? '').slice(0, 120)])), transformations: r.transformations || {} })),
    match_history: related.map(l => {
      const d = decisionFor(db, l); const f = findingFor(db, l);
      return { link_id: l.id, method: l.method, method_label: METHODS[l.method]?.label || l.method, outcome: l.outcome, resolution: resolution(l, d), resolution_label: RESOLUTIONS[resolution(l, d)], withdrawn: l.withdrawn || null, records: l.records.map(id => sourceRef(db, records.get(id))), agreeing_fields: l.agreeing_fields, conflicting_fields: l.conflicting_fields, missing_fields: l.missing_fields, score: l.score, reason: l.reason, decision: d ? publicDecision(d) : null, finding_id: f?.id || null, reviewable: REVIEWABLE.has(l.outcome) };
    }),
    audit: (db.auditEvents || []).filter(e => findingIds.has(e.finding_id)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 50).map(e => ({ id: e.id, finding_id: e.finding_id, action: e.action, actor: e.actor, note: e.note, at: e.at, system: Boolean(e.system) })),
    conflicts: {
      fields: attributes.filter(a => a.state === 'conflict' && ['student_name', 'date_of_birth', 'apaar_id'].includes(a.key)),
      findings: memberFindings.filter(f => isCurrent(f)).map(f => ({ id: f.id, rule_code: f.rule_code, title: f.title, severity: f.severity, review_status: f.review_status, decision: f.decision ? { outcome: f.decision.outcome, note: f.decision.note, reviewer: f.decision.reviewer, at: f.decision.at } : null }))
    }
  };
}

module.exports = { DECISIONS, METHODS, REVIEWABLE, RESOLUTIONS, ACTION_LABELS, MatchError, maskName, resolution, decisionFor, matchExplanationInput, explainMatch, listMatches, matchDetail, decideMatch, profile };
