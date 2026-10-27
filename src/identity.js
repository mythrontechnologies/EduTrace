// Explainable identity resolution (policy auto-link-2).
//
// A layered, deterministic pipeline. No language model takes part in any outcome here.
//   A. Identifiers. Only a locally well-formed identifier (12 digits after removing spaces and
//      hyphens) is usable evidence; it is compared as a protected fingerprint. A malformed value is
//      never identifier evidence, even when two records carry the same malformed value. Local
//      format checks are not authoritative APAAR verification.
//   B. Normalisation. Records arrive normalised by the engine (trim, Unicode NFKC, case, dates);
//      names are additionally folded for comparison only (src/names.js). Source values never change.
//   C. Candidate generation by blocking, not all pairs: records sharing a usable identifier; records
//      sharing a date of birth; and records sharing a folded name key (so a missing date of birth
//      is visible as such). Pairs inside one institution without a shared identifier are not
//      proposed, so resubmitted files do not produce candidates against themselves.
//   D. Evidence. Every compared pair records the fields compared, agreements, similar values,
//      conflicts, missing values, the contributing factors with their fixed weights, any
//      disqualifying contradiction and the reason for the outcome.
//   E. Policy. Outcomes:
//      auto_linked           AUTO_MATCHED: usable identifier agrees, names exact or equivalent,
//                            dates of birth present and equal, and no record sharing the identifier
//                            conflicts. The only automatic association.
//      needs_investigation   POTENTIAL_MATCH with a contradiction: the identifier agrees but the
//                            name or date of birth disagrees (here or elsewhere in the group).
//      candidate_for_review  POTENTIAL_MATCH: evidence is suggestive but incomplete (identifier
//                            agrees with a missing date of birth or an initial; or no shared usable
//                            identifier with matching date of birth and exact, equivalent or similar
//                            names; or a shared malformed identifier). Never linked automatically.
//      insufficient_evidence Same or equivalent names but a date of birth is missing and no usable
//                            identifier is shared. Recorded for transparency, not proposed.
//      not_linked            NO_SUPPORTED_MATCH: compared, but the evidence does not support a match
//                            (different names, or a contradicting date of birth).
//      same_source_record    the two records are the same source row re-sent unchanged (same lineage,
//                            src/lineage.js). Not an identity inference: no evidence is weighed.
// The score is a fixed weighting of field agreement for ordering and display. It is not a
// probability and it never decides an outcome on its own.
const crypto = require('node:crypto');
const { compareNames, nameKey, CANDIDATE_SIMILARITY } = require('./names');

const AUTO_LINK_POLICY = {
  version: 'auto-link-2',
  conditions: [
    'Both records carry the same locally well-formed identifier (exact protected-fingerprint comparison). Malformed values are never used.',
    'Student names are identical, or equivalent after comparison folding (case, whitespace, diacritics, punctuation, word order, documented abbreviations).',
    'Dates of birth are present on both records and identical.',
    'No other record sharing the identifier has a different name or date of birth.'
  ],
  never: 'Records are never linked automatically on name similarity, on an initial, on date of birth alone, on a malformed identifier, when an attribute is missing or conflicts, or on a model suggestion.'
};
const WEIGHTS = { identifier_agree: 8, identifier_conflict: -10, name_exact: 4, name_equivalent: 4, name_similar: 2, name_conflict: -4, dob_agree: 3, dob_conflict: -5 };
const MAX_SCORE = WEIGHTS.identifier_agree + WEIGHTS.name_exact + WEIGHTS.dob_agree;
const RECORD_SIMILARITY_FLOOR = 0.5;

const pct = n => `${Math.round(n * 100)}%`;
const usableId = r => (r.apaar_id && /^\d{12}$/.test(r.apaar_id) ? r.apaar_fingerprint : null);
const identifierState = r => (!r.apaar_id ? 'missing' : usableId(r) ? 'usable' : 'malformed');
function linkId(key) { return `LNK-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 14)}`; }
// Identity evidence of one record; used to key reviewer decisions so they survive an unchanged
// resubmission but not a change to the evidence.
function identitySignature(r) { return [r.institution_code, nameKey(r.normalized_name), r.date_of_birth || '', usableId(r) || (r.apaar_id ? `malformed:${r.apaar_fingerprint}` : '')].join('|'); }

