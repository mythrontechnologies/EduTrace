// JSON store <-> relational rows for db/postgres/schema.sql, and the checks run before any migration.
//
// toRelational(db) splits the JSON document into the schema's tables: typed columns are projections of each
// record, `doc` carries the record itself, and arrays with their own identity (finding evidence, link records,
// notification items, import row outcomes) and mutable record state (supersession, processing status) go to
// child tables. fromRelational(tables) is the exact inverse. validateRelational checks primary keys, foreign
// keys, required columns and timestamps; toSql renders deterministic INSERT statements. Nothing here connects
// to a database or writes a file.
const { lineageOf } = require('./lineage');
const { canonical } = require('./receipts');

const COLLECTIONS = ['institutions', 'importBatches', 'sourceRecords', 'capacityRules', 'findings', 'auditEvents', 'identityLinks', 'identityLinkEvents', 'matchDecisions', 'correctionCandidates', 'lineageEvents', 'notifications', 'notificationRegistry', 'automationRuns', 'decisionReceipts', 'consentRecords'];
// Insert order respects foreign keys; primary keys and required columns mirror schema.sql.
const TABLES = {
  edutrace_meta: { pk: ['key'], required: ['key'] },
  institutions: { pk: ['code'], required: ['code', 'name'] },
  import_batches: { pk: ['id'], required: ['id', 'institution_code', 'created_at'], times: ['created_at'] },
  import_row_outcomes: { pk: ['batch_id', 'position'], required: ['batch_id', 'outcome'] },
  source_records: { pk: ['id'], required: ['id', 'institution_code'], times: ['imported_at'] },
  record_lineage: { pk: ['record_id'], required: ['record_id', 'lineage_id', 'version', 'relation'] },
  record_supersessions: { pk: ['earlier'], required: ['earlier', 'later'], times: ['superseded_at'] },
  record_processing: { pk: ['record_id'], required: ['record_id', 'status'], times: ['evaluated_at'] },
  capacity_rules: { pk: ['ord'], required: ['institution_code', 'programme', 'academic_session', 'permitted_capacity'] },
  findings: { pk: ['id'], required: ['id', 'rule_code', 'title', 'explanation', 'review_status', 'lifecycle_status'], times: ['created_at'] },
  finding_evidence: { pk: ['finding_id', 'position'], required: ['finding_id', 'record_id'] },
  audit_events: { pk: ['id'], required: ['id', 'action', 'actor', 'at'], times: ['at'] },
  identity_links: { pk: ['id'], required: ['id', 'link_key', 'method', 'outcome', 'policy_version'] },
  identity_link_records: { pk: ['link_id', 'position'], required: ['link_id', 'record_id'] },
  identity_link_events: { pk: ['ord'], required: ['at', 'action'], times: ['at'] },
  match_decisions: { pk: ['slot'], required: ['slot', 'decision', 'reviewer', 'at'], times: ['at'] },
  correction_candidates: { pk: ['id'], required: ['id', 'institution_code', 'earlier', 'later', 'status'], times: ['created_at', 'decided_at'] },
  lineage_events: { pk: ['id'], required: ['id', 'action', 'at'], times: ['at'] },
  notifications: { pk: ['id'], required: ['id', 'created_at'], times: ['created_at'] },
  notification_items: { pk: ['notification_id', 'position'], required: ['notification_id'] },
  notification_registry: { pk: ['key'], required: ['key'] },
  automation_runs: { pk: ['ord'], required: ['at'], times: ['at'] },
  decision_receipts: { pk: ['receipt_id'], required: ['receipt_id', 'kind', 'decided_at', 'digest'], times: ['decided_at'] },
  consent_records: { pk: ['id'], required: ['id', 'lineage_id', 'institution_code', 'purpose', 'status', 'recorded_by', 'recorded_at'], times: ['recorded_at'] }
};
const JSON_COLUMNS = new Set(['doc', 'value', 'acknowledged']);
const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const opt = v => (v === undefined ? null : v);

