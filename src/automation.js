// Autonomous reconciliation: processing outcomes, safe automatic matching and an
// exception-first notification queue.
//
// Every finding is identified by the condition it describes (a condition key), so repeated
// processing updates one condition instead of accumulating duplicates. A finding whose
// evidence changes is superseded, never overwritten. Routine cases are closed automatically
// only under the identity policy in ./identity.js, with a system audit event, and a reviewer
// can always reopen them. Everything else stays a visible exception.
const crypto = require('node:crypto');
const { CAPACITY_RULE, SYSTEM_ACTOR, isCurrent, sameEvidence, isActiveRecord } = require('./engine');
const { AUTO_LINK_POLICY, buildIdentityLinks } = require('./identity');

const AUTOMATION_VERSION = 2; // 2: identity policy auto-link-2 (usable identifiers, name folding, blocking)
const OUTCOMES = {
  automatically_processed: 'Automatically processed',
  automatically_normalised: 'Automatically normalised',
  safely_matched: 'Safely matched',
  needs_institution_correction: 'Needs institution correction',
  needs_investigation: 'Needs investigation',
  verification_pending: 'Authoritative verification pending',
  processing_failed: 'Processing failed'
};
const CORRECTION_RULES = new Set(['APAAR_MISSING', 'APAAR_MALFORMED', 'REQUIRED_FIELD_MISSING']);
const GROUP_RULES = new Set(['DUPLICATE_IDENTIFIER', 'IDENTIFIER_ATTRIBUTE_CONFLICT']);
const STATUS_RANK = ['needs_investigation', 'verification_pending', 'needs_institution_correction', 'safely_matched', 'automatically_normalised', 'automatically_processed'];
const id = () => crypto.randomUUID();

function recordIndex(db) { return new Map(db.sourceRecords.map(r => [r.id, r])); }

// ── Condition keys ───────────────────────────────
// A record's submission signature: the same student, institution, programme and session.
// A resubmitted row has the same signature as the original.
function signature(r) { return `${r.institution_code}|${r.normalized_name}|${r.date_of_birth}|${r.programme}|${r.academic_session}`; }
function conditionKey(f, records) {
  if (f.rule_code === CAPACITY_RULE) return f.condition_key || null;
  const first = records.get(f.evidence[0]);
  if (CORRECTION_RULES.has(f.rule_code)) return first ? `validation|${f.rule_code}|${f.field || String(f.explanation || '').split(' ')[0]}|${signature(first)}` : null;
  if (GROUP_RULES.has(f.rule_code)) return first?.apaar_fingerprint ? `identity-group|fp:${first.apaar_fingerprint}` : null;
  if (f.rule_code === 'POTENTIAL_CONCURRENT_ENROLMENT') return first?.apaar_fingerprint ? `concurrent|fp:${first.apaar_fingerprint}` : null;
  if (f.rule_code === 'CANDIDATE_IDENTITY_MATCH') return `candidate|${[...new Set(f.evidence.map(rid => records.get(rid)).filter(Boolean).map(r => `${r.institution_code}|${r.normalized_name}|${r.date_of_birth}`))].sort().join('||')}`;
  return `${f.rule_code}|${[...f.evidence].sort().join('|')}`;
}
// The facts a reviewer acted on. Adding a record that repeats those facts (a resubmission) does
// not change them; a record with a different name, date of birth, institution, programme,
// session or status does.
function materialState(f, ids, records) {
  if (CORRECTION_RULES.has(f.rule_code)) return f.rule_code;
  return [...new Set(ids.map(rid => records.get(rid)).filter(Boolean).map(r => `${signature(r)}|${r.enrolment_status}|${r.apaar_fingerprint ? 'id' : 'none'}`))].sort().join('||');
}

function audit(db, f, action, note, at, extra = {}) {
  db.auditEvents.push({ id: `AUD-SYS-${id()}`, finding_id: f.id, action, actor: SYSTEM_ACTOR, note, at, system: true, ...extra });
}

