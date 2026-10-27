const crypto = require('node:crypto');
const { similarity } = require('./names');
const { buildIdentityLinks } = require('./identity');

const APaar = /^\d{12}$/;
const REQUIRED = ['student_name', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
const FIELD_DEFINITIONS = [
  ['apaar_id', 'APAAR ID', false], ['student_name', 'Student name', true], ['date_of_birth', 'Date of birth', false],
  ['institution_code', 'Institution code', true], ['institution_name', 'Institution name', false], ['programme', 'Programme', true],
  ['academic_session', 'Academic session', true], ['admission_year', 'Admission year', false], ['enrolment_status', 'Enrolment status', true], ['seat_category', 'Seat category', false],
  ['source_reference', 'Institution student reference', false]
].map(([key, label, required]) => ({ key, label, required }));
const ALIASES = {
  apaar_id: ['apaar id', 'apaar_id', 'student id', 'student_id', 'abc id'],
  student_name: ['student name', 'student_name', 'name', 'full name', 'full_name', 'candidate name', 'candidate_name'],
  date_of_birth: ['date of birth', 'date_of_birth', 'dob', 'birth date', 'birth_date'],
  institution_code: ['institution', 'institution code', 'institution_code', 'college code', 'college_code', 'college'],
  institution_name: ['institution name', 'institution_name', 'college name', 'college_name'],
  programme: ['programme', 'program', 'course'],
  academic_session: ['academic session', 'academic_session', 'session', 'academic year', 'academic_year'],
  enrolment_status: ['status', 'enrolment status', 'enrolment_status', 'enrollment status', 'enrollment_status'],
  admission_year: ['admission year', 'admission_year', 'year of admission', 'year_of_admission'],
  seat_category: ['seat category', 'seat_category', 'admission category', 'admission_category', 'category'],
  // The institution's own stable reference for the student record (not the CSV row number).
  source_reference: ['source reference', 'source_reference', 'student reference', 'student ref', 'admission no', 'admission number', 'enrolment no', 'enrolment number', 'enrollment no', 'enrollment number', 'registration no', 'registration number', 'roll no', 'roll number']
};

function id() { return crypto.randomUUID(); }
// A source record replaced by a corrected version (src/lineage.js) is kept for audit but inactive.
function isActiveRecord(r) { return !r.superseded_by; }
function fingerprint(value) { return value ? crypto.createHash('sha256').update(`edutrace-demo:${value}`).digest('hex').slice(0, 18) : null; }
function mask(value) { return value && value.length > 4 ? `•••• •••• ${value.slice(-4)}` : 'Not provided'; }
function clean(value) { return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' '); }
function normaliseName(value) { return clean(value).toLocaleLowerCase('en-IN'); }
function normaliseStatus(value) { const v = normaliseName(value); return ['active', 'enrolled', 'enrolment active'].includes(v) ? 'active' : ['transferred', 'completed', 'withdrawn'].includes(v) ? v : v; }
function normaliseDate(value) {
  const raw = clean(value); if (!raw) return '';
  const bits = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (bits) return `${bits[3]}-${bits[2].padStart(2, '0')}-${bits[1].padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : raw;
}
function normaliseRecord(row) {
  const original = { ...row };
  const value = key => row[key] ?? '';
  const apaarId = clean(value('apaar_id')).replace(/[\s-]/g, '');
  return {
    original, student_name: clean(value('student_name')), normalized_name: normaliseName(value('student_name')),
    date_of_birth: normaliseDate(value('date_of_birth')), apaar_id: apaarId,
    apaar_fingerprint: fingerprint(apaarId), institution_code: clean(value('institution_code')).toUpperCase(),
    institution_name: clean(value('institution_name')), programme: clean(value('programme')).toUpperCase(), academic_session: clean(value('academic_session')),
    admission_year: clean(value('admission_year')), enrolment_status: normaliseStatus(value('enrolment_status')), seat_category: clean(value('seat_category')).toUpperCase(), source_reference: clean(value('source_reference')).toUpperCase(),
    transformations: { student_name: 'trim + Unicode NFKC', date_of_birth: 'normalised when recognised', apaar_id: 'spaces and hyphens removed; original retained', enrolment_status: 'mapped to canonical value' }
  };
}
function schemaSuggestion(headers) {
  const used = new Set(); const mapping = {};
  for (const canonical of Object.keys(ALIASES)) {
    const found = headers.find(h => !used.has(h) && ALIASES[canonical].includes(normaliseName(h)));
    if (found) { mapping[canonical] = found; used.add(found); }
  }
  return mapping;
}
function validate(record) {
  const issues = REQUIRED.filter(k => !record[k]).map(field => ({ code: 'REQUIRED_FIELD_MISSING', field, severity: 'high' }));
  if (!record.apaar_id) issues.push({ code: 'APAAR_MISSING', field: 'apaar_id', severity: 'medium' });
  else if (!APaar.test(record.apaar_id)) issues.push({ code: 'APAAR_MALFORMED', field: 'apaar_id', severity: 'high' });
  return issues;
}
// original_evidence keeps the evidence as raised; mergeFindings may later add resubmitted records to evidence.
function finding(data, attrs) { return { id: id(), rule_version: 'demo-1.0', review_status: 'pending', lifecycle_status: 'current', created_at: new Date().toISOString(), ...attrs, evidence: data, original_evidence: [...data] }; }

// ── Capacity lifecycle ──────────────────────────
// A capacity condition is identified by its configured rule scope, not by the exact set of
// evidence rows, so recomputation updates one condition instead of accumulating findings.
const CAPACITY_RULE = 'DEMO_INTAKE_LIMIT_EXCEEDED';
const SYSTEM_ACTOR = 'EduTrace reconciliation engine (automated)';
function isCurrent(f) { return !f.lifecycle_status || f.lifecycle_status === 'current'; }
function seatCategory(rule) { return rule.seat_category ? clean(rule.seat_category).toUpperCase() : null; }
function capacityKey(rule) { return [rule.institution_code, rule.programme, rule.academic_session, seatCategory(rule) || '*'].join('|'); }
function capacityKeyOf(f, db) {
  if (f.condition_key) return f.condition_key;
  const first = db.sourceRecords.find(r => r.id === f.evidence[0]);
  return first ? [first.institution_code, first.programme, first.academic_session, '*'].join('|') : null;
}
// Counting method (prototype): one enrolment per student identity — the same protected identifier,
// normalised name and date of birth — decided by that identity's most recent source record.
// Rows without an identifier are counted individually. Records are persisted append-only, so
// array order is import order.
// Without an identifier, records are never merged on name and date of birth: two such rows in one
// file count as two students. A resubmitted file must not inflate the count either, so an
// identifier-less row is keyed by name, date of birth and its occurrence within its own batch.
function identityKey(r, occurrence = 0) {
  if (r.apaar_fingerprint) return `id:${r.apaar_fingerprint}|${r.normalized_name}|${r.date_of_birth}`;
  return r.normalized_name && r.date_of_birth ? `noid:${r.institution_code}|${r.normalized_name}|${r.date_of_birth}#${occurrence}` : `row:${r.id}`;
}
function capacityState(records, rule) {
  const seat = seatCategory(rule); const latest = new Map(); const seen = new Map(); const keyOf = new Map();
  records.forEach(r => {
    if (r.institution_code !== rule.institution_code || r.programme !== rule.programme || r.academic_session !== rule.academic_session) return;
    if (seat && r.seat_category !== seat) return;
    let occurrence = 0;
    if (!r.apaar_fingerprint) {
      const inBatch = `${r.import_id || r.source_file}|${r.normalized_name}|${r.date_of_birth}`;
      occurrence = seen.get(inBatch) || 0;
      seen.set(inBatch, occurrence + 1);
    }
    const k = identityKey(r, occurrence);
    keyOf.set(r.id, k);
    latest.set(k, r);
  });
  const active = [...latest].filter(([, r]) => r.enrolment_status === 'active');
  const counted = active.map(([, r]) => r);
  return { key: capacityKey(rule), rule, seat_category: seat, counted, identity_keys: active.map(([k]) => k), key_of: keyOf, observed_active: counted.length, permitted_capacity: rule.permitted_capacity, exceeded: counted.length > rule.permitted_capacity };
}
function capacityDetails(state) { return { institution_code: state.rule.institution_code, programme: state.rule.programme, academic_session: state.rule.academic_session, seat_category: state.seat_category, permitted_capacity: state.permitted_capacity, observed_active: state.observed_active }; }
// Finding text builders, shared by reconcile() and the current assessment (src/assessment.js): a
// recomputed explanation is word for word what a newly raised finding would say.
const VALIDATION_TITLES = { APAAR_MISSING: 'Identifier missing', APAAR_MALFORMED: 'Identifier format requires correction', REQUIRED_FIELD_MISSING: 'Required value missing' };
function validationExplanation(field, r) { return `${field} needs review in source row ${r.source_row}. Local format checks are not authoritative verification.`; }
const GROUP_TEXT = {
  IDENTIFIER_ATTRIBUTE_CONFLICT: { title: 'Shared identifier has conflicting identity attributes', explanation: 'A protected exact identifier match is paired with differing name or date-of-birth values. This is a potential discrepancy, not proof.' },
  DUPLICATE_IDENTIFIER: { title: 'Repeated identifier submission', explanation: 'The same protected identifier was submitted more than once. Review source rows for a legitimate repeat.' }
};
const CONCURRENT_EXPLANATION = 'An exact protected identifier occurs in active enrolments at more than one institution in the same session. Transfers and approved dual programmes require review.';
function candidateExplanation(l) {
  const name = l.name_comparison;
  const nameText = name.result === 'exact' ? 'Names are identical' : name.result === 'equivalent' ? 'Names are equivalent after folding' : name.method === 'initials' ? 'Names agree except for an initial' : `Name-word similarity ${Math.round(l.name_similarity * 100)}%`;
  return `${nameText} and the date of birth agrees; no usable identifier is shared${l.competing_candidates ? `, and ${l.competing_candidates} records are equally plausible candidates` : ''}. This is inconclusive and records were not merged.`;
}
function capacityExplanation(state) {
  const scope = `${state.rule.programme} (${state.rule.academic_session}${state.seat_category ? `, seat category ${state.seat_category}` : ''})`;
  return `${state.observed_active} active enrolments observed against configured prototype capacity ${state.permitted_capacity} for ${scope} at ${state.rule.institution_code}. Each student identity is counted once using its most recent source record. This is not an official regulatory interpretation.`;
}
function capacityFinding(state, attrs = {}) {
  return finding(state.counted.map(r => r.id), { rule_code: CAPACITY_RULE, category: 'capacity', severity: 'high', confidence: null, title: 'Configured demonstration intake limit exceeded', explanation: capacityExplanation(state), recommended_action: 'Review capacity configuration and included records.', condition_key: state.key, capacity: capacityDetails(state), ...attrs });
}
function sameEvidence(a, b) { return [...a].sort().join('|') === [...b].sort().join('|'); }
function syncCapacityFindings(db, { at = new Date().toISOString(), reason = 'after revalidation' } = {}) {
  const result = { created: [], superseded: [], cleared: [], unchanged: [] };
  const transition = (f, status, note, replacement) => {
    f.condition_key = capacityKeyOf(f, db); f.lifecycle_status = status; f.lifecycle_changed_at = at; f.lifecycle_reason = note;
    if (replacement) f.superseded_by = replacement.id;
    db.auditEvents.push({ id: `AUD-SYS-${id()}`, finding_id: f.id, action: status === 'superseded' ? 'superseded' : 'condition_cleared', actor: SYSTEM_ACTOR, note, at, system: true, ...(replacement ? { replacement_finding_id: replacement.id } : {}) });
    result[status === 'superseded' ? 'superseded' : 'cleared'].push(f);
  };
  const keys = new Set();
  for (const rule of db.capacityRules) {
    const state = capacityState(db.sourceRecords.filter(isActiveRecord), rule); keys.add(state.key);
    const current = db.findings.filter(f => f.rule_code === CAPACITY_RULE && isCurrent(f) && capacityKeyOf(f, db) === state.key);
    if (!state.exceeded) {
      current.forEach(f => transition(f, 'cleared', `Capacity recomputed ${reason}: ${state.observed_active} active enrolments against configured capacity ${state.permitted_capacity}. The configured limit is no longer exceeded.`));
      continue;
    }
    const counted = state.counted.map(r => r.id);
    const samePermit = f => (f.capacity?.permitted_capacity ?? state.permitted_capacity) === state.permitted_capacity;
    let active = current.find(f => sameEvidence(f.evidence, counted) && samePermit(f));
    // The same students can be counted through different source records when a student is
    // resubmitted (the newest record represents the identity). That is not a material change:
    // the evidence is updated in place, with an audit event, and the review status is kept.
    if (!active) {
      const wanted = [...state.identity_keys].sort().join('||');
      active = current.find(f => samePermit(f) && f.evidence.map(rid => db.sourceRecords.find(r => r.id === rid)).filter(Boolean).map(r => state.key_of.get(r.id) || identityKey(r)).sort().join('||') === wanted);
      if (active) {
        db.auditEvents.push({ id: `AUD-SYS-${id()}`, finding_id: active.id, action: 'evidence_updated', actor: SYSTEM_ACTOR, note: `Capacity recomputed ${reason}: the same ${state.observed_active} students are counted, but resubmitted source records now represent some of them. Evidence updated; the condition and its review status are unchanged.`, at, system: true });
        active.evidence = counted;
      }
    }
    if (active) {
      Object.assign(active, { condition_key: state.key, lifecycle_status: 'current', capacity: capacityDetails(state), last_validated_at: at }); result.unchanged.push(active);
    } else {
      active = capacityFinding(state, { created_at: at, last_validated_at: at, supersedes: current.map(f => f.id) });
      db.findings.push(active); result.created.push(active);
    }
    current.filter(f => f !== active).forEach(f => transition(f, 'superseded', `Capacity recomputed ${reason}: ${state.observed_active} active enrolments now counted against configured capacity ${state.permitted_capacity} (this finding counted ${f.evidence.length}). Replaced by the current finding.`, active));
  }
  db.findings.filter(f => f.rule_code === CAPACITY_RULE && isCurrent(f) && !keys.has(capacityKeyOf(f, db)))
    .forEach(f => transition(f, 'cleared', `Capacity recomputed ${reason}: no capacity rule is configured for this condition any more.`));
  return result;
}
// Older demo databases stored capacity findings without a condition key; bring them into the lifecycle once.
function needsCapacityMigration(db) { return db.findings.some(f => f.rule_code === CAPACITY_RULE && isCurrent(f) && !f.condition_key); }
function reconcile(db) {
  // Superseded versions of corrected source records keep their data but no longer take part.
  const records = db.sourceRecords.filter(isActiveRecord); const findings = [];
  records.forEach(r => validate(r).forEach(issue => findings.push(finding([r.id], { rule_code: issue.code, field: issue.field, category: 'identifier', severity: issue.severity, confidence: null, title: VALIDATION_TITLES[issue.code], explanation: validationExplanation(issue.field, r), recommended_action: 'Correct or obtain an authorised source record.' }))));
  const byFingerprint = new Map(); records.filter(r => r.apaar_fingerprint).forEach(r => { const v = byFingerprint.get(r.apaar_fingerprint) || []; v.push(r); byFingerprint.set(r.apaar_fingerprint, v); });
  for (const group of byFingerprint.values()) if (group.length > 1) {
    const conflicts = new Set(group.map(r => `${r.normalized_name}|${r.date_of_birth}`)).size > 1;
    findings.push(finding(group.map(r => r.id), { rule_code: conflicts ? 'IDENTIFIER_ATTRIBUTE_CONFLICT' : 'DUPLICATE_IDENTIFIER', category: conflicts ? 'conflict' : 'duplicate', severity: conflicts ? 'high' : 'medium', confidence: 1, title: GROUP_TEXT[conflicts ? 'IDENTIFIER_ATTRIBUTE_CONFLICT' : 'DUPLICATE_IDENTIFIER'].title, explanation: GROUP_TEXT[conflicts ? 'IDENTIFIER_ATTRIBUTE_CONFLICT' : 'DUPLICATE_IDENTIFIER'].explanation, recommended_action: 'Compare source evidence and record a reviewer decision.' }));
    const active = group.filter(r => r.enrolment_status === 'active');
    if (new Set(active.map(r => r.institution_code)).size > 1 && new Set(active.map(r => r.academic_session)).size === 1) findings.push(finding(active.map(r => r.id), { rule_code: 'POTENTIAL_CONCURRENT_ENROLMENT', category: 'enrolment', severity: 'high', confidence: 1, title: 'Potential concurrent cross-institution enrolment', explanation: CONCURRENT_EXPLANATION, recommended_action: 'Request authorised transfer or programme evidence before any conclusion.' }));
  }
  // Candidate matches come from the identity-resolution pipeline (blocked, not all pairs), so the
  // finding and the persisted identity link always describe the same evidence.
  for (const l of buildIdentityLinks(records).filter(x => x.method === 'name_dob_similarity' && x.outcome === 'candidate_for_review')) {
    findings.push(finding([...l.records], { rule_code: 'CANDIDATE_IDENTITY_MATCH', category: 'candidate', severity: 'low', confidence: l.name_similarity, title: 'Conservative candidate identity match', explanation: candidateExplanation(l), recommended_action: 'Seek an authorised identifier or source evidence.' }));
  }
  for (const rule of db.capacityRules) { const state = capacityState(records, rule); if (state.exceeded) findings.push(capacityFinding(state)); }
  return findings;
}
// Lookup by id, as list.find(x => x.id === id) returns it (the first match), without a scan per call. The index is
// cached per array and rebuilt when its length changes: source records and findings are only ever appended to, and
// identity links are replaced as a whole array. It holds the objects themselves, so in-place updates are seen.
const byIdIndexes = new WeakMap();
function byId(list, id) {
  if (!list) return undefined;
  let entry = byIdIndexes.get(list);
  if (!entry || entry.length !== list.length) { const map = new Map(); for (const x of list) if (!map.has(x.id)) map.set(x.id, x); entry = { length: list.length, map }; byIdIndexes.set(list, entry); }
  return entry.map.get(id);
}
function allowedFinding(f, db, p) { return f.evidence.every(id => { const r = byId(db.sourceRecords, id); return r && canAccess(p, r); }); }
function canAccess(principal, record) { return principal.role === 'regulator' || record.institution_code === principal.institution_code; }
function transition(current, outcome) { const allowed = ['confirmed_discrepancy', 'legitimate_exception', 'record_corrected', 'awaiting_verification', 'dismissed']; if (!allowed.includes(outcome)) throw new Error('Unsupported review outcome.'); if (current === 'resolved' && outcome !== 'awaiting_verification') throw new Error('Resolved findings may only be reopened for further verification.'); return ['confirmed_discrepancy', 'legitimate_exception', 'record_corrected', 'dismissed'].includes(outcome) ? 'resolved' : 'awaiting_verification'; }
module.exports = { byId, VALIDATION_TITLES, GROUP_TEXT, CONCURRENT_EXPLANATION, validationExplanation, candidateExplanation, capacityExplanation, allowedFinding, isActiveRecord, APaar, REQUIRED, FIELD_DEFINITIONS, CAPACITY_RULE, SYSTEM_ACTOR, similarity, identityKey, finding, sameEvidence, mask, normaliseRecord, schemaSuggestion, validate, reconcile, canAccess, transition, fingerprint, isCurrent, capacityKey, capacityState, syncCapacityFindings, needsCapacityMigration };
