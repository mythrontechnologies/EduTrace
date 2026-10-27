// Versioned decision receipts for committed reviewer decisions.
//
// A receipt is written by the decision routes in server.js right after a reviewer decision is
// recorded (identity match, finding review, correction). It holds the exact source-record versions
// the decision rests on, the field comparison outcomes, the policy version, the deterministic outcome,
// the reviewer action and the audit entry, and a SHA-256 digest of its canonical serialisation.
//
// Canonical serialisation (`edutrace-c14n-1`): JSON with object keys sorted by UTF-16 code units,
// no whitespace, arrays in stored order, `undefined` members omitted, non-finite numbers rejected.
// The digest covers every top-level member of the receipt except `integrity`.
//
// What the digest does and does not prove: it detects a change to the receipt's content when the
// expected digest is known. The receipt and its digest are stored together in the same writable JSON
// file, so anyone who can edit that file can also recompute the digest. It is not immutable storage,
// not a signature and not institutional authentication. Verification additionally cross-checks the
// receipt against the authoritative decision and audit entry, which catches edits to either side
// that were not made to both.
const crypto = require('node:crypto');
const { lineageOf } = require('./lineage');
const { AUTO_LINK_POLICY } = require('./identity');

const RECEIPT_SCHEMA = 'edutrace.decision-receipt';
const RECEIPT_VERSION = 1;
const CANONICALIZATION = 'edutrace-c14n-1';
const LIMITATIONS = [
  'The receipt and its digest are stored in the same writable development JSON file. A matching digest shows the content is unchanged only relative to that stored digest; someone able to edit the file could change both.',
  'There is no signature, timestamping authority or append-only store. The actor is the demo role header, not an authenticated identity.',
  'Source-record verification is local: APAAR identifiers are format-checked only, not verified against an authoritative service.'
];

function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Receipts cannot hold non-finite numbers.'); return JSON.stringify(value); }
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
function contentOf(receipt) { const { integrity, ...content } = receipt; return content; }
function digestOf(receipt) { return sha256(canonical(contentOf(receipt))); }

// A source record as submitted: everything except values the pipeline recomputes or adds later.
function recordContentHash(r) { const { processing, superseded_by, superseded_at, ...content } = r; return sha256(canonical(content)); }
function sourceVersion(db, id) {
  const r = db.sourceRecords.find(x => x.id === id);
  if (!r) return { record_id: id, available: false };
  const lineage = lineageOf(r);
  return { record_id: r.id, lineage_id: lineage.id, version: lineage.version, relation: lineage.relation, institution_code: r.institution_code, import_batch: r.import_id || null, source_file: r.source_file, source_row: r.source_row, content_sha256: recordContentHash(r) };
}
const actorOf = p => ({ name: p.name, role: p.role, institution_code: p.institution_code || null, authentication: 'none: demo role header (development mode)' });
const comparisonOf = l => (l ? { link_id: l.id, method: l.method, outcome: l.outcome, agreeing_fields: l.agreeing_fields, similar_fields: l.similar_fields || [], conflicting_fields: l.conflicting_fields, missing_fields: l.missing_fields, disqualifiers: l.disqualifiers || [], policy_version: l.policy_version } : null);

function seal(fields) {
  const receipt = { schema: RECEIPT_SCHEMA, schema_version: RECEIPT_VERSION, receipt_id: `RCPT-${sha256(canonical([fields.kind, fields.subject, fields.decided_at, fields.audit])).slice(0, 20)}`, ...fields };
  return { ...receipt, integrity: { algorithm: 'SHA-256', canonicalization: CANONICALIZATION, covers: 'every top-level member except integrity', digest: digestOf(receipt) } };
}
function store(db, receipt) { db.decisionReceipts = [...(db.decisionReceipts || []), receipt]; return receipt; }