function toRelational(db) {
  const t = Object.fromEntries(Object.keys(TABLES).map(k => [k, []]));
  for (const [key, value] of Object.entries(db)) if (!COLLECTIONS.includes(key)) t.edutrace_meta.push({ key, value });
  t.edutrace_meta.push({ key: '__collections__', value: COLLECTIONS.filter(k => db[k] !== undefined) });
  (db.institutions || []).forEach((x, ord) => t.institutions.push({ code: x.code, name: x.name, ord, doc: x }));
  (db.importBatches || []).forEach((b, ord) => {
    t.import_batches.push({ id: b.id, institution_code: b.institution_code, source_file: opt(b.source_file), created_at: b.created_at, multi_institution: Boolean(b.multi_institution), ord, doc: { ...omit(b, ['row_outcomes']), __has_row_outcomes: Array.isArray(b.row_outcomes) } });
    (b.row_outcomes || []).forEach((o, position) => t.import_row_outcomes.push({ batch_id: b.id, position, source_row: opt(o.source_row), outcome: o.outcome, doc: o }));
  });
  (db.sourceRecords || []).forEach((r, ord) => {
    const lineage = lineageOf(r);
    // The version row holds what was submitted; lineage, supersession and processing change later and live beside it.
    t.source_records.push({ id: r.id, institution_code: r.institution_code, import_id: opt(r.import_id), source_file: opt(r.source_file), source_row: opt(r.source_row), source_reference: r.source_reference || null, apaar_fingerprint: opt(r.apaar_fingerprint), imported_at: opt(r.imported_at), ord, doc: omit(r, ['processing', 'superseded_by', 'superseded_at', 'lineage']) });
    if (r.lineage !== undefined) t.record_lineage.push({ record_id: r.id, lineage_id: lineage.id, version: lineage.version, relation: lineage.relation, doc: r.lineage });
    if (r.superseded_by !== undefined) t.record_supersessions.push({ earlier: r.id, later: r.superseded_by, superseded_at: opt(r.superseded_at), doc: r.superseded_at === undefined ? { superseded_by: r.superseded_by } : { superseded_by: r.superseded_by, superseded_at: r.superseded_at } });
    if (r.processing !== undefined) t.record_processing.push({ record_id: r.id, status: r.processing.status, evaluated_at: opt(r.processing.evaluated_at), doc: r.processing });
  });
  (db.capacityRules || []).forEach((c, ord) => t.capacity_rules.push({ ord, institution_code: c.institution_code, programme: c.programme, academic_session: c.academic_session, permitted_capacity: c.permitted_capacity, doc: c }));
  (db.findings || []).forEach((f, ord) => {
    t.findings.push({ id: f.id, rule_code: f.rule_code, rule_version: opt(f.rule_version), category: opt(f.category), severity: opt(f.severity), title: f.title, explanation: f.explanation, review_status: f.review_status, lifecycle_status: f.lifecycle_status || 'current', condition_key: opt(f.condition_key), superseded_by: opt(f.superseded_by), created_at: opt(f.created_at), ord, doc: omit(f, ['evidence']) });
    f.evidence.forEach((record_id, position) => t.finding_evidence.push({ finding_id: f.id, position, record_id }));
  });
  (db.auditEvents || []).forEach((e, ord) => t.audit_events.push({ id: e.id, finding_id: opt(e.finding_id), action: e.action, actor: e.actor, at: e.at, system: Boolean(e.system), receipt_id: opt(e.receipt_id), ord, doc: e }));
  (db.identityLinks || []).forEach((l, ord) => {
    t.identity_links.push({ id: l.id, link_key: l.key, evidence_key: opt(l.evidence_key), method: l.method, outcome: l.outcome, policy_version: l.policy_version, group_key: opt(l.group_key), finding_id: opt(l.finding_id), ord, doc: omit(l, ['records']) });
    l.records.forEach((record_id, position) => t.identity_link_records.push({ link_id: l.id, position, record_id }));
  });
  (db.identityLinkEvents || []).forEach((e, ord) => t.identity_link_events.push({ ord, at: e.at, action: e.action, doc: e }));
  Object.entries(db.matchDecisions || {}).forEach(([slot, d], ord) => t.match_decisions.push({ slot, link_id: opt(d.link_id), decision: d.decision, reviewer: d.reviewer, at: d.at, receipt_id: opt(d.receipt_id), ord, doc: d }));
  (db.correctionCandidates || []).forEach((c, ord) => t.correction_candidates.push({ id: c.id, institution_code: c.institution_code, earlier: c.earlier, later: c.later, status: c.status, created_at: opt(c.created_at), decided_at: opt(c.decided_at), receipt_id: opt(c.receipt_id), ord, doc: c }));
  (db.lineageEvents || []).forEach((e, ord) => t.lineage_events.push({ id: e.id, action: e.action, earlier: opt(e.earlier), later: opt(e.later), at: e.at, ord, doc: e }));
  (db.notifications || []).forEach((n, ord) => {
    t.notifications.push({ id: n.id, created_at: n.created_at, origin: opt(n.origin), batch_id: opt(n.batch_id), institution_code: opt(n.institution_code), acknowledged: opt(n.acknowledged), ord, doc: omit(n, ['items']) });
    n.items.forEach((item, position) => t.notification_items.push({ notification_id: n.id, position, finding_id: opt(item.finding_id), doc: item }));
  });
  Object.entries(db.notificationRegistry || {}).forEach(([key, doc]) => t.notification_registry.push({ key, doc }));
  (db.automationRuns || []).forEach((r, ord) => t.automation_runs.push({ ord, at: r.at, origin: opt(r.origin), doc: r }));
  (db.decisionReceipts || []).forEach((r, ord) => t.decision_receipts.push({ receipt_id: r.receipt_id, kind: r.kind, decided_at: r.decided_at, digest: r.integrity?.digest, ord, doc: r }));
  (db.consentRecords || []).forEach((c, ord) => t.consent_records.push({ id: c.id, lineage_id: c.lineage_id, institution_code: c.institution_code, purpose: c.purpose, status: c.status, recorded_by: c.recorded_by, recorded_at: c.recorded_at, ord, doc: c }));
  return t;
}

