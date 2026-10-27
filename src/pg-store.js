// PostgreSQL store for db/postgres/schema.sql (EDUTRACE_STORE=postgres, development mode).
//
// It keeps the application's document interface (load the data, run the same pipeline, save it), so the rules
// run unchanged on either store. What PostgreSQL adds:
//   * every statement is parameterised; values never become SQL text;
//   * a save is one transaction. It locks the document version row, and refuses (409) if another writer saved
//     since this request loaded, so concurrent writers cannot lose each other's updates;
//   * source-record versions, audit events, lineage events, consent records and decision receipts are only ever
//     inserted. A save that would change or drop one is refused, and the database's own triggers also refuse;
//   * a missing or unmigrated database is an error. The store never creates tables and never seeds data.
// The store loads the whole document, as the JSON store does; that limits scale (docs/MVP_COMPLETION_RESULTS.md).
// A save writes only the rows that differ from what is stored (docs/PERFORMANCE_RESULTS.md).
// Reads share one snapshot: load({ shared: true }) asks only for the stored version and, while it is unchanged,
// returns the document already loaded at that version instead of reading every table again. Every save bumps the
// version in the same transaction as its rows, so an unchanged version means unchanged rows. A shared document is
// never changed by the caller (the read routes do not modify what they read: test/read-routes.test.js) and can never
// be saved; a request that may write calls load() and gets its own copy, read from the database.
const { TABLES, toRelational, fromRelational, validateRelational } = require('./relational');
const { canonical } = require('./receipts');

const SCHEMA_VERSION = 1;
const VERSION_KEY = '__doc_version';
const APPEND_ONLY = new Set(['source_records', 'audit_events', 'lineage_events', 'decision_receipts', 'consent_records']);
const REPLACED = new Set(['import_row_outcomes', 'finding_evidence', 'identity_link_records', 'notification_items']);
const JSON_COLUMNS = new Set(['doc', 'value', 'acknowledged']);

class StoreError extends Error { constructor(status, message, code) { super(message); this.name = 'StoreError'; this.status = status; this.code = code; } }

const ident = name => { if (!/^[a-z_]+$/.test(name)) throw new Error(`unsafe identifier ${name}`); return name; };
const param = (column, value) => (value === undefined ? null : JSON_COLUMNS.has(column) ? JSON.stringify(value) : value);
const keyOf = (table, row) => TABLES[table].pk.map(c => String(row[c])).join('|');

// A stored row equals the row about to be written when every column the write sets has the same value. Values are
// compared in one normalised form: SQL NULL apart from any text, JSON by canonical content, timestamps as ISO text.
// A difference in representation only ever causes a write, never skips one.
const norm = (column, value) => (value === undefined || value === null ? null
  : JSON_COLUMNS.has(column) ? `j:${canonical(value)}` : value instanceof Date ? `v:${value.toISOString()}` : `v:${String(value)}`);
const sameRow = (stored, row) => Object.keys(row).every(c => norm(c, stored[c]) === norm(c, row[c]));

// Deletes rows by primary key, many per statement.
async function deleteRows(client, table, rows) {
  const pk = TABLES[table].pk.map(ident); const per = Math.max(1, Math.floor(30000 / pk.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per); const values = [];
    const tuples = chunk.map(r => `(${pk.map(c => { values.push(r[c]); return `$${values.length}`; }).join(', ')})`);
    await client.query(`DELETE FROM ${ident(table)} WHERE (${pk.join(', ')}) IN (${tuples.join(', ')})`, values);
  }
}

// Multi-row parameterised INSERT, chunked below PostgreSQL's parameter limit.
async function insertRows(client, table, rows, { upsert = false } = {}) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]).map(ident); const pk = TABLES[table].pk;
  const per = Math.max(1, Math.floor(30000 / columns.length));
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per); const values = [];
    const tuples = chunk.map(row => `(${columns.map(c => { values.push(param(c, row[c])); return `$${values.length}${JSON_COLUMNS.has(c) ? '::jsonb' : ''}`; }).join(', ')})`);
    const conflict = upsert ? ` ON CONFLICT (${pk.map(ident).join(', ')}) DO UPDATE SET ${columns.filter(c => !pk.includes(c)).map(c => `${c} = EXCLUDED.${c}`).join(', ') || `${pk[0]} = EXCLUDED.${pk[0]}`}` : '';
    await client.query(`INSERT INTO ${ident(table)} (${columns.join(', ')}) VALUES ${tuples.join(', ')}${conflict}`, values);
  }
}

