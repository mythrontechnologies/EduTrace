// Restore rehearsal (npm run restore-rehearsal -- <backup.json>): restores a backup into a fresh temporary
// directory, never over the working database, and reports whether it is a usable, consistent database.
const { dataPath } = require('../src/seed');
const { rehearseRestore } = require('../src/backup');
const file = process.argv[2];
if (!file) { console.error('Usage: npm run restore-rehearsal -- <backup.json>'); process.exit(2); }
const report = rehearseRestore(file, { workingPath: dataPath() });
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
