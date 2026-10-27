// Create a new, empty JSON database generation without deleting the source generation.
// The source database remains the immutable archive for its student and decision history.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { COLLECTIONS, toRelational, validateRelational } = require('./relational');
const { AUTOMATION_VERSION } = require('./automation');

const CONFIRMATION = 'INITIALIZE_EMPTY_IMPORT';

class InitializationError extends Error {
  constructor(status, message, code) { super(message); this.name = 'InitializationError'; this.status = status; this.code = code; }
}

function createEmptyImportDataset({ sourcePath, actor, at = new Date().toISOString(), id = crypto.randomUUID(), fsImpl = fs } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath) throw new InitializationError(400, 'A JSON source database is required.', 'source_required');
  if (typeof actor !== 'string' || !actor.trim()) throw new InitializationError(400, 'An authenticated administrator is required.', 'actor_required');
  if (!Number.isFinite(Date.parse(at))) throw new InitializationError(400, 'The initialization time must be valid.', 'invalid_time');

  let bytes;
  let source;
  try {
    bytes = fsImpl.readFileSync(sourcePath);
    source = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InitializationError(409, 'The source database is unavailable or invalid; no dataset was created.', 'source_invalid');
  }
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
  const allowedKeys = new Set(['version', 'automation_version', ...COLLECTIONS]);
  const unknown = source && typeof source === 'object' && !Array.isArray(source) ? Object.keys(source).filter(key => !allowedKeys.has(key)) : ['invalid'];
  if (!source || typeof source !== 'object' || Array.isArray(source) || unknown.length ||
      !Array.isArray(source.institutions) || !source.institutions.length ||
      !Array.isArray(source.capacityRules) ||
      source.institutions.some(x => !x || typeof x.code !== 'string' || typeof x.name !== 'string') ||
      source.capacityRules.some(x => !x || !source.institutions.some(i => i.code === x.institution_code))) {
    throw new InitializationError(409, 'The source database does not match the supported schema or reference-data invariants; no dataset was created.', 'source_schema_unsupported');
  }

  const targetPath = path.join(path.dirname(path.resolve(sourcePath)), `empty-import-${sourceHash}.json`);
  if (fsImpl.existsSync(targetPath)) {
    throw new InitializationError(409, 'An empty-import dataset already exists for this source database; it was not overwritten.', 'already_initialized');
  }

  const dataset = {
    version: source.version ?? 1,
    automation_version: source.automation_version ?? AUTOMATION_VERSION,
    institutions: structuredClone(source.institutions),
    importBatches: [],
    sourceRecords: [],
    capacityRules: structuredClone(source.capacityRules),
    findings: [],
    auditEvents: [{
      id: `AUD-${id}`,
      action: 'empty_import_initialized',
      actor,
      at,
      system: false,
      source_database_file: path.basename(sourcePath),
      source_database_sha256: sourceHash,
      outcome: 'created_new_generation'
    }],
    identityLinks: [],
    identityLinkEvents: [],
    matchDecisions: {},
    correctionCandidates: [],
    lineageEvents: [],
    notifications: [],
    notificationRegistry: {},
    automationRuns: [],
    decisionReceipts: [],
    consentRecords: []
  };
  const validation = validateRelational(toRelational(dataset));
  if (!validation.ok) throw new InitializationError(409, 'The empty dataset failed integrity validation; no dataset was created.', 'dataset_invalid');

  const tempPath = `${targetPath}.${process.pid}.${id}.tmp`;
  const lockPath = `${targetPath}.lock`;
  let fd = null;
  let lockFd = null;
  let lockOwned = false;
  try {
    lockFd = fsImpl.openSync(lockPath, 'wx', 0o600);
    lockOwned = true;
    fsImpl.writeFileSync(lockFd, JSON.stringify({ pid: process.pid, at }), 'utf8');
    fsImpl.closeSync(lockFd);
    lockFd = null;
    if (fsImpl.existsSync(targetPath)) throw Object.assign(new Error('Target already exists.'), { code: 'EEXIST' });
    fd = fsImpl.openSync(tempPath, 'wx', 0o600);
    fsImpl.writeFileSync(fd, JSON.stringify(dataset, null, 2), 'utf8');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    // The exclusive lock prevents another initializer from racing this no-replacement rename.
    fsImpl.renameSync(tempPath, targetPath);
  } catch (error) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch {} }
    if (lockFd !== null) { try { fsImpl.closeSync(lockFd); } catch {} }
    try { if (fsImpl.existsSync(tempPath)) fsImpl.unlinkSync(tempPath); } catch {}
    if (lockOwned) { try { if (fsImpl.existsSync(lockPath)) fsImpl.unlinkSync(lockPath); } catch {} }
    if (error.code === 'EEXIST' && fsImpl.existsSync(targetPath)) {
      throw new InitializationError(409, 'An empty-import dataset already exists for this source database; it was not overwritten.', 'already_initialized');
    }
    if (error.code === 'EEXIST') throw new InitializationError(409, 'Another empty-import initialization is already in progress; no dataset was created.', 'initialization_in_progress');
    throw new InitializationError(500, 'The empty-import dataset could not be committed; no dataset was created.', 'write_failed');
  }
  if (lockOwned) { try { fsImpl.unlinkSync(lockPath); } catch {} }

  return {
    path: targetPath,
    source_sha256: sourceHash,
    counts: {
      source_records: dataset.sourceRecords.length,
      import_batches: dataset.importBatches.length,
      institutions: dataset.institutions.length,
      capacity_rules: dataset.capacityRules.length,
      findings: dataset.findings.length,
      identity_links: dataset.identityLinks.length,
      notifications: dataset.notifications.length
    },
    dataset
  };
}

module.exports = { CONFIRMATION, InitializationError, createEmptyImportDataset };