function fromRelational(t) {
  const db = {};
  const meta = new Map(t.edutrace_meta.map(m => [m.key, m.value]));
  for (const [key, value] of meta) if (key !== '__collections__') db[key] = value;
  const present = new Set(meta.get('__collections__') || COLLECTIONS);
  const byOrd = rows => [...rows].sort((a, b) => a.ord - b.ord);
  const group = (rows, key) => { const m = new Map(); rows.forEach(r => m.set(r[key], [...(m.get(r[key]) || []), r])); m.forEach(list => list.sort((a, b) => a.position - b.position)); return m; };
  const outcomes = group(t.import_row_outcomes, 'batch_id'); const evidence = group(t.finding_evidence, 'finding_id');
  const linkRecords = group(t.identity_link_records, 'link_id'); const items = group(t.notification_items, 'notification_id');
  const supersessions = new Map(t.record_supersessions.map(s => [s.earlier, s])); const processing = new Map(t.record_processing.map(p => [p.record_id, p])); const lineages = new Map(t.record_lineage.map(l => [l.record_id, l]));
  const set = (name, value) => { if (present.has(name)) db[name] = value; };
  set('institutions', byOrd(t.institutions).map(r => r.doc));
  set('importBatches', byOrd(t.import_batches).map(r => { const { __has_row_outcomes, ...b } = r.doc; return __has_row_outcomes ? { ...b, row_outcomes: (outcomes.get(r.id) || []).map(o => o.doc) } : b; }));
  set('sourceRecords', byOrd(t.source_records).map(r => {
    const out = { ...r.doc }; const s = supersessions.get(r.id); const p = processing.get(r.id); const l = lineages.get(r.id);
    if (l) out.lineage = l.doc;
    if (s) Object.assign(out, s.doc);
    if (p) out.processing = p.doc;
    return out;
  }));
  set('capacityRules', byOrd(t.capacity_rules).map(r => r.doc));
  set('findings', byOrd(t.findings).map(r => ({ ...r.doc, evidence: (evidence.get(r.id) || []).map(e => e.record_id) })));
  set('auditEvents', byOrd(t.audit_events).map(r => r.doc));
  set('identityLinks', byOrd(t.identity_links).map(r => ({ ...r.doc, records: (linkRecords.get(r.id) || []).map(x => x.record_id) })));
  set('identityLinkEvents', byOrd(t.identity_link_events).map(r => r.doc));
  set('matchDecisions', Object.fromEntries(byOrd(t.match_decisions).map(r => [r.slot, r.doc])));
  set('correctionCandidates', byOrd(t.correction_candidates).map(r => r.doc));
  set('lineageEvents', byOrd(t.lineage_events).map(r => r.doc));
  set('notifications', byOrd(t.notifications).map(r => ({ ...r.doc, items: (items.get(r.id) || []).map(i => i.doc) })));
  set('notificationRegistry', Object.fromEntries(t.notification_registry.map(r => [r.key, r.doc])));
  set('automationRuns', byOrd(t.automation_runs).map(r => r.doc));
  set('decisionReceipts', byOrd(t.decision_receipts).map(r => r.doc));
  set('consentRecords', byOrd(t.consent_records).map(r => r.doc));
  return db;
}