function supersede(db, old, replacement, at, reason) {
  Object.assign(old, { lifecycle_status: 'superseded', lifecycle_changed_at: at, superseded_by: replacement.id,
    lifecycle_reason: `Recomputed ${reason}: the evidence for this condition changed (${old.evidence.length} → ${replacement.evidence.length} source records). Replaced by the current finding.` });
  audit(db, old, 'superseded', old.lifecycle_reason, at, { replacement_finding_id: replacement.id });
}

// Merge freshly generated (non-capacity) findings into the database by condition key.
function mergeFindings(db, generated, { at = new Date().toISOString(), reason = 'after revalidation' } = {}) {
  const records = recordIndex(db);
  const result = { created: [], superseded: [], unchanged: [], extended: [] };
  const current = new Map();
  db.findings.filter(f => isCurrent(f) && f.rule_code !== CAPACITY_RULE).forEach(f => {
    const key = f.condition_key || conditionKey(f, records);
    if (key) { f.condition_key = key; current.set(key, [...(current.get(key) || []), f]); }
  });
  for (const fresh of generated) {
    const key = conditionKey(fresh, records);
    fresh.condition_key = key;
    const existing = (key && current.get(key)) || [];
    const same = existing.find(f => f.rule_code === fresh.rule_code && fresh.evidence.every(rid => f.evidence.includes(rid)))
      || existing.find(f => f.rule_code === fresh.rule_code && materialState(f, [...new Set([...f.evidence, ...fresh.evidence])], records) === materialState(f, f.evidence, records));
    if (same) {
      const added = fresh.evidence.filter(rid => !same.evidence.includes(rid));
      if (added.length) {
        same.evidence = [...same.evidence, ...added];
        audit(db, same, 'evidence_updated', `Recomputed ${reason}: ${added.length === 1 ? 'a further source record repeats' : `${added.length} further source records repeat`} the facts of this condition (a resubmission) and ${added.length === 1 ? 'was' : 'were'} added to the evidence. The condition and its review status are unchanged.`, at);
        result.extended.push(same);
      } else result.unchanged.push(same);
      same.last_validated_at = at;
      existing.filter(f => f !== same).forEach(f => { supersede(db, f, same, at, reason); result.superseded.push(f); });
      current.set(key, [same]);
      continue;
    }
    Object.assign(fresh, { created_at: at, last_validated_at: at, ...(existing.length ? { supersedes: existing.map(f => f.id) } : {}) });
    db.findings.push(fresh); result.created.push(fresh);
    existing.forEach(f => { supersede(db, f, fresh, at, reason); result.superseded.push(f); });
    if (key) current.set(key, [fresh]);
  }
  // A condition that is no longer generated because a source record was superseded by a corrected
  // version is resolved by that correction. Only such findings are cleared; history is kept.
  const regenerated = new Set(generated.map(f => f.condition_key).filter(Boolean));
  result.cleared = [];
  for (const [key, list] of current) {
    if (regenerated.has(key)) continue;
    for (const f of list) {
      if (!isCurrent(f) || !f.evidence.some(rid => records.get(rid)?.superseded_by)) continue;
      const replaced = f.evidence.filter(rid => records.get(rid)?.superseded_by).map(rid => `${rid} → ${records.get(rid).superseded_by}`);
      Object.assign(f, { lifecycle_status: 'cleared', lifecycle_cause: 'correction', lifecycle_changed_at: at, lifecycle_reason: `Resolved by correction ${reason}: the source record${replaced.length > 1 ? 's were' : ' was'} superseded by a corrected version (${replaced.join(', ')}) and the condition is no longer present. The finding and its history are kept.` });
      audit(db, f, 'resolved_by_correction', f.lifecycle_reason, at);
      result.cleared.push(f);
    }
  }
  return result;
}

