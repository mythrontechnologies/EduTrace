// Temporal identity history: one student identity's source records, versions, findings, identity
// relationships and reviewer decisions, in time order — built only from persisted data.
//
// Identity cluster. Records are grouped only by evidence that already establishes the same student:
// versions and unchanged copies of one source record (lineage), automatic links under the policy
// (auto_linked, same_source_record) and a reviewer's "same person" decision. Candidate pairs,
// rejected pairs and withdrawn links never join a cluster; they are listed as relationships.
//
// Time. Every event says which clock its timestamp comes from:
//   import    when EduTrace stored the source row (imported_at)
//   system    when the reconciliation engine recorded something (finding created, lifecycle change)
//   reviewer  when a person recorded a decision
// What an institution reported about time (academic session, admission year, enrolment status) is
// shown separately as `reported`. No admission, transfer or name-change date is ever inferred.
//
// As-of view. With `asOf`, only records stored and events recorded by that time are included, and
// the cluster is rebuilt from relationships that had been established by then; a later decision or
// link is not shown as if it had been known earlier.
const { mask, canAccess, isActiveRecord } = require('./engine');
const { lineageOf, lineageView } = require('./lineage');
const { resolution, RESOLUTIONS, decisionFor } = require('./matches');

const TRACKED = [
  ['student_name', 'Name'], ['date_of_birth', 'Date of birth'], ['apaar_id', 'APAAR identifier'], ['institution_code', 'Institution'],
  ['programme', 'Programme'], ['academic_session', 'Academic session'], ['admission_year', 'Admission year'], ['enrolment_status', 'Enrolment status'], ['source_reference', 'Institution record reference']
];
const EVIDENCE_KIND = { APAAR_MISSING: 'missing', REQUIRED_FIELD_MISSING: 'missing', APAAR_MALFORMED: 'malformed', IDENTIFIER_ATTRIBUTE_CONFLICT: 'contradiction', CANDIDATE_IDENTITY_MATCH: 'candidate', DUPLICATE_IDENTIFIER: 'repeat', POTENTIAL_CONCURRENT_ENROLMENT: 'enrolment', DEMO_INTAKE_LIMIT_EXCEEDED: 'capacity' };
const AUDIT_CATEGORY = { automatically_matched: 'identity', automatic_match_withdrawn: 'identity', superseded: 'finding', condition_cleared: 'finding', resolved_by_correction: 'correction', evidence_updated: 'finding' };
const shown = (field, r) => (field === 'apaar_id' ? (r.apaar_id ? mask(r.apaar_id) : '') : String(r[field] ?? ''));
const before = (at, asOf) => !asOf || (at && String(at) <= asOf);

function ref(db, r) {
  const l = lineageOf(r);
  return { record_id: r.id, institution_code: r.institution_code, source_file: r.source_file, source_row: r.source_row, import_id: r.import_id || null, imported_at: r.imported_at || null, source_reference: r.source_reference || null, version: l.version, relation: l.relation, active: isActiveRecord(r), superseded_by: r.superseded_by || null };
}