// Field-by-field comparison. Only field names, results and weights are recorded — never values.
function compareRecords(a, b) {
  const agreeing = []; const similar = []; const conflicting = []; const missing = []; const factors = []; const disqualifiers = [];
  const factor = (field, result, weight, note) => factors.push({ field, result, weight, note });
  const idA = identifierState(a); const idB = identifierState(b);
  if (idA === 'usable' && idB === 'usable') {
    if (usableId(a) === usableId(b)) { agreeing.push('identifier'); factor('identifier', 'agree', WEIGHTS.identifier_agree, 'Same well-formed identifier (protected fingerprint).'); }
    else { conflicting.push('identifier'); factor('identifier', 'conflict', WEIGHTS.identifier_conflict, 'Different well-formed identifiers.'); disqualifiers.push('identifier_conflict'); }
  } else {
    missing.push('identifier');
    const malformed = idA === 'malformed' || idB === 'malformed';
    factor('identifier', malformed ? 'not_usable' : 'missing', 0, malformed ? 'A malformed identifier is not identifier evidence.' : 'An identifier is missing on at least one record.');
    if (idA === 'malformed' && idB === 'malformed' && a.apaar_fingerprint === b.apaar_fingerprint) disqualifiers.push('shared_malformed_identifier');
  }
  const name = compareNames(a.normalized_name, b.normalized_name);
  if (name.result === 'missing') { missing.push('student_name'); factor('student_name', 'missing', 0, name.note); }
  else if (name.result === 'exact' || name.result === 'equivalent') { agreeing.push('student_name'); factor('student_name', name.result, WEIGHTS[`name_${name.result}`], name.note); }
  else if (name.result === 'similar') { similar.push('student_name'); factor('student_name', 'similar', WEIGHTS.name_similar, name.note); }
  else { conflicting.push('student_name'); factor('student_name', 'conflict', WEIGHTS.name_conflict, name.note); }
  if (!a.date_of_birth || !b.date_of_birth) { missing.push('date_of_birth'); factor('date_of_birth', 'missing', 0, 'A date of birth is missing on at least one record.'); }
  else if (a.date_of_birth === b.date_of_birth) { agreeing.push('date_of_birth'); factor('date_of_birth', 'agree', WEIGHTS.dob_agree, 'Identical after normalisation to YYYY-MM-DD.'); }
  else { conflicting.push('date_of_birth'); factor('date_of_birth', 'conflict', WEIGHTS.dob_conflict, 'Different dates of birth.'); }
  if (agreeing.includes('identifier')) {
    if (conflicting.includes('date_of_birth')) disqualifiers.push('date_of_birth_conflict');
    if (conflicting.includes('student_name')) disqualifiers.push('name_conflict');
  }
  return {
    agreeing_fields: agreeing, similar_fields: similar, conflicting_fields: conflicting, missing_fields: missing,
    name_similarity: name.similarity, name_comparison: { result: name.result, method: name.method, note: name.note },
    identifier_states: [idA, idB], score: factors.reduce((n, f) => n + f.weight, 0), score_max: MAX_SCORE, factors, disqualifiers,
    context: { same_institution: a.institution_code === b.institution_code, same_programme: a.programme === b.programme, same_session: a.academic_session === b.academic_session, both_active: a.enrolment_status === 'active' && b.enrolment_status === 'active' }
  };
}

function link(a, b, method, comparison, outcome, reason) {
  const ids = [a.id, b.id].sort();
  const key = `${method}|${ids.join('|')}`;
  const evidence_key = crypto.createHash('sha256').update(`${method}|${[identitySignature(a), identitySignature(b)].sort().join('||')}`).digest('hex').slice(0, 20);
  return { id: linkId(key), key, evidence_key, records: ids, method, ...comparison, outcome, reason, policy_version: AUTO_LINK_POLICY.version };
}