// Older databases can hold several current findings for one condition (for example after a
// file was imported twice). Keep the one with the most evidence and supersede the rest.
function consolidateConditions(db, { at = new Date().toISOString(), reason = 'during migration to condition-keyed findings' } = {}) {
  const records = recordIndex(db);
  const groups = new Map();
  db.findings.filter(f => isCurrent(f) && f.rule_code !== CAPACITY_RULE).forEach(f => {
    const key = f.condition_key || conditionKey(f, records);
    if (!key) return;
    f.condition_key = key;
    groups.set(key, [...(groups.get(key) || []), f]);
  });
  let superseded = 0;
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const keep = [...list].sort((a, b) => b.evidence.length - a.evidence.length || String(b.created_at).localeCompare(String(a.created_at)))[0];
    list.filter(f => f !== keep).forEach(f => { supersede(db, f, keep, at, reason); superseded++; });
  }
  return superseded;
}

// ── Finding classification ──────────────────────
function findingOutcome(f) {
  if (f.decision?.automated && f.review_status === 'resolved') return 'safely_matched';
  if (f.review_status === 'awaiting_verification') return 'verification_pending';
  return CORRECTION_RULES.has(f.rule_code) ? 'needs_institution_correction' : 'needs_investigation';
}
function requiredAction(f, records, outcome) {
  if (outcome === 'safely_matched') return `None: matched automatically under policy ${AUTO_LINK_POLICY.version}. The finding reopens for review if the evidence changes.`;
  const recs = f.evidence.map(rid => records.get(rid)).filter(Boolean);
  const where = recs.length ? recs.slice(0, 3).map(r => `${r.institution_code} ${r.source_file} row ${r.source_row}`).join('; ') + (recs.length > 3 ? ` and ${recs.length - 3} more` : '') : 'the source record';
  switch (f.rule_code) {
    case 'APAAR_MISSING': return `Institution: supply the student's APAAR ID for ${where} in a corrected file.`;
    case 'APAAR_MALFORMED': return `Institution: correct the identifier for ${where} (12 digits after removing spaces and hyphens).`;
    case 'REQUIRED_FIELD_MISSING': return `Institution: supply the missing ${f.field || 'required value'} for ${where}.`;
    case 'IDENTIFIER_ATTRIBUTE_CONFLICT': return 'Reviewer: compare the records and obtain authoritative evidence of which name and date of birth belong to the identifier.';
    case 'POTENTIAL_CONCURRENT_ENROLMENT': return 'Reviewer: request transfer or approved dual-programme evidence from both institutions before any conclusion.';
    case 'CANDIDATE_IDENTITY_MATCH': return 'Reviewer: obtain identifiers for both records. Do not merge on name similarity.';
    case 'DUPLICATE_IDENTIFIER': return 'Reviewer: confirm whether the repeated submission is legitimate; the attributes could not be matched automatically.';
    case CAPACITY_RULE: return 'Reviewer: review the configured capacity and the counted records.';
    default: return f.recommended_action || 'Review the source evidence.';
  }
}
const QUEUE = { needs_institution_correction: 'correction', needs_investigation: 'investigation', verification_pending: 'verification', safely_matched: 'none' };

// ── Record processing status ────────────────────
function normalisations(r) {
  const o = r.original || {};
  const out = [];
  const raw = key => String(o[key] ?? '');
  if (raw('student_name') && raw('student_name') !== r.student_name) out.push('student name whitespace and Unicode normalised');
  if (raw('date_of_birth').trim() && raw('date_of_birth').trim() !== r.date_of_birth) out.push('date of birth converted to YYYY-MM-DD');
  if (/[\s-]/.test(raw('apaar_id').trim())) out.push('identifier spaces and hyphens removed');
  if (raw('enrolment_status').trim() && raw('enrolment_status').trim().toLocaleLowerCase('en-IN') !== r.enrolment_status) out.push(`enrolment status mapped to "${r.enrolment_status}"`);
  return out;
}
function identifierCheck(r) { return !r.apaar_id ? 'missing' : /^\d{12}$/.test(r.apaar_id) ? 'locally_well_formed' : 'malformed'; }