// Union-find over records with the relationships that establish one identity.
function clusterOf(db, p, rootId, asOf) {
  const records = new Map(db.sourceRecords.map(r => [r.id, r]));
  const visible = id => { const r = records.get(id); return r && canAccess(p, r) && before(r.imported_at, asOf); };
  const parent = new Map();
  const find = x => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) x = parent.get(x); return x; };
  const join = (a, b) => { if (visible(a) && visible(b)) parent.set(find(a), find(b)); };
  const byLineage = new Map();
  db.sourceRecords.forEach(r => { const k = lineageOf(r).id; byLineage.set(k, [...(byLineage.get(k) || []), r.id]); });
  byLineage.forEach(ids => ids.slice(1).forEach(id => join(ids[0], id)));
  (db.identityLinks || []).forEach(l => {
    if (l.outcome === 'same_source_record') return join(l.records[0], l.records[1]);
    if (l.outcome === 'auto_linked' && !asOf) join(l.records[0], l.records[1]);
  });
  // As of a past time, automatic matches come from the audit trail: valid from the automatic-match
  // event until the finding was withdrawn, superseded or cleared. Current links are not projected back.
  if (asOf) autoMatchIntervals(db).filter(m => m.from <= asOf && (!m.until || m.until > asOf)).forEach(m => m.records.slice(1).forEach(id => join(m.records[0], id)));
  Object.values(db.matchDecisions || {}).forEach(d => {
    const state = decisionAt(d, asOf);
    if (state?.decision === 'same_person') join(d.records[0], d.records[1]);
  });
  if (!visible(rootId)) return null;
  const root = find(rootId);
  const members = db.sourceRecords.filter(r => visible(r.id) && find(r.id) === root);
  // Records outside the caller's scope that share an automatic link with a member: counted, never shown.
  const memberIds = new Set(members.map(m => m.id));
  const linkedToMember = new Set((db.identityLinks || []).filter(l => l.outcome === 'auto_linked' && l.records.some(id => memberIds.has(id))).flatMap(l => l.records));
  const hidden = db.sourceRecords.filter(r => !canAccess(p, r) && before(r.imported_at, asOf) && linkedToMember.has(r.id)).length;
  return { members, hidden };
}