// Identity match decision (src/matches.js decideMatch): `record` is the stored decision.
function matchDecisionReceipt(db, p, record) {
  const link = (db.identityLinks || []).find(l => l.id === record.link_id);
  const event = [...(db.auditEvents || [])].reverse().find(e => e.link_id === record.link_id && e.at === record.at && e.action === `match_${record.decision}`) || null;
  const receipt = seal({
    kind: 'identity_match_decision', decided_at: record.at, actor: actorOf(p),
    subject: { type: 'identity_candidate', link_id: record.link_id, evidence_key: record.evidence_key, method: record.method },
    source_records: record.records.map(id => sourceVersion(db, id)),
    field_comparison: { ...comparisonOf(link), ...record.evidence, link_id: record.link_id },
    policy: { identity_policy: record.evidence.policy_version || AUTO_LINK_POLICY.version, finding_rule_version: event ? (db.findings.find(f => f.id === event.finding_id)?.rule_version || null) : null },
    deterministic_outcome: record.evidence.outcome,
    action: { decision: record.decision, note: record.note },
    previous_state: record.previous_state, resulting_state: record.new_state,
    evidence_refs: { finding_id: event?.finding_id || null, link_id: record.link_id, import_batches: [...new Set(record.records.map(id => db.sourceRecords.find(r => r.id === id)?.import_id).filter(Boolean))] },
    audit: event ? { store: 'auditEvents', event_id: event.id } : { store: 'matchDecisions', event_id: null, key: record.evidence_key || null }
  });
  record.receipt_id = receipt.receipt_id;
  if (event) event.receipt_id = receipt.receipt_id;
  return store(db, receipt);
}

// Finding review decision (POST /api/v1/findings/:id/decision).
function findingDecisionReceipt(db, p, f, event, previousStatus) {
  const links = (db.identityLinks || []).filter(l => (f.identity_link_ids || []).includes(l.id));
  const receipt = seal({
    kind: 'finding_review_decision', decided_at: f.decision.at, actor: actorOf(p),
    subject: { type: 'finding', finding_id: f.id, rule_code: f.rule_code, condition_key: f.condition_key || null },
    source_records: f.evidence.map(id => sourceVersion(db, id)),
    field_comparison: links.length ? { identity_links: links.map(comparisonOf) } : { identity_links: [], note: 'This rule has no pairwise field comparison.' },
    policy: { identity_policy: AUTO_LINK_POLICY.version, finding_rule_version: f.rule_version || null },
    deterministic_outcome: f.automation?.outcome || null,
    action: { decision: f.decision.outcome, note: f.decision.note },
    previous_state: previousStatus, resulting_state: f.review_status,
    evidence_refs: { finding_id: f.id, link_ids: links.map(l => l.id), import_batches: [...new Set(f.evidence.map(id => db.sourceRecords.find(r => r.id === id)?.import_id).filter(Boolean))] },
    audit: { store: 'auditEvents', event_id: event.id }
  });
  f.decision.receipt_id = receipt.receipt_id;
  event.receipt_id = receipt.receipt_id;
  return store(db, receipt);
}

// Correction decision (src/lineage.js decideCorrection): `candidate` after the decision.
function correctionDecisionReceipt(db, p, candidate) {
  const event = [...(db.lineageEvents || [])].reverse().find(e => e.candidate_id === candidate.id && e.at === candidate.decided_at && (e.action === 'correction_confirmed' || e.action === 'correction_rejected')) || null;
  const receipt = seal({
    kind: 'correction_decision', decided_at: candidate.decided_at, actor: actorOf(p),
    subject: { type: 'correction_candidate', candidate_id: candidate.id, basis: candidate.basis },
    source_records: [candidate.earlier, candidate.later].map(id => sourceVersion(db, id)),
    // Lineage already records identifier changes masked (src/lineage.js shown()).
    field_comparison: { changes: candidate.changes.map(({ field, kind, from, to }) => ({ field, kind, from: from ?? null, to: to ?? null })) },
    policy: { identity_policy: AUTO_LINK_POLICY.version, lineage_rules: 'src/lineage.js (institution reference or reviewer confirmation)' },
    deterministic_outcome: 'correction_candidate',
    action: { decision: candidate.status === 'confirmed' ? 'confirm' : 'reject', note: candidate.note },
    previous_state: 'pending', resulting_state: candidate.status,
    evidence_refs: { candidate_id: candidate.id, import_batches: [...new Set([candidate.earlier, candidate.later].map(id => db.sourceRecords.find(r => r.id === id)?.import_id).filter(Boolean))] },
    audit: { store: 'lineageEvents', event_id: event?.id || null }
  });
  candidate.receipt_id = receipt.receipt_id;
  if (event) event.receipt_id = receipt.receipt_id;
  return store(db, receipt);
}