// ── Main pass ───────────────────────────────────
function applyAutomation(db, { at = new Date().toISOString(), origin = 'revalidation', batch = null, changes = null, capacity = null } = {}) {
  const records = recordIndex(db);
  // Links are rebuilt from the records; remember which pairs were linked automatically before, so
  // an automatic association that new evidence contradicts is marked as withdrawn, not just dropped.
  // Links are also matched by lineage (src/lineage.js), so a corrected version of a record is
  // compared with the automatic link its earlier version had.
  const lineageKey = l => `${l.method}|${l.records.map(rid => records.get(rid)?.lineage?.id || rid).sort().join('|')}`;
  const previous = new Map((db.identityLinks || []).map(l => [l.key, l]));
  const previousByLineage = new Map((db.identityLinks || []).map(l => [l.lineage_key || lineageKey(l), l]));
  db.identityLinks = buildIdentityLinks(db.sourceRecords.filter(isActiveRecord));
  db.identityLinks.forEach(l => {
    l.lineage_key = lineageKey(l);
    const before = previous.get(l.key) || previousByLineage.get(l.lineage_key);
    if (l.outcome === 'auto_linked' || !before) return;
    if (before.outcome === 'auto_linked') l.withdrawn = { from: 'auto_linked', at, reason: l.reason };
    else if (before.withdrawn) l.withdrawn = before.withdrawn;
  });
  // An automatic link whose pair (by lineage) no longer exists at all is recorded, not silently dropped.
  const nowByLineage = new Map(db.identityLinks.map(l => [l.lineage_key, l]));
  db.identityLinkEvents = db.identityLinkEvents || [];
  for (const [key, before] of previousByLineage) {
    if (before.outcome !== 'auto_linked' || nowByLineage.has(key)) continue;
    db.identityLinkEvents.push({ at, action: 'automatic_link_withdrawn', lineage_key: key, records: before.records, reason: 'The records were re-evaluated with corrected evidence and no longer form a comparable pair under the matching policy.' });
  }
  db.auditEvents = db.auditEvents || [];
  const linksByGroup = new Map();
  db.identityLinks.forEach(l => { if (l.group_key) linksByGroup.set(l.group_key, [...(linksByGroup.get(l.group_key) || []), l]); });
  const current = db.findings.filter(isCurrent);

  // 1. Automatic matching: a repeated identifier whose records satisfy the policy is closed by
  //    the system, with an audit event; a later change in evidence reopens it.
  const run = { auto_matched: [], withdrawn: [] };
  for (const f of current.filter(x => x.rule_code === 'DUPLICATE_IDENTIFIER')) {
    const fp = records.get(f.evidence[0])?.apaar_fingerprint;
    const groupLinks = linksByGroup.get(`fp:${fp}`) || [];
    // Unchanged re-imports of one source record are as safe as a policy link for closing a resubmission.
    const safe = groupLinks.length > 0 && groupLinks.every(l => l.outcome === 'auto_linked' || l.outcome === 'same_source_record') && groupLinks.some(l => l.outcome === 'auto_linked' || l.outcome === 'same_source_record');
    if (safe && f.review_status === 'pending' && !f.decision) {
      const note = `Automatically matched under policy ${AUTO_LINK_POLICY.version}: ${f.evidence.length} source records share the protected identifier, normalised name and date of birth, and no record sharing the identifier conflicts. Counted once as one student. A reviewer can reopen this for further verification.`;
      f.review_status = 'resolved';
      f.decision = { outcome: 'automatically_matched', note, reviewer: SYSTEM_ACTOR, at, automated: true, policy_version: AUTO_LINK_POLICY.version };
      audit(db, f, 'automatically_matched', note, at);
      run.auto_matched.push(f);
    } else if (!safe && f.decision?.automated && f.review_status === 'resolved') {
      const note = 'Automatic match withdrawn: the records sharing this identifier no longer satisfy the automatic-matching policy. Returned to manual review.';
      f.review_status = 'pending'; f.decision = null;
      audit(db, f, 'automatic_match_withdrawn', note, at);
      run.withdrawn.push(f);
    }
  }

  // 2. Classify findings and attach identity evidence.
  db.identityLinks.forEach(l => { l.finding_id = null; });
  for (const f of current) {
    const outcome = findingOutcome(f);
    f.automation = { outcome, queue: f.review_status === 'resolved' ? 'none' : QUEUE[outcome], required_action: requiredAction(f, records, outcome), evaluated_at: at };
    const fp = GROUP_RULES.has(f.rule_code) || f.rule_code === 'POTENTIAL_CONCURRENT_ENROLMENT' ? records.get(f.evidence[0])?.apaar_fingerprint : null;
    const linked = fp ? linksByGroup.get(`fp:${fp}`) || [] : f.rule_code === 'CANDIDATE_IDENTITY_MATCH' ? db.identityLinks.filter(l => l.method === 'name_dob_similarity' && sameEvidence(l.records, f.evidence)) : [];
    f.identity_link_ids = linked.map(l => l.id);
    if (GROUP_RULES.has(f.rule_code) || f.rule_code === 'CANDIDATE_IDENTITY_MATCH') linked.forEach(l => { l.finding_id = f.id; });
  }

  // 3. Record processing status.
  const open = new Map();
  current.filter(f => f.rule_code !== CAPACITY_RULE && f.review_status !== 'resolved').forEach(f => f.evidence.forEach(rid => open.set(rid, [...(open.get(rid) || []), f])));
  const linked = new Set(db.identityLinks.filter(l => l.outcome === 'auto_linked').flatMap(l => l.records));
  for (const r of db.sourceRecords) {
    if (!isActiveRecord(r)) { r.processing = { status: 'superseded', superseded_by: r.superseded_by, open_findings: [], identifier_check: identifierCheck(r), authoritative_verification: 'not_available', evaluated_at: at }; continue; }
    const changesApplied = normalisations(r);
    const statuses = (open.get(r.id) || []).map(findingOutcome);
    if (linked.has(r.id)) statuses.push('safely_matched');
    statuses.push(changesApplied.length ? 'automatically_normalised' : 'automatically_processed');
    const status = STATUS_RANK.find(s => statuses.includes(s));
    r.processing = { status, normalisations: changesApplied, open_findings: (open.get(r.id) || []).map(f => f.id), identifier_check: identifierCheck(r), authoritative_verification: 'not_available', evaluated_at: at };
  }

  // 4. Exception-first notification for what is new or changed.
  const notification = notify(db, { at, origin, batch, records });
  db.automation_version = AUTOMATION_VERSION;
  db.automationRuns = [...(db.automationRuns || []), { at, origin, batch_id: batch?.id || null, created: changes?.created.length ?? null, superseded: (changes?.superseded.length ?? 0) + (capacity?.superseded.length ?? 0), auto_matched: run.auto_matched.length, withdrawn: run.withdrawn.length, notified: notification.notified, suppressed_repeats: notification.suppressed }].slice(-200);
  return { ...run, notifications: notification.created, notified: notification.notified, suppressed: notification.suppressed };
}