// Automatic matches as recorded in the audit trail: the records of the auto-matched finding, from the
// automatic-match event until the next event that ended it (withdrawn, superseded or cleared).
const ENDS_MATCH = new Set(['automatic_match_withdrawn', 'superseded', 'condition_cleared', 'resolved_by_correction']);
function autoMatchIntervals(db) {
  const findings = new Map(db.findings.map(f => [f.id, f]));
  const events = (db.auditEvents || []).filter(e => findings.has(e.finding_id)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return events.filter(e => e.action === 'automatically_matched').map(e => {
    const end = events.find(x => x.finding_id === e.finding_id && ENDS_MATCH.has(x.action) && x.at >= e.at && x !== e);
    return { finding_id: e.finding_id, records: findings.get(e.finding_id).evidence, from: e.at, until: end ? end.at : null, ended_by: end ? end.action : null };
  });
}
// When each automatic link became known: the audit event that auto-matched its identifier group.
function autoMatchTimes(db) {
  const findings = new Map(db.findings.map(f => [f.id, f]));
  const out = new Map();
  (db.auditEvents || []).filter(e => e.action === 'automatically_matched').forEach(e => {
    const f = findings.get(e.finding_id); if (!f) return;
    for (let i = 0; i < f.evidence.length; i++) for (let j = i + 1; j < f.evidence.length; j++) {
      const k = [f.evidence[i], f.evidence[j]].sort().join('|');
      if (!out.has(k) || e.at < out.get(k)) out.set(k, e.at);
    }
  });
  return out;
}
// A reviewer decision as it stood at `asOf` (its history keeps earlier states).
function decisionAt(d, asOf) {
  if (!asOf) return d;
  const states = [...(d.history || []), { decision: d.decision, note: d.note, reviewer: d.reviewer, at: d.at }].filter(s => s.at && s.at <= asOf);
  return states.length ? states[states.length - 1] : null;
}

function variations(db, members) {
  const versionChanges = new Map(); // field → [{ from, to, basis, record }]
  members.forEach(r => (lineageOf(r).changes || []).forEach(c => versionChanges.set(c.field, [...(versionChanges.get(c.field) || []), { record_id: r.id, kind: c.kind, from: c.from, to: c.to, basis: lineageOf(r).basis }])));
  return TRACKED.map(([field, label]) => {
    const values = new Map();
    members.forEach(r => { const v = shown(field, r); const key = v || '∅'; values.set(key, [...(values.get(key) || []), ref(db, r)]); });
    const present = [...values.keys()].filter(k => k !== '∅');
    const missing = values.get('∅') || [];
    const corrections = versionChanges.get(field) || [];
    // Identity attributes can conflict; institution, programme, session, status and reference are
    // context that legitimately differs between institutions and years.
    const identity = ['student_name', 'date_of_birth', 'apaar_id'].includes(field);
    const state = present.length <= 1 ? (missing.length && present.length ? 'missing_in_some' : present.length ? 'consistent' : 'not_recorded') : corrections.length ? 'corrected' : identity ? 'recorded_variation' : 'differs_by_source';
    const note = state === 'recorded_variation'
      ? (field === 'student_name' ? 'Different sources record different spellings. This is a recorded variation, not an established name change.' : 'Different sources record different values. No correction links them, so which is right is not established.')
      : state === 'differs_by_source' ? 'Differs between sources, as expected for records from different institutions or sessions. Not an identity conflict.'
      : state === 'corrected' ? 'Changed between versions of one source record (see the correction events). Earlier values are kept.'
      : state === 'missing_in_some' ? 'Missing in some sources. A missing value is not a conflicting one.' : null;
    return { field, label, state, note, values: present.map(v => ({ value: v, records: values.get(v) })), missing_in: missing, corrections };
  });
}

function relationshipsOf(db, p, members, asOf) {
  const ids = new Set(members.map(r => r.id));
  const records = new Map(db.sourceRecords.map(r => [r.id, r]));
  const autoKnown = autoMatchTimes(db);
  const findings = db.findings;
  const out = [];
  for (const l of db.identityLinks || []) {
    if (!l.records.some(id => ids.has(id))) continue;
    if (!l.records.every(id => records.get(id) && canAccess(p, records.get(id)))) continue;
    const d = decisionFor(db, l);
    const decision = d ? decisionAt(d, asOf) : null;
    let known; let status = resolution(l, decision);
    if (!asOf) known = true;
    else if (l.outcome === 'auto_linked') known = Boolean(autoKnown.get(l.records.slice().sort().join('|')) <= asOf);
    else if (l.outcome === 'same_source_record') known = l.records.every(id => before(records.get(id).imported_at, asOf));
    else {
      const f = findings.find(x => (x.identity_link_ids || []).includes(l.id) || x.id === l.finding_id);
      known = Boolean(decision) || Boolean(f && before(f.created_at, asOf));
    }
    if (l.withdrawn && asOf && !before(l.withdrawn.at, asOf) && !decision) status = 'POTENTIAL_MATCH';
    if (!known) continue;
    out.push({
      link_id: l.id, method: l.method, outcome: l.outcome, resolution: status, label: RESOLUTIONS[status] || status, within_identity: l.records.every(id => ids.has(id)),
      records: l.records.map(id => ref(db, records.get(id))), agreeing_fields: l.agreeing_fields, similar_fields: l.similar_fields || [], conflicting_fields: l.conflicting_fields, missing_fields: l.missing_fields,
      competing_candidates: l.competing_candidates || 0, withdrawn: l.withdrawn && before(l.withdrawn.at, asOf) ? l.withdrawn : null, reason: l.reason, policy_version: l.policy_version,
      decision: decision ? { decision: decision.decision, reviewer: decision.reviewer, at: decision.at, note: decision.note } : null
    });
  }
  // As of a past time: automatic matches recorded then, even if the current links were rebuilt since.
  if (asOf) autoMatchIntervals(db).filter(m => m.from <= asOf && m.records.some(id => ids.has(id))).forEach(m => {
    const recs = m.records.filter(id => records.get(id) && canAccess(p, records.get(id)) && before(records.get(id).imported_at, asOf));
    if (recs.length < 2 || out.some(r => r.outcome === 'auto_linked' && recs.every(id => r.records.some(x => x.record_id === id)))) return;
    const active = !m.until || m.until > asOf;
    // Only an explicit withdrawal is a withdrawal; a recomputation or correction merely replaced the match.
    const withdrawn = !active && m.ended_by === 'automatic_match_withdrawn';
    out.push({ link_id: null, method: 'protected_identifier_exact', outcome: active ? 'auto_linked' : withdrawn ? 'withdrawn' : 'replaced', resolution: active ? 'AUTO_MATCHED' : withdrawn ? 'MATCH_WITHDRAWN' : 'SAME_SOURCE_RECORD', label: active ? `${RESOLUTIONS.AUTO_MATCHED} (as recorded then)` : withdrawn ? `${RESOLUTIONS.MATCH_WITHDRAWN} (as recorded then)` : `Earlier automatic match, replaced after ${m.ended_by === 'resolved_by_correction' ? 'a correction' : 'a recomputation'}`, within_identity: recs.every(id => ids.has(id)), records: recs.map(id => ref(db, records.get(id))), agreeing_fields: [], similar_fields: [], conflicting_fields: [], missing_fields: [], withdrawn: active ? null : { at: m.until, reason: 'Ended by a later recomputation or correction.' }, reason: 'From the audit trail: automatically matched at the time shown.', decision: null });
  });
  // Automatic links that no longer exist at all (the pair stopped being comparable after new evidence).
  (db.identityLinkEvents || []).filter(e => e.records.some(id => ids.has(id)) && before(e.at, asOf)).forEach(e => out.push({ link_id: null, method: 'protected_identifier_exact', outcome: 'withdrawn', resolution: 'MATCH_WITHDRAWN', label: RESOLUTIONS.MATCH_WITHDRAWN, within_identity: false, records: e.records.filter(id => records.get(id) && canAccess(p, records.get(id))).map(id => ref(db, records.get(id))), agreeing_fields: [], similar_fields: [], conflicting_fields: [], missing_fields: [], withdrawn: { at: e.at, reason: e.reason }, reason: e.reason, decision: null }));
  return out;
}

function timeline(db, p, members, asOf) {
  const ids = new Set(members.map(r => r.id));
  const records = new Map(db.sourceRecords.map(r => [r.id, r]));
  const events = [];
  const add = e => { if (before(e.at, asOf)) events.push(e); };
  const snapshot = r => ({ name: r.student_name || null, date_of_birth: r.date_of_birth || null, apaar_id: r.apaar_id ? mask(r.apaar_id) : null, programme: r.programme || null });
  for (const r of members) {
    const l = lineageOf(r);
    add({ at: r.imported_at, time_kind: 'import', category: 'record', type: l.relation === 'correction' ? 'corrected_version_stored' : l.relation === 'unchanged_copy' ? 'unchanged_reimport' : 'record_stored', institution_code: r.institution_code, record_ids: [r.id], source: ref(db, r),
      title: l.relation === 'correction' ? `Corrected version ${l.version} stored` : l.relation === 'unchanged_copy' ? 'Same record re-sent unchanged' : 'Source record stored',
      reported: { academic_session: r.academic_session || null, admission_year: r.admission_year || null, enrolment_status: r.enrolment_status || null }, values: snapshot(r) });
  }
  (db.lineageEvents || []).filter(e => [e.earlier, e.later].some(id => ids.has(id))).forEach(e => add({ at: e.at, time_kind: e.actor && !/automated/.test(e.actor) ? 'reviewer' : 'system', category: 'correction', type: e.action, institution_code: e.institution_code, record_ids: [e.earlier, e.later].filter(Boolean),
    title: { version_superseded: 'Earlier version superseded by a correction', correction_candidate_created: 'Possible correction awaiting confirmation', correction_confirmed: 'Correction confirmed by a reviewer', correction_rejected: 'Correction rejected: both records kept' }[e.action] || e.action,
    changes: e.changes || [], basis: e.basis || null, actor: e.actor || null, note: e.note || null }));
  const related = db.findings.filter(f => f.evidence.some(id => ids.has(id)) && f.evidence.every(id => records.get(id) && canAccess(p, records.get(id))));
  const relatedIds = new Set(related.map(f => f.id));
  related.forEach(f => add({ at: f.created_at, time_kind: 'system', category: f.rule_code === 'CANDIDATE_IDENTITY_MATCH' ? 'identity' : 'finding', type: 'finding_raised', evidence_kind: EVIDENCE_KIND[f.rule_code] || 'other', finding_id: f.id, rule_code: f.rule_code, institution_code: records.get(f.evidence[0])?.institution_code || null, record_ids: f.evidence.filter(id => ids.has(id)),
    title: f.title, explanation: f.explanation, current_status: f.review_status, lifecycle_status: f.lifecycle_status || 'current' }));
  (db.auditEvents || []).filter(e => relatedIds.has(e.finding_id)).forEach(e => add({ at: e.at, time_kind: e.system ? 'system' : 'reviewer', category: e.system ? (AUDIT_CATEGORY[e.action] || 'finding') : 'review', type: e.action, finding_id: e.finding_id, record_ids: e.source_records || [], actor: e.actor, note: e.note, from_state: e.from_state || null, to_state: e.to_state || null, title: null }));
  (db.identityLinkEvents || []).filter(e => e.records.some(id => ids.has(id))).forEach(e => add({ at: e.at, time_kind: 'system', category: 'identity', type: 'automatic_link_withdrawn', record_ids: e.records, title: 'Automatic link withdrawn', note: e.reason }));
  const order = { record: 0, correction: 1, finding: 2, identity: 3, review: 4 };
  return events.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || order[a.category] - order[b.category]).map((e, i) => ({ id: `EV-${i + 1}`, ...e }));
}

