// Explicit, repeatable JSON -> PostgreSQL migration rehearsal. It never connects to a database.
//   npm run migrate:rehearse -- --out <empty dir> [--source <file>]
// 1. copies the source into the output directory and verifies the copy's SHA-256 (the source is only read);
// 2. converts the copy to the rows of db/postgres/schema.sql and checks keys, references and timestamps;
// 3. rebuilds the document from the rows and compares every collection with the copy;
// 4. writes migration.sql (INSERTs, one transaction) and report.json. Exit code 0 only if every check passed.
const fs = require('node:fs');
const path = require('node:path');
const { dataPath } = require('../src/seed');
const { sha256File } = require('../src/backup');
const { toRelational, fromRelational, validateRelational, compareDocuments, toSql } = require('../src/relational');
const crypto = require('node:crypto');

const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const source = path.resolve(arg('--source') || dataPath());
const out = arg('--out');
if (!out) { console.error('Usage: npm run migrate:rehearse -- --out <empty directory> [--source <file>]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
if (fs.readdirSync(out).length) { console.error(`${out} is not empty; nothing was written.`); process.exit(2); }

const sourceHash = sha256File(source);
const copy = path.join(out, 'source-copy.json');
fs.copyFileSync(source, copy, fs.constants.COPYFILE_EXCL);
if (sha256File(copy) !== sourceHash) { console.error('The copy does not match the source.'); process.exit(1); }
const doc = JSON.parse(fs.readFileSync(copy, 'utf8'));
const tables = toRelational(doc);
const validation = validateRelational(tables);
const parity = compareDocuments(doc, fromRelational(tables));
const sql = toSql(tables);
fs.writeFileSync(path.join(out, 'migration.sql'), sql);
const report = {
  source: { path: source, sha256: sourceHash, unchanged_after_run: sha256File(source) === sourceHash }, copy: { path: copy, sha256: sha256File(copy) },
  rows: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), validation, parity,
  sql: { path: path.join(out, 'migration.sql'), sha256: crypto.createHash('sha256').update(sql).digest('hex'), bytes: Buffer.byteLength(sql) },
  applied_to_database: false, note: 'Rehearsal only. Apply schema.sql then migration.sql to an empty PostgreSQL database after explicit authorisation.'
};
report.ok = validation.ok && parity.every(p => p.equal) && report.source.unchanged_after_run;
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(`${report.ok ? 'OK' : 'FAILED'}: ${parity.length} collections compared, ${validation.problems.length} validation problems. Report: ${path.join(out, 'report.json')}`);
process.exit(report.ok ? 0 : 1);