// Rebuilt from the persisted source records on every run, with stable ids, so repeated
// processing yields the same links rather than accumulating new ones.
function buildIdentityLinks(records) {
  const links = [];
  const compared = new Set();
  const pairKey = (a, b) => [a.id, b.id].sort().join('|');

  // A. Records sharing an identifier value. Usable identifiers can link; a shared malformed value
  //    is surfaced for review but is never identifier evidence.
  const byFingerprint = new Map();
  records.forEach(r => { if (r.apaar_fingerprint) byFingerprint.set(r.apaar_fingerprint, [...(byFingerprint.get(r.apaar_fingerprint) || []), r]); });
  for (const [fp, group] of byFingerprint) {
    if (group.length < 2) continue;
    const usable = group.every(r => usableId(r));
    group.forEach((a, i) => group.slice(i + 1).forEach(b => compared.add(pairKey(a, b))));
    const comparisons = group.slice(1).map(other => ({ other, comparison: compareRecords(group[0], other) }));
    const groupConflict = comparisons.some(c => c.comparison.disqualifiers.length);
    comparisons.forEach(({ other, comparison }) => {
      let outcome; let reason;
      const sameLineage = group[0].lineage?.id && group[0].lineage.id === other.lineage?.id;
      if (sameLineage && !comparison.disqualifiers.filter(d => d !== 'shared_malformed_identifier').length) {
        outcome = 'same_source_record';
        reason = 'The same source record was re-sent unchanged (one lineage). This is not an identity inference; the earlier row and the copy are the same submission.';
      } else if (!usable) {
        outcome = 'candidate_for_review';
        reason = 'Candidate only: the records share an identifier value that is not well-formed, so it cannot be used as identifier evidence. Correct the identifier at source before any link.';
      } else if (comparison.disqualifiers.length) {
        outcome = 'needs_investigation';
        reason = `Not linked: the records share an identifier but ${comparison.conflicting_fields.filter(f => f !== 'identifier').map(f => f.replaceAll('_', ' ')).join(' and ')} ${comparison.conflicting_fields.length > 1 ? 'differ' : 'differs'}. Which record is correct is not established.`;
      } else if (groupConflict) {
        outcome = 'needs_investigation';
        reason = `Not linked: these two records agree, but another of the ${group.length} records sharing this identifier has a different name or date of birth, so the identifier cannot safely link any of them.`;
      } else if (comparison.agreeing_fields.includes('student_name') && comparison.agreeing_fields.includes('date_of_birth')) {
        outcome = 'auto_linked';
        reason = `Automatically linked under policy ${AUTO_LINK_POLICY.version}: the well-formed identifier, ${comparison.name_comparison.result === 'equivalent' ? 'equivalent names' : 'the normalised name'} and date of birth agree, and no record sharing this identifier has different attributes.${comparison.name_comparison.result === 'equivalent' ? ` ${comparison.name_comparison.note}` : ''}`;
      } else {
        outcome = 'candidate_for_review';
        reason = `Candidate only: the identifier agrees, but ${comparison.missing_fields.includes('date_of_birth') ? 'a date of birth is missing' : 'the names are only similar (for example an initial)'}, so the policy does not allow an automatic link.`;
      }
      links.push({ ...link(group[0], other, 'protected_identifier_exact', comparison, outcome, reason), group_key: `fp:${fp}` });
    });
  }

  // C. Blocking for records without a shared usable identifier: by date of birth and by folded name.
  const blocks = new Map();
  const addTo = (key, r) => { if (key) blocks.set(key, [...(blocks.get(key) || []), r]); };
  records.forEach(r => { addTo(r.date_of_birth ? `dob:${r.date_of_birth}` : null, r); addTo(r.normalized_name ? `name:${nameKey(r.normalized_name)}` : null, r); });
  const fuzzy = [];
  for (const block of blocks.values()) {
    if (block.length < 2) continue;
    for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
      const a = block[i]; const b = block[j];
      const key = pairKey(a, b);
      if (compared.has(key)) continue;
      compared.add(key);
      if (a.institution_code === b.institution_code) continue;
      if (usableId(a) && usableId(b)) continue; // different usable identifiers: no supported match
      const comparison = compareRecords(a, b);
      const name = comparison.name_comparison.result;
      if (comparison.name_similarity < RECORD_SIMILARITY_FLOOR && name !== 'similar') continue;
      let outcome; let reason;
      if (comparison.conflicting_fields.includes('date_of_birth')) {
        if (name !== 'exact' && name !== 'equivalent') continue;
        outcome = 'not_linked';
        reason = 'Not linked: the names agree but the dates of birth differ, and no shared identifier connects the records. Treated as different students unless new evidence arrives.';
      } else if (comparison.missing_fields.includes('date_of_birth')) {
        if (name !== 'exact' && name !== 'equivalent') continue;
        outcome = 'insufficient_evidence';
        reason = 'Not proposed: the names agree, but a date of birth is missing and no usable identifier is shared. A name alone is not enough to propose a match.';
      } else if (name === 'exact' || name === 'equivalent' || name === 'similar') {
        outcome = 'candidate_for_review';
        reason = `Candidate only: dates of birth agree and the names are ${name === 'exact' ? 'identical' : name === 'equivalent' ? 'equivalent after folding' : `similar (${comparison.name_comparison.method === 'initials' ? 'an initial' : `${pct(comparison.name_similarity)} of words`})`}, but no shared usable identifier confirms identity. Name evidence never links records automatically.`;
      } else {
        outcome = 'not_linked';
        reason = `Not linked: dates of birth agree but only ${pct(comparison.name_similarity)} of name words match (below the ${pct(CANDIDATE_SIMILARITY)} review threshold).`;
      }
      fuzzy.push(link(a, b, 'name_dob_similarity', comparison, outcome, reason));
    }
  }

  // Competing candidates: a record proposed against more than one other record is ambiguous.
  const perRecord = new Map();
  fuzzy.filter(l => l.outcome === 'candidate_for_review').forEach(l => l.records.forEach(id => perRecord.set(id, (perRecord.get(id) || 0) + 1)));
  fuzzy.forEach(l => {
    const competing = Math.max(...l.records.map(id => perRecord.get(id) || 0));
    if (l.outcome === 'candidate_for_review' && competing > 1) {
      l.competing_candidates = competing;
      l.disqualifiers = [...l.disqualifiers, 'competing_candidates'];
      l.reason += ` ${competing} records are equally plausible candidates for the same record, so at most one of these pairs can be right.`;
    }
  });
  return [...links, ...fuzzy];
}

module.exports = { AUTO_LINK_POLICY, WEIGHTS, MAX_SCORE, CANDIDATE_SIMILARITY, compareRecords, buildIdentityLinks, identitySignature, usableId };