function identityHistory(db, p, recordId, { asOf = null } = {}) {
  // A date means the end of that day in UTC; the response says so.
  const cutoff = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? `${asOf}T23:59:59.999Z` : asOf || null;
  const cluster = clusterOf(db, p, recordId, cutoff);
  if (!cluster) {
    const r = db.sourceRecords.find(x => x.id === recordId);
    if (!r || !canAccess(p, r)) return null;
    // The record exists but had not been stored by the chosen time.
    return { root_record_id: recordId, as_of: cutoff, not_yet_stored: true, stored_at: r.imported_at || null, basis: '', records: [], hidden_records: 0, institutions: [], variations: [], relationships: [], timeline: [], time_note: '' };
  }
  const { members, hidden } = cluster;
  const institutions = [...new Set(members.map(r => r.institution_code))];
  return {
    root_record_id: recordId, as_of: cutoff,
    basis: 'Records are grouped only by versions of one source record, automatic links under the matching policy, or a reviewer\'s "same person" decision. Potential, rejected and withdrawn relationships are listed but never group records.',
    // As of a past time, a version superseded later is shown as it was then: current.
    records: members.map(r => ({ ...ref(db, r), ...(cutoff && r.superseded_at && r.superseded_at > cutoff ? { active: true, superseded_by: null } : {}), values: { student_name: r.student_name || null, date_of_birth: r.date_of_birth || null, apaar_id: r.apaar_id ? mask(r.apaar_id) : null, programme: r.programme || null, academic_session: r.academic_session || null, enrolment_status: r.enrolment_status || null } })),
    hidden_records: hidden,
    institutions: institutions.map(code => ({ code, name: (db.institutions || []).find(i => i.code === code)?.name || code, records: members.filter(r => r.institution_code === code).map(r => r.id) })),
    variations: variations(db, members),
    relationships: relationshipsOf(db, p, members, cutoff),
    timeline: timeline(db, p, members, cutoff),
    time_note: 'Import, system and reviewer times are when EduTrace stored or recorded something. Academic session, admission year and enrolment status are what the institution reported; no admission, transfer or name-change date is inferred.'
  };
}

