const fs = require('node:fs'); const path = require('node:path'); const { normaliseRecord, syncCapacityFindings, needsCapacityMigration } = require('./engine'); const { needsAutomationMigration, migrateAutomation } = require('./automation'); const { processAll } = require('./pipeline');
const DEFAULT_DATA = path.join(__dirname, '..', 'data', 'demo-db.json');
// EDUTRACE_DB_PATH lets tests (and anyone else) point the app at a separate database file.
function dataPath() { return process.env.EDUTRACE_DB_PATH ? path.resolve(process.env.EDUTRACE_DB_PATH) : DEFAULT_DATA; }
const institutions = [{ code: 'NITM', name: 'Northbridge Institute of Technology' }, { code: 'RCA', name: 'Riverview College of Arts' }, { code: 'SVU', name: 'Suryavardhan Valley University' }];
const programmes = ['BTECH CSE', 'BBA', 'BSC DATA'];
const SEEDED_AT = '2026-10-20T09:00:00.000Z';
function padded(n) { return String(n).padStart(12, '0'); }
function buildDemo() {
  const sourceRecords = []; let count = 0;
  for (const institution of institutions) for (const programme of programmes) for (let i = 1; i <= 40; i++) {
    count++; const apaar = padded(700000000000 + count);
    sourceRecords.push({ id: `SRC-${count}`, source_file: `${institution.code.toLowerCase()}-synthetic.csv`, source_row: i + 1, import_id: `IMP-${institution.code}-01`, imported_at: '2026-10-20T09:00:00.000Z', ...normaliseRecord({ apaar_id: apaar, student_name: `Student ${institution.code} ${i}`, date_of_birth: `0${(i % 9) + 1}/0${(i % 8) + 1}/200${i % 6}`, institution_code: institution.code, programme, academic_session: '2026-27', admission_year: '2026', enrolment_status: 'Active' }) });
  }
  // Labelled anomalies: source values remain synthetic and provenance stays intact.
  const r = (n, patch) => Object.assign(sourceRecords[n], patch, normaliseRecord({ ...sourceRecords[n].original, ...patch }));
  r(0, { apaar_id: '', student_name: '  Student NITM 1 ' }); r(1, { apaar_id: 'ABC-92' });
  r(2, { apaar_id: sourceRecords[3].apaar_id, student_name: sourceRecords[3].student_name, date_of_birth: sourceRecords[3].date_of_birth });
  r(40, { apaar_id: sourceRecords[4].apaar_id, student_name: 'Different Synthetic Name' });
  r(200, { apaar_id: sourceRecords[5].apaar_id, academic_session: '2026-27', enrolment_status: 'Active' });
  r(120, { apaar_id: '', student_name: 'Ambiguous Nair', date_of_birth: '01/01/2004' }); r(280, { apaar_id: '', student_name: 'Ambiguous Nair', date_of_birth: '01/01/2004' });
  r(240, { enrolment_status: 'transferred', academic_session: '2025-26' });
  const db = { version: 1, institutions, importBatches: institutions.map(x => ({ id: `IMP-${x.code}-01`, institution_code: x.code, source_file: `${x.code.toLowerCase()}-synthetic.csv`, imported: 120, rejected: 0, created_at: '2026-10-20T09:00:00.000Z' })), sourceRecords, capacityRules: [{ institution_code: 'NITM', programme: 'BTECH CSE', academic_session: '2026-27', permitted_capacity: 35 }], findings: [], auditEvents: [] };
  // Seeded data goes through the same pipeline as an import: findings, capacity, identity links,
  // automatic matching and the initial exception notifications.
  processAll(db, { at: SEEDED_AT, reason: 'when the synthetic dataset was seeded', origin: 'seed' }); return db;
}
function saveDemo(db) {
  // Write to a sibling temp file, then rename, so an interrupted write cannot leave a truncated database.
  const file = dataPath(); fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, JSON.stringify(db, null, 2)); fs.renameSync(temp, file);
}
function resetDemo() { const db = buildDemo(); saveDemo(db); return db; }
function loadDemo() {
  const file = dataPath(); if (!fs.existsSync(file)) return resetDemo();
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  let migrated = false;
  if (needsCapacityMigration(db)) { syncCapacityFindings(db, { reason: 'during migration to the capacity finding lifecycle' }); migrated = true; }
  // Databases created before autonomous reconciliation are brought onto condition-keyed findings once.
  if (needsAutomationMigration(db)) { migrateAutomation(db); migrated = true; }
  if (migrated) saveDemo(db);
  return db;
}
module.exports = { buildDemo, resetDemo, loadDemo, saveDemo, dataPath, DEFAULT_DATA };
