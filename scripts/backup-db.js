// Verified backup of the development database (npm run backup-db -- [--label name] [--dir path]).
// Copies the file, writes a SHA-256 manifest beside it and checks the copy. It never overwrites anything.
const path = require('node:path');
const { dataPath } = require('../src/seed');
const { createBackup } = require('../src/backup');
const arg = name => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const dir = arg('--dir') || path.join(__dirname, '..', '..', 'EduTrace_backups');
const result = createBackup(dataPath(), dir, { label: arg('--label') || 'manual' });
console.log(`Backup written: ${result.path}\nSHA-256 ${result.sha256} (${result.bytes} bytes), manifest ${path.basename(result.manifest)}`);