function validateRelational(t) {
  const problems = [];
  for (const [table, spec] of Object.entries(TABLES)) {
    const seen = new Set();
    for (const row of t[table]) {
      const key = spec.pk.map(c => String(row[c])).join('|');
      if (seen.has(key)) problems.push(`${table}: duplicate primary key ${key}`); seen.add(key);
      spec.required.filter(c => row[c] === null || row[c] === undefined || row[c] === '').forEach(c => problems.push(`${table} ${key}: ${c} is required`));
      (spec.times || []).filter(c => row[c] !== null && row[c] !== undefined && !Number.isFinite(Date.parse(row[c]))).forEach(c => problems.push(`${table} ${key}: ${c} is not a timestamp`));
    }
  }
  const ids = table => new Set(t[table].map(r => r[TABLES[table].pk[0]]));
  const fk = (table, column, target, nullable = true) => { const keys = ids(target); t[table].forEach(r => { if (r[column] === null || r[column] === undefined) { if (!nullable) problems.push(`${table}: ${column} is required`); return; } if (!keys.has(r[column])) problems.push(`${table}: ${column} ${r[column]} has no ${target} row`); }); };
  fk('source_records', 'institution_code', 'institutions', false); fk('source_records', 'import_id', 'import_batches');
  fk('import_row_outcomes', 'batch_id', 'import_batches', false); fk('record_supersessions', 'earlier', 'source_records', false); fk('record_supersessions', 'later', 'source_records', false);
  fk('record_processing', 'record_id', 'source_records', false); fk('record_lineage', 'record_id', 'source_records', false); fk('finding_evidence', 'finding_id', 'findings', false); fk('finding_evidence', 'record_id', 'source_records', false);
  fk('audit_events', 'finding_id', 'findings'); fk('identity_link_records', 'link_id', 'identity_links', false); fk('identity_link_records', 'record_id', 'source_records', false);
  fk('correction_candidates', 'earlier', 'source_records', false); fk('correction_candidates', 'later', 'source_records', false); fk('notification_items', 'notification_id', 'notifications', false);
  return { ok: problems.length === 0, problems };
}

// Per-collection parity between the source document and the document rebuilt from the rows.
function compareDocuments(original, rebuilt) {
  const keys = [...new Set([...Object.keys(original), ...Object.keys(rebuilt)])];
  return keys.map(key => {
    const a = original[key]; const b = rebuilt[key];
    const count = v => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : v === undefined ? 0 : 1);
    return { collection: key, original: count(a), migrated: count(b), equal: a !== undefined && b !== undefined ? canonical(a) === canonical(b) : a === b };
  });
}

const literal = (column, value) => {
  if (value === null || value === undefined) return 'NULL';
  if (JSON_COLUMNS.has(column)) return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(`${column}: non-finite number`); return String(value); }
  return `'${String(value).replaceAll("'", "''")}'`;
};
function toSql(t, { batch = 200 } = {}) {
  const out = ['-- Generated by scripts/migrate-json-to-postgres.js. Apply after db/postgres/schema.sql, in one transaction.', 'BEGIN;'];
  for (const table of Object.keys(TABLES)) {
    const rows = t[table]; if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    for (let i = 0; i < rows.length; i += batch) {
      out.push(`INSERT INTO ${table} (${columns.join(', ')}) VALUES`);
      out.push(rows.slice(i, i + batch).map(r => `  (${columns.map(c => literal(c, r[c])).join(', ')})`).join(',\n') + ';');
    }
  }
  out.push('COMMIT;');
  return out.join('\n') + '\n';
}

module.exports = { COLLECTIONS, TABLES, toRelational, fromRelational, validateRelational, compareDocuments, toSql };
