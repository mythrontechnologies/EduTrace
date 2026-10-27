// Verified backups and restore rehearsal for the JSON development store.
//
// createBackup copies a database file next to a SHA-256 manifest and checks the copy byte for byte; it
// never overwrites an existing file. verifyBackup re-hashes a backup against its manifest.
// rehearseRestore restores a backup into a fresh temporary directory only (never the working file) and
// checks that it is a usable database: collections present, audit and receipt references resolve, and
// every decision receipt verifies. Nothing here deletes or replaces a file.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyReceipt } = require('./receipts');

const sha256File = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const REQUIRED = ['institutions', 'importBatches', 'sourceRecords', 'capacityRules', 'findings', 'auditEvents'];

function createBackup(source, dir, { label = 'manual', now = new Date() } = {}) {
  if (!fs.existsSync(source)) throw new Error('The database file to back up does not exist.');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const name = `demo-db-${label.replace(/[^a-z0-9-]/gi, '_')}-${stamp}.json`;
  const target = path.join(dir, name);
  if (fs.existsSync(target)) throw new Error(`A backup named ${name} already exists; nothing was overwritten.`);
  const hash = sha256File(source);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  const copy = sha256File(target);
  if (copy !== hash) throw new Error('The backup copy does not match the source.');
  fs.writeFileSync(`${target}.sha256`, `${hash}  ${name}\n`, { flag: 'wx' });
  return { path: target, manifest: `${target}.sha256`, sha256: hash, bytes: fs.statSync(target).size };
}

function verifyBackup(file) {
  const manifest = `${file}.sha256`;
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing_backup' };
  if (!fs.existsSync(manifest)) return { ok: false, reason: 'missing_manifest', sha256: sha256File(file) };
  const expected = fs.readFileSync(manifest, 'utf8').trim().split(/\s+/)[0];
  const actual = sha256File(file);
  return { ok: expected === actual, reason: expected === actual ? null : 'hash_mismatch', expected, actual };
}

function rehearseRestore(file, { workingPath } = {}) {
  const check = verifyBackup(file);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'edutrace-restore-'));
  const restored = path.join(target, 'demo-db.json');
  if (workingPath && path.resolve(restored) === path.resolve(workingPath)) throw new Error('A rehearsal never restores over the working database.');
  fs.copyFileSync(file, restored, fs.constants.COPYFILE_EXCL);
  const problems = [];
  let db;
  try { db = JSON.parse(fs.readFileSync(restored, 'utf8')); } catch { return { ok: false, restored_to: restored, integrity: check, problems: ['The backup is not valid JSON.'] }; }
  REQUIRED.filter(k => !Array.isArray(db[k])).forEach(k => problems.push(`Collection ${k} is missing.`));
  const findings = new Set((db.findings || []).map(f => f.id));
  const records = new Set((db.sourceRecords || []).map(r => r.id));
  (db.auditEvents || []).filter(e => e.finding_id && !findings.has(e.finding_id)).forEach(e => problems.push(`Audit event ${e.id} refers to a missing finding.`));
  (db.findings || []).forEach(f => f.evidence.filter(id => !records.has(id)).forEach(id => problems.push(`Finding ${f.id} cites missing record ${id}.`)));
  const receipts = (db.decisionReceipts || []).map(r => ({ receipt_id: r.receipt_id, status: verifyReceipt(db, r).status }));
  receipts.filter(r => r.status !== 'verified').forEach(r => problems.push(`Receipt ${r.receipt_id} is ${r.status}.`));
  if (!check.ok) problems.push(`Backup integrity: ${check.reason}.`);
  return {
    ok: problems.length === 0, restored_to: restored, integrity: check, problems,
    counts: Object.fromEntries(['sourceRecords', 'findings', 'auditEvents', 'identityLinks', 'notifications', 'decisionReceipts'].map(k => [k, Array.isArray(db[k]) ? db[k].length : 0])),
    receipts
  };
}

module.exports = { sha256File, createBackup, verifyBackup, rehearseRestore };