function createPostgresStore({ url, pool = null, max = 5 } = {}) {
  if (!url && !pool) throw new StoreError(500, 'EDUTRACE_DATABASE_URL is not set.', 'not_configured');
  // The driver is loaded only when a PostgreSQL store is used, so the JSON and demo paths need no dependency.
  const db = pool || new (require('pg').Pool)({ connectionString: url, max, statement_timeout: 30000 });
  const versions = new WeakMap();
  // The newest shared snapshot: { version, doc, tables }. Its rows are the stored rows at that version.
  let snapshot = null;

  async function verify() {
    let client;
    try { client = await db.connect(); } catch (error) { throw new StoreError(503, `PostgreSQL is unreachable (${error.code || 'connection failed'}).`, 'unreachable'); }
    try {
      const encoding = (await client.query('SHOW server_encoding')).rows[0].server_encoding;
      if (encoding !== 'UTF8') throw new StoreError(503, `The database uses ${encoding}; EduTrace needs a UTF8 database.`, 'encoding');
      const present = new Set((await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()')).rows.map(r => r.table_name));
      const missing = ['schema_migrations', ...Object.keys(TABLES), 'app_users'].filter(t => !present.has(t));
      if (missing.length) throw new StoreError(503, `The EduTrace schema is not installed (missing ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}). Apply it explicitly with npm run db -- migrate.`, 'schema_missing');
      const version = (await client.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v;
      if (version !== SCHEMA_VERSION) throw new StoreError(503, `Schema version ${version} found; this build needs ${SCHEMA_VERSION}.`, 'schema_version');
      return { schema_version: version };
    } finally { client.release(); }
  }

  // Every table, read in one consistent snapshot together with the version row.
  async function readAll() {
    const client = await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tables = {};
      for (const table of Object.keys(TABLES)) tables[table] = (await client.query(`SELECT * FROM ${ident(table)}`)).rows;
      await client.query('COMMIT');
      const versionRow = tables.edutrace_meta.find(m => m.key === VERSION_KEY);
      const docTables = { ...tables, edutrace_meta: tables.edutrace_meta.filter(m => m.key !== VERSION_KEY) };
      const doc = docTables.edutrace_meta.length ? fromRelational(docTables) : { version: 1, institutions: [], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] };
      return { version: versionRow ? Number(versionRow.value) : 0, doc, tables };
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
  }

  async function storedVersion() {
    const row = (await db.query('SELECT value FROM edutrace_meta WHERE key = $1', [VERSION_KEY])).rows[0];
    return row ? Number(row.value) : 0;
  }

  async function load({ shared = false } = {}) {
    if (shared) {
      if (snapshot && snapshot.version === await storedVersion()) return snapshot.doc;
      const loaded = await readAll();
      // Two reads that overlap a save may finish out of order; the newer version is kept.
      if (!snapshot || loaded.version >= snapshot.version) snapshot = loaded;
      return loaded.doc;
    }
    const { version, doc } = await readAll();
    versions.set(doc, version);
    return doc;
  }

  async function write(doc, expected) {
    const rows = toRelational(doc);
    const check = validateRelational(rows);
    if (!check.ok) throw new StoreError(500, `The data failed validation before saving: ${check.problems.slice(0, 3).join('; ')}`, 'invalid_document');
    // The shared snapshot at the expected version holds the stored rows, unchanged (shared documents are never
    // modified); with it, the save need not read every table again. Without it, the rows are read below.
    const known = snapshot && snapshot.version === expected ? snapshot.tables : null;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const current = (await client.query('SELECT value FROM edutrace_meta WHERE key = $1 FOR UPDATE', [VERSION_KEY])).rows[0];
      const stored = current ? Number(current.value) : 0;
      if (stored !== expected) throw new StoreError(409, 'The data changed since this request read it; nothing was saved. Reload and try again.', 'conflict');
      // Only rows that differ from what is stored are written. The version lock above means the rows read here are
      // the rows the request loaded; a decision changes a few rows, not every row of every table.
      const storedRows = async table => new Map((known ? known[table] : (await client.query(`SELECT * FROM ${ident(table)}`)).rows).map(r => [keyOf(table, r), r]));
      const childInserts = {};
      for (const table of [...REPLACED]) {
        // Child rows that are absent or changed are removed first (before any parent row is), then re-inserted last.
        const existing = await storedRows(table); const insert = [];
        for (const row of rows[table]) { const k = keyOf(table, row); const prior = existing.get(k); if (prior && sameRow(prior, row)) existing.delete(k); else insert.push(row); }
        await deleteRows(client, table, [...existing.values()]);
        childInserts[table] = insert;
      }
      const order = Object.keys(TABLES);
      const absent = {};
      for (const table of order) {
        if (REPLACED.has(table)) continue;
        if (APPEND_ONLY.has(table)) {
          const existing = await storedRows(table);
          const fresh = [];
          for (const row of rows[table]) {
            const prior = existing.get(keyOf(table, row));
            if (!prior) { fresh.push(row); continue; }
            if (canonical(prior.doc) !== canonical(row.doc)) throw new StoreError(500, `${table} ${keyOf(table, row)} is append-only and may not change.`, 'append_only_violation');
            existing.delete(keyOf(table, row));
          }
          if (existing.size) throw new StoreError(500, `${table} rows are append-only and may not be removed (${[...existing.keys()].slice(0, 3).join(', ')}).`, 'append_only_violation');
          await insertRows(client, table, fresh);
        } else {
          const existing = await storedRows(table);
          const wanted = table === 'edutrace_meta' ? [...rows[table], { key: VERSION_KEY, value: stored + 1 }] : rows[table];
          await insertRows(client, table, wanted.filter(row => { const prior = existing.get(keyOf(table, row)); return !prior || !sameRow(prior, row); }), { upsert: true });
          const keep = new Set(wanted.map(r => keyOf(table, r)));
          absent[table] = [...existing.entries()].filter(([k]) => !keep.has(k)).map(([, r]) => r);
        }
      }
      // Rows no longer in the document are removed from mutable tables, children first.
      for (const table of [...order].reverse()) if (absent[table]?.length) await deleteRows(client, table, absent[table]);
      for (const table of order.filter(t => REPLACED.has(t))) await insertRows(client, table, childInserts[table]);
      await client.query('COMMIT');
      versions.set(doc, stored + 1);
      // The snapshot is now out of date; the next read loads the saved version.
      if (snapshot && snapshot.version <= stored) snapshot = null;
      return stored + 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error instanceof StoreError) throw error;
      throw new StoreError(500, `The database refused the save (${error.code || 'error'}); nothing was saved.`, 'database_error');
    } finally { client.release(); }
  }

  return {
    kind: 'postgres', readOnly: false,
    verify, load,
    async save(doc) {
      if (!versions.has(doc)) throw new StoreError(500, 'Only data loaded from this store can be saved to it.', 'unknown_document');
      return write(doc, versions.get(doc));
    },
    // Explicit, one-time load of a document into an empty, migrated database (npm run db -- import).
    async importInto(doc) {
      const count = Number((await db.query('SELECT count(*) AS n FROM source_records')).rows[0].n);
      if (count) throw new StoreError(409, 'The database already holds source records; an import only goes into an empty database.', 'not_empty');
      return write(doc, 0);
    },
    async reset() { throw new StoreError(409, 'The PostgreSQL store is never reset or reseeded from synthetic data.', 'reset_unsupported'); },
    async close() { snapshot = null; if (!pool) await db.end(); },
    pool: db
  };
}

module.exports = { SCHEMA_VERSION, StoreError, createPostgresStore };