// ── Verification ─────────────────────────────────────────────────────────────────
function auditEntry(db, receipt) {
  const ref = receipt.audit || {};
  if (ref.store === 'auditEvents') return (db.auditEvents || []).find(e => e.id === ref.event_id) || null;
  if (ref.store === 'lineageEvents') return (db.lineageEvents || []).find(e => e.id === ref.event_id) || null;
  if (ref.store === 'matchDecisions') return Object.values(db.matchDecisions || {}).flatMap(d => [d, ...(d.history || [])]).find(d => d.receipt_id === receipt.receipt_id) || null;
  return null;
}
// Does the authoritative entry still say what the receipt says?
function consistency(db, receipt) {
  const entry = auditEntry(db, receipt);
  if (!entry) return { status: 'audit_entry_missing', detail: 'The audit entry this receipt points to was not found.' };
  const checks = receipt.kind === 'identity_match_decision'
    ? [entry.at === receipt.decided_at, entry.note === receipt.action.note, (entry.action || `match_${entry.decision}`) === `match_${receipt.action.decision}`, (entry.actor || entry.reviewer) === receipt.actor.name]
    : receipt.kind === 'finding_review_decision'
      ? [entry.at === receipt.decided_at, entry.note === receipt.action.note, entry.action === receipt.action.decision, entry.actor === receipt.actor.name]
      : [entry.at === receipt.decided_at, entry.note === receipt.action.note, entry.action === (receipt.action.decision === 'confirm' ? 'correction_confirmed' : 'correction_rejected'), entry.actor === receipt.actor.name];
  if (entry.receipt_id && entry.receipt_id !== receipt.receipt_id) return { status: 'mismatch', detail: 'The audit entry points to a different receipt.' };
  return checks.every(Boolean) ? { status: 'consistent', detail: 'The audit entry records the same action, note, actor and time.' } : { status: 'mismatch', detail: 'The audit entry no longer records the same action, note, actor or time as the receipt.' };
}

function verifyReceipt(db, receipt) {
  if (!receipt) return { status: 'missing', integrity: 'missing', detail: 'No receipt is recorded for this decision. Decisions made before receipts were introduced have none.' };
  const shapeOk = receipt.schema === RECEIPT_SCHEMA && receipt.schema_version === RECEIPT_VERSION && receipt.integrity?.algorithm === 'SHA-256' && receipt.integrity?.canonicalization === CANONICALIZATION && /^[0-9a-f]{64}$/.test(receipt.integrity?.digest || '');
  if (!shapeOk) return { status: 'invalid', integrity: 'invalid', detail: 'The receipt does not follow schema edutrace.decision-receipt version 1, or its integrity block is malformed.' };
  let recomputed;
  try { recomputed = digestOf(receipt); } catch { return { status: 'invalid', integrity: 'invalid', detail: 'The receipt content cannot be serialised canonically.' }; }
  const integrity = recomputed === receipt.integrity.digest ? 'verified' : 'mismatch';
  const audit = consistency(db, receipt);
  const sources = (receipt.source_records || []).map(s => {
    const r = db.sourceRecords.find(x => x.id === s.record_id);
    return { record_id: s.record_id, status: !r ? 'missing' : recordContentHash(r) === s.content_sha256 ? (r.superseded_by ? 'superseded_unchanged' : 'unchanged') : 'changed' };
  });
  const status = integrity !== 'verified' ? 'mismatch' : audit.status !== 'consistent' ? 'audit_mismatch' : 'verified';
  return {
    status, integrity, recomputed_digest: recomputed, stored_digest: receipt.integrity.digest, audit, sources,
    detail: status === 'verified' ? 'The digest matches the canonical content and the audit entry agrees with the receipt.'
      : integrity === 'mismatch' ? 'The receipt content no longer matches its stored digest: it was changed after it was written.'
      : audit.detail
  };
}

module.exports = { RECEIPT_SCHEMA, RECEIPT_VERSION, CANONICALIZATION, LIMITATIONS, canonical, digestOf, recordContentHash, matchDecisionReceipt, findingDecisionReceipt, correctionDecisionReceipt, verifyReceipt };