// ── Notifications ───────────────────────────────
// A finding is notified once per condition and state. Validation findings are keyed by the
// student's record signature, so the same uncorrected row resubmitted in a later file is not
// notified again; it is counted as a suppressed repeat instead.
function dedupeKey(f, records) {
  if (CORRECTION_RULES.has(f.rule_code)) {
    const r = records.get(f.evidence[0]);
    return r ? `correction|${f.rule_code}|${f.field || ''}|${r.institution_code}|${r.normalized_name}|${r.date_of_birth}|${r.programme}|${r.academic_session}` : f.condition_key;
  }
  return f.condition_key || f.id;
}
function itemFor(f, records, change) {
  const recs = f.evidence.map(rid => records.get(rid)).filter(Boolean);
  return {
    kind: f.automation.queue === 'correction' ? 'correction' : 'investigation',
    change, finding_id: f.id, rule_code: f.rule_code, severity: f.severity, title: f.title,
    explanation: f.explanation, required_action: f.automation.required_action, processing_status: f.automation.outcome,
    affected: recs.slice(0, 5).map(r => ({ record_id: r.id, institution_code: r.institution_code, source_file: r.source_file, source_row: r.source_row })),
    affected_count: recs.length, institutions: [...new Set(recs.map(r => r.institution_code))]
  };
}
function notify(db, { at, origin, batch, records }) {
  db.notifications = db.notifications || [];
  db.notificationRegistry = db.notificationRegistry || {};
  const registry = db.notificationRegistry;
  const items = []; let suppressed = 0;
  for (const f of db.findings.filter(x => isCurrent(x) && x.automation?.queue && x.automation.queue !== 'none')) {
    const key = dedupeKey(f, records);
    const state = `${f.rule_code}|${f.rule_code === CAPACITY_RULE ? f.capacity?.observed_active : materialState(f, f.evidence, records)}`;
    const seen = registry[key];
    if (seen && seen.state === state) {
      if (seen.finding_id !== f.id && !seen.repeat_ids?.includes(f.id)) { seen.repeat_ids = [...(seen.repeat_ids || []), f.id].slice(-20); seen.times_seen = (seen.times_seen || 1) + 1; seen.last_seen_at = at; suppressed++; }
      continue;
    }
    registry[key] = { finding_id: f.id, state, first_notified_at: seen?.first_notified_at || at, last_seen_at: at, times_seen: (seen?.times_seen || 0) + 1 };
    items.push(itemFor(f, records, seen ? 'changed' : 'new'));
  }
  // Rows that could not be imported are correction requests for the source institution.
  (batch?.row_outcomes || []).filter(o => o.outcome === 'rejected').forEach(o => {
    const key = `rejected|${batch.institution_code}|${batch.rejected_row_signatures?.[o.source_row] || `${batch.id}|${o.source_row}`}`;
    if (registry[key]) { registry[key].times_seen++; registry[key].last_seen_at = at; suppressed++; return; }
    registry[key] = { finding_id: null, state: 'rejected', first_notified_at: at, last_seen_at: at, times_seen: 1, batch_id: batch.id };
    items.push({
    kind: 'processing_failed', change: 'new', finding_id: null, rule_code: 'ROW_REJECTED', severity: 'high', title: 'Row could not be imported',
    explanation: o.reason, required_action: `Institution: resubmit ${batch.source_file} row ${o.source_row} with the missing values.`, processing_status: 'processing_failed',
    affected: [{ record_id: null, institution_code: batch.institution_code, source_file: batch.source_file, source_row: o.source_row }], affected_count: 1,
    institutions: [batch.institution_code]
  });
  });

  // Group by triggering batch and institution (cross-institution findings form their own group).
  const groups = new Map();
  for (const item of items) {
    const batchId = batch?.id || latestBatch(item, records) || 'unbatched';
    const institution = item.institutions.length === 1 ? item.institutions[0] : 'CROSS';
    const key = `${batchId}|${institution}`;
    if (!groups.has(key)) groups.set(key, { batchId, institution, items: [] });
    groups.get(key).items.push(item);
  }
  const created = [...groups.values()].map(g => {
    // The current batch is not in db.importBatches yet while its import is being processed.
    const b = batch?.id === g.batchId ? batch : db.importBatches.find(x => x.id === g.batchId);
    const count = kind => g.items.filter(i => i.kind === kind).length;
    return {
      id: `NTF-${id()}`, created_at: at, origin, batch_id: g.batchId, source_file: b?.source_file || null, institution_code: g.institution,
      counts: { correction: count('correction'), investigation: count('investigation'), processing_failed: count('processing_failed'), new: g.items.filter(i => i.change === 'new').length, changed: g.items.filter(i => i.change === 'changed').length },
      items: g.items, acknowledged: null
    };
  });
  db.notifications.push(...created);
  return { created, notified: items.length, suppressed };
}
function latestBatch(item, records) {
  const recs = item.affected.map(a => records.get(a.record_id)).filter(Boolean);
  return recs.length ? recs.sort((a, b) => String(b.imported_at).localeCompare(String(a.imported_at)) || recordOrder(b) - recordOrder(a))[0].import_id : null;
}
function recordOrder(r) { const n = Number(String(r.id).replace(/\D/g, '').slice(-8)); return Number.isFinite(n) ? n : 0; }

