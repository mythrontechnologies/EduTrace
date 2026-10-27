// APAAR-first record status and basic consent.
//
// Every source record carries an APAAR status with separate parts, so that a format check is never read as a check
// of authenticity:
//   format_status        missing | malformed | well_formed (12 digits after removing spaces and hyphens; local only)
//   verification_status  not_connected | consent_required | not_checkable | mock_record_found | mock_no_record
//                        (the mock_* values come only from the simulated adapter and are labelled simulated)
//   conflict_status      none | identifier_conflict | shared_identifier_pending_review | concurrent_enrolment_review
//   consent_status       granted | withdrawn | not_recorded, for the purpose identity_verification
//   authoritative        always false: no official APAAR service is connected
//
// Consent is an append-only history per student lineage and purpose; the latest entry is the current status. An
// identifier is sent to a verification adapter only while consent is granted. Recording a status here is not, on
// its own, evidence of lawful consent.
const crypto = require('node:crypto');
const { mask, isCurrent, canAccess } = require('./engine');
const { lineageOf } = require('./lineage');

const PURPOSE = 'identity_verification';
const CONSENT_STATUSES = ['granted', 'withdrawn'];
const OPEN_CONDITIONS = { IDENTIFIER_ATTRIBUTE_CONFLICT: 'identifier_conflict', DUPLICATE_IDENTIFIER: 'shared_identifier_pending_review', POTENTIAL_CONCURRENT_ENROLMENT: 'concurrent_enrolment_review' };
class ConsentError extends Error { constructor(status, message) { super(message); this.status = status; } }

const formatStatus = r => (!r.apaar_id ? 'missing' : /^\d{12}$/.test(r.apaar_id) ? 'well_formed' : 'malformed');

function consentFor(db, record, purpose = PURPOSE) {
  const lineage = lineageOf(record).id;
  const history = (db.consentRecords || []).filter(c => c.lineage_id === lineage && c.purpose === purpose).sort((a, b) => String(a.recorded_at).localeCompare(String(b.recorded_at)));
  const latest = history.at(-1);
  return { purpose, status: latest ? latest.status : 'not_recorded', recorded_at: latest?.recorded_at || null, recorded_by: latest?.recorded_by || null, reference: latest?.reference || null, history: history.map(({ id, status, recorded_at, recorded_by, reference }) => ({ id, status, recorded_at, recorded_by, reference })) };
}

function conflictOf(db, record) {
  const open = db.findings.filter(f => isCurrent(f) && f.review_status !== 'resolved' && OPEN_CONDITIONS[f.rule_code] && f.evidence.includes(record.id)).map(f => f.rule_code);
  const order = ['IDENTIFIER_ATTRIBUTE_CONFLICT', 'POTENTIAL_CONCURRENT_ENROLMENT', 'DUPLICATE_IDENTIFIER'];
  const worst = order.find(code => open.includes(code));
  return { conflict_status: worst ? OPEN_CONDITIONS[worst] : 'none', open_conditions: [...new Set(open)] };
}

// The status without contacting any adapter (lists and record details).
function apaarStatus(db, record) {
  const consent = consentFor(db, record);
  return { identifier: record.apaar_id ? mask(record.apaar_id) : null, format_status: formatStatus(record), verification_status: 'not_requested', authoritative: false, ...conflictOf(db, record), consent_status: consent.status };
}

// A verification request: consent is checked first, and the adapter is called only with consent and a usable identifier.
function verifyIdentifier(db, record, adapter) {
  const base = apaarStatus(db, record);
  if (adapter.kind === 'none') return { ...base, verification_status: 'not_connected', verification_source: 'none', simulated: false, detail: 'No authorised APAAR service is connected. Only a local format check was performed; it is not identity verification.' };
  if (base.consent_status !== 'granted') return { ...base, verification_status: 'consent_required', verification_source: adapter.kind, simulated: adapter.kind === 'mock', detail: `No identifier was sent: consent for identity verification is ${base.consent_status.replace('_', ' ')}.` };
  if (base.format_status !== 'well_formed') return { ...base, verification_status: 'not_checkable', verification_source: adapter.kind, simulated: adapter.kind === 'mock', detail: 'The identifier is missing or malformed, so it was not sent for verification.' };
  const result = adapter.verify(record);
  const status = result.status === 'simulated_record_found' ? 'mock_record_found' : result.status === 'simulated_no_record' ? 'mock_no_record' : result.status;
  return { ...base, verification_status: status, verification_source: adapter.kind, simulated: Boolean(result.simulated), label: result.label || null, detail: result.detail };
}

function recordConsent(db, p, record, input = {}, at = new Date().toISOString()) {
  if (!record || !canAccess(p, record)) throw new ConsentError(404, 'Source record not found.');
  const status = String(input.status || '');
  if (!CONSENT_STATUSES.includes(status)) throw new ConsentError(400, 'Use status "granted" or "withdrawn".');
  const reference = String(input.reference || '').normalize('NFKC').trim();
  if (reference.length < 3 || reference.length > 200) throw new ConsentError(400, 'Describe where the consent record is held (3–200 characters).');
  if (/\d{12}/.test(reference.replace(/[\s-]/g, ''))) throw new ConsentError(400, 'Do not put identifiers in the consent reference; describe the document instead.');
  const lineage = lineageOf(record).id;
  const entry = { id: `CONS-${crypto.createHash('sha256').update(`${lineage}|${PURPOSE}|${status}|${at}|${p.subject || p.name}`).digest('hex').slice(0, 16)}`, lineage_id: lineage, institution_code: record.institution_code, purpose: PURPOSE, status, reference, recorded_by: p.name, recorded_at: at };
  db.consentRecords = [...(db.consentRecords || []), entry];
  return entry;
}

module.exports = { PURPOSE, CONSENT_STATUSES, ConsentError, formatStatus, consentFor, apaarStatus, verifyIdentifier, recordConsent };
