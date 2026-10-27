// FROZEN BASELINE (policy auto-link-1), kept only so the identity evaluation can compare the
// previous matcher with the current one on the same data. The application does not use it.
// Explainable identity resolution.
//
// Pairs of source records that might describe the same student are found by blocking
// (shared protected identifier, or shared date of birth when an identifier is missing) and
// compared field by field. Each comparison is persisted as an identity link that records the
// source records, the fields that agree, conflict or are missing, the method, a weighted
// evidence score and the reason for the outcome.
//
// The score is a fixed, documented weighting of field agreement (not a trained model). The
// outcome is decided by explicit policy, not by the score alone:
//   auto_linked           — protected identifier, normalised name and date of birth all agree,
//                           and no other record shares the identifier with different attributes.
//   needs_investigation   — the identifier is shared but name or date of birth disagree.
//   candidate_for_review  — no shared identifier; date of birth agrees and name-token similarity
//                           is at least 80% across different institutions. Never merged automatically.
//   not_linked            — weaker evidence, recorded for transparency only.
const crypto = require('node:crypto');
const { similarity } = require('./names');

const AUTO_LINK_POLICY = {
  version: 'auto-link-1',
  conditions: [
    'Both records carry the same protected identifier (exact fingerprint comparison).',
    'Normalised student names are identical.',
    'Dates of birth are present on both records and identical.',
    'No other record shares the identifier with a different name or date of birth.'
  ],
  never: 'Records are never linked automatically on name similarity, on date of birth alone, or when any identity attribute conflicts.'
};
const WEIGHTS = { identifier_agree: 8, identifier_conflict: -10, name_exact: 4, name_similar: 2, name_conflict: -4, dob_agree: 3, dob_conflict: -5 };
const CANDIDATE_SIMILARITY = 0.8;
const RECORD_SIMILARITY_FLOOR = 0.5;

const pct = n => `${Math.round(n * 100)}%`;
function linkId(key) { return `LNK-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 14)}`; }

// Field-by-field comparison. Only field names and match results are recorded — never values.
function compareRecords(a, b) {
  const agreeing = []; const conflicting = []; const missing = []; let score = 0;
  if (a.apaar_fingerprint && b.apaar_fingerprint) {
    if (a.apaar_fingerprint === b.apaar_fingerprint) { agreeing.push('identifier'); score += WEIGHTS.identifier_agree; }
    else { conflicting.push('identifier'); score += WEIGHTS.identifier_conflict; }
  } else missing.push('identifier');
  const nameSimilarity = similarity(a.normalized_name, b.normalized_name);
  if (!a.normalized_name || !b.normalized_name) missing.push('student_name');
  else if (nameSimilarity === 1) { agreeing.push('student_name'); score += WEIGHTS.name_exact; }
  else if (nameSimilarity >= CANDIDATE_SIMILARITY) { agreeing.push('student_name'); score += WEIGHTS.name_similar; }
  else { conflicting.push('student_name'); score += WEIGHTS.name_conflict; }
  if (!a.date_of_birth || !b.date_of_birth) missing.push('date_of_birth');
  else if (a.date_of_birth === b.date_of_birth) { agreeing.push('date_of_birth'); score += WEIGHTS.dob_agree; }
  else { conflicting.push('date_of_birth'); score += WEIGHTS.dob_conflict; }
  return {
    agreeing_fields: agreeing, conflicting_fields: conflicting, missing_fields: missing,
    name_similarity: Number(nameSimilarity.toFixed(2)), score,
    context: { same_institution: a.institution_code === b.institution_code, same_programme: a.programme === b.programme, same_session: a.academic_session === b.academic_session, both_active: a.enrolment_status === 'active' && b.enrolment_status === 'active' }
  };
}

function link(a, b, method, comparison, outcome, reason) {
  const ids = [a.id, b.id].sort();
  const key = `${method}|${ids.join('|')}`;
  return { id: linkId(key), key, records: ids, method, ...comparison, outcome, reason, policy_version: AUTO_LINK_POLICY.version };
}

// Rebuilt from the persisted source records on every run, with stable ids, so repeated
// processing yields the same links rather than accumulating new ones.
function buildIdentityLinks(records) {
  const links = [];
  const byFingerprint = new Map();
  records.forEach(r => { if (r.apaar_fingerprint) byFingerprint.set(r.apaar_fingerprint, [...(byFingerprint.get(r.apaar_fingerprint) || []), r]); });
  for (const [fp, group] of byFingerprint) {
    if (group.length < 2) continue;
    const signatures = new Set(group.map(r => `${r.normalized_name}|${r.date_of_birth}`));
    const complete = group.every(r => r.normalized_name && r.date_of_birth);
    const safe = signatures.size === 1 && complete;
    // Each record is compared with the group's first record (a star keeps the link count linear).
    group.slice(1).forEach(other => {
      const comparison = compareRecords(group[0], other);
      const reason = safe
        ? `Automatically linked under policy ${AUTO_LINK_POLICY.version}: the protected identifier, normalised name and date of birth all agree, and no record sharing this identifier has different attributes.`
        : signatures.size > 1
          ? `Not linked: the identifier is shared by ${group.length} records whose names or dates of birth differ. Which record is correct is not established.`
          : 'Not linked: a date of birth is missing, so identity cannot be confirmed from the available attributes.';
      links.push({ ...link(group[0], other, 'protected_identifier_exact', comparison, safe ? 'auto_linked' : 'needs_investigation', reason), group_key: `fp:${fp}` });
    });
  }
  // Records without a shared identifier: block on date of birth, compare names across institutions.
  const byDob = new Map();
  records.forEach(r => { if (r.date_of_birth) byDob.set(r.date_of_birth, [...(byDob.get(r.date_of_birth) || []), r]); });
  for (const block of byDob.values()) {
    for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) {
      const a = block[i]; const b = block[j];
      if ((a.apaar_fingerprint && b.apaar_fingerprint) || a.institution_code === b.institution_code) continue;
      const comparison = compareRecords(a, b);
      if (comparison.name_similarity < RECORD_SIMILARITY_FLOOR) continue;
      const candidate = comparison.name_similarity >= CANDIDATE_SIMILARITY;
      links.push(link(a, b, 'name_dob_similarity', comparison, candidate ? 'candidate_for_review' : 'not_linked', candidate
        ? `Candidate only: dates of birth agree and ${pct(comparison.name_similarity)} of name tokens match, but no shared identifier confirms identity. Name similarity never links records automatically.`
        : `Not linked: dates of birth agree but only ${pct(comparison.name_similarity)} of name tokens match (below the ${pct(CANDIDATE_SIMILARITY)} review threshold).`));
    }
  }
  return links;
}

module.exports = { AUTO_LINK_POLICY, WEIGHTS, CANDIDATE_SIMILARITY, compareRecords, buildIdentityLinks };