// Paged, searchable list of every accessible source record (current and historical), so records that
// are not part of any finding remain discoverable from the graph.
function listRecords(db, p, params = new URLSearchParams()) {
  const q = String(params.get('q') || '').normalize('NFKC').trim().toLocaleLowerCase('en-IN');
  const institution = String(params.get('institution') || '').toUpperCase();
  const versions = params.get('versions') === 'all';
  const offset = Math.max(Number(params.get('offset')) || 0, 0);
  const limit = Math.min(Math.max(Number(params.get('limit')) || 50, 1), 200);
  const list = db.sourceRecords.filter(r => canAccess(p, r) && (!institution || r.institution_code === institution) && (versions || isActiveRecord(r)) && (!q || [r.student_name, r.id, r.source_file, r.source_reference, `row ${r.source_row}`].some(v => String(v || '').toLocaleLowerCase('en-IN').includes(q))));
  return { total: list.length, offset, limit, data: list.slice(offset, offset + limit).map(r => ({ ...ref(db, r), student_name: r.student_name || null, apaar_id: r.apaar_id ? mask(r.apaar_id) : null, academic_session: r.academic_session || null, enrolment_status: r.enrolment_status || null })) };
}

// One source record in full: the values exactly as imported (identifiers masked), the normalised
// comparison values separately, provenance, versions, findings, identity relationships and audit.
function recordDetail(db, p, recordId) {
  const r = db.sourceRecords.find(x => x.id === recordId);
  if (!r || !canAccess(p, r)) return null;
  const records = new Map(db.sourceRecords.map(x => [x.id, x]));
  const batch = r.import_id ? (db.importBatches || []).find(b => b.id === r.import_id) : null;
  const findings = db.findings.filter(f => f.evidence.includes(r.id) && f.evidence.every(id => records.get(id) && canAccess(p, records.get(id))));
  const ids = new Set(findings.map(f => f.id));
  const links = (db.identityLinks || []).filter(l => l.records.includes(r.id) && l.records.every(id => records.get(id) && canAccess(p, records.get(id))));
  const original = Object.fromEntries(Object.entries(r.original || {}).map(([k, v]) => [k, k === 'apaar_id' && v ? mask(String(v).replace(/[\s-]/g, '')) : String(v ?? '')]));
  return {
    ...ref(db, r),
    source_reference_note: r.source_reference ? null : 'The institution did not supply a record reference for this row.',
    batch: batch ? { id: batch.id, file: batch.source_file, created_at: batch.created_at, institution_code: batch.institution_code } : { id: null, file: r.source_file, created_at: r.imported_at || null, note: 'Seeded synthetic data (no upload batch).' },
    original, comparison: Object.fromEntries(TRACKED.map(([f]) => [f, shown(f, r) || null]).concat([['normalized_name', r.normalized_name || null]])), transformations: r.transformations || {},
    processing: r.processing ? { status: r.processing.status, identifier_check: r.processing.identifier_check, authoritative_verification: 'not_available' } : null,
    lineage: lineageView(db, p, r.id),
    findings: findings.map(f => ({ id: f.id, rule_code: f.rule_code, title: f.title, evidence_kind: EVIDENCE_KIND[f.rule_code] || 'other', review_status: f.review_status, lifecycle_status: f.lifecycle_status || 'current', created_at: f.created_at })),
    relationships: links.map(l => { const d = decisionFor(db, l); const st = resolution(l, d); return { link_id: l.id, method: l.method, resolution: st, label: RESOLUTIONS[st] || st, other: ref(db, records.get(l.records.find(id => id !== r.id) || l.records[0])), agreeing_fields: l.agreeing_fields, conflicting_fields: l.conflicting_fields, missing_fields: l.missing_fields, decision: d ? { decision: d.decision, reviewer: d.reviewer, at: d.at } : null, withdrawn: l.withdrawn || null }; }),
    audit: (db.auditEvents || []).filter(e => ids.has(e.finding_id)).sort((a, b) => String(a.at).localeCompare(String(b.at))).map(e => ({ at: e.at, action: e.action, actor: e.actor, note: e.note, finding_id: e.finding_id, system: Boolean(e.system) }))
  };
}

module.exports = { identityHistory, listRecords, recordDetail, TRACKED };