// ── Migration and scoped summaries ──────────────
function needsAutomationMigration(db) { return db.automation_version !== AUTOMATION_VERSION; }
function migrateAutomation(db, at = new Date().toISOString()) {
  db.auditEvents = db.auditEvents || [];
  const consolidated = consolidateConditions(db, { at });
  const result = applyAutomation(db, { at, origin: 'migration' });
  return { consolidated, ...result };
}

function automationSummary(db, canSee) {
  // Superseded versions of corrected records are kept for audit but are not processed again.
  const records = db.sourceRecords.filter(r => canSee.record(r) && isActiveRecord(r));
  const by = Object.fromEntries(Object.keys(OUTCOMES).map(k => [k, 0]));
  records.forEach(r => { if (r.processing && by[r.processing.status] !== undefined) by[r.processing.status]++; });
  const batches = db.importBatches.filter(canSee.batch);
  by.processing_failed = batches.reduce((n, b) => n + (b.row_outcomes ? b.rejected || 0 : 0), 0);
  const automatic = by.automatically_processed + by.automatically_normalised + by.safely_matched;
  const visible = new Set(records.map(r => r.id));
  const links = (db.identityLinks || []).filter(l => l.records.every(rid => visible.has(rid)));
  const openFindings = db.findings.filter(f => isCurrent(f) && canSee.finding(f) && f.review_status !== 'resolved');
  const queue = q => openFindings.filter(f => f.automation?.queue === q).length;
  const checks = records.map(identifierCheck);
  return {
    records: records.length,
    by_status: by,
    labels: OUTCOMES,
    automatic: automatic,
    automatic_rate: records.length ? Number((automatic / records.length).toFixed(4)) : 0,
    rate_definition: 'Share of persisted records whose processing status is automatically processed, automatically normalised or safely matched — that is, records with no open finding. Rejected rows are counted separately as processing failed.',
    identity_links: Object.fromEntries(['auto_linked', 'needs_investigation', 'candidate_for_review', 'not_linked'].map(o => [o, links.filter(l => l.outcome === o).length])),
    open_exceptions: { correction: queue('correction'), investigation: queue('investigation'), verification: queue('verification') },
    automatically_resolved: db.findings.filter(f => isCurrent(f) && canSee.finding(f) && f.decision?.automated).length,
    verification: { locally_well_formed_unverified: checks.filter(c => c === 'locally_well_formed').length, missing: checks.filter(c => c === 'missing').length, malformed: checks.filter(c => c === 'malformed').length, authoritatively_verified: 0, service: 'not configured', note: 'No APAAR or government verification service is integrated. A well-formed identifier is only locally well-formed — it is never treated as verified or authentic.' },
    policy: AUTO_LINK_POLICY
  };
}

module.exports = { AUTOMATION_VERSION, OUTCOMES, conditionKey, mergeFindings, consolidateConditions, applyAutomation, needsAutomationMigration, migrateAutomation, automationSummary, normalisations, identifierCheck };
