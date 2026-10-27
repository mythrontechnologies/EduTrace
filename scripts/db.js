// Explicit PostgreSQL operations. Nothing here runs automatically, and nothing seeds synthetic data.
//   npm run db -- migrate                   apply db/postgres/schema.sql to a database with no EduTrace tables
//   npm run db -- import --source <file>    load a JSON store file into an empty, migrated database (one time)
//   npm run db -- status                    connection, schema version and row counts
// EDUTRACE_DATABASE_URL names the database. The source file is only read.
const fs = require('node:fs');
const path = require('node:path');
const { createPostgresStore } = require('../src/pg-store');

const [command] = process.argv.slice(2);
const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const url = process.env.EDUTRACE_DATABASE_URL;
if (!url) { console.error('Set EDUTRACE_DATABASE_URL to the target database.'); process.exit(2); }

(async () => {
  const store = createPostgresStore({ url });
  try {
    if (command === 'migrate') {
      const existing = (await store.pool.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('schema_migrations', 'source_records')")).rows[0].n;
      if (Number(existing)) { console.error('EduTrace tables already exist; nothing was changed.'); process.exitCode = 1; return; }
      await store.pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'postgres', 'schema.sql'), 'utf8'));
      console.log(`Schema applied (version ${(await store.verify()).schema_version}).`);
    } else if (command === 'import') {
      const source = arg('--source');
      if (!source) { console.error('Usage: npm run db -- import --source <json file>'); process.exitCode = 2; return; }
      await store.verify();
      const doc = JSON.parse(fs.readFileSync(source, 'utf8'));
      await store.importInto(doc);
      console.log(`Imported ${doc.sourceRecords?.length || 0} source records and ${doc.findings?.length || 0} findings.`);
    } else if (command === 'status') {
      const v = await store.verify();
      const counts = {};
      for (const t of ['source_records', 'findings', 'audit_events', 'decision_receipts', 'consent_records', 'app_users']) counts[t] = Number((await store.pool.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
      console.log(JSON.stringify({ schema_version: v.schema_version, rows: counts }, null, 2));
    } else { console.error('Usage: npm run db -- migrate | import --source <file> | status'); process.exitCode = 2; }
  } catch (error) { console.error(error.message); process.exitCode = 1; } finally { await store.close(); }
})();
