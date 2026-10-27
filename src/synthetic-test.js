// Ephemeral localhost-only CSV test data. This module deliberately has no filesystem,
// account-store, database, provider, or integration dependencies.
const crypto = require('node:crypto');
const { normaliseRecord } = require('./engine');
const { processAll } = require('./pipeline');
const { principalOf } = require('./auth');

const TEST_INSTITUTIONS = Object.freeze([
  Object.freeze({ code: 'TSTA', name: 'Synthetic Institution A' }),
  Object.freeze({ code: 'TSTB', name: 'Synthetic Institution B' })
]);
const byCode = new Map(TEST_INSTITUTIONS.map(item => [item.code, item]));
const clone = value => structuredClone(value);

function syntheticTestAuthenticator() {
  return Object.freeze({
    kind: 'synthetic_test',
    authenticate(req) {
      const code = String(req.headers['x-edutrace-test-institution'] || '').toUpperCase();
      const institution = byCode.get(code);
      if (!institution) return null;
      return principalOf({
        name: `Synthetic Test User ${code}`,
        subject: `synthetic-test:${code}`,
        scope: 'institution',
        institutionCode: code,
        roles: ['institution_admin'],
        method: 'synthetic_test'
      });
    }
  });
}

function emptyPartition(institution) {
  const code = institution.code;
  const at = '2026-01-01T00:00:00.000Z';
  const sourceFile = `synthetic-${code.toLowerCase()}-baseline.csv`;
  const importId = `SYNTH-${code}-BASELINE`;
  const records = [
    { identifier: '999999990101', status: 'Active' },
    { identifier: '999999990102', status: 'Active' },
    // Keep one deliberate malformed synthetic ID so the baseline demonstrates validation findings.
    { identifier: `SYNTH-ID-${code}-BASE-003`, status: 'Active' }
  ].map((item, index) => ({
    id: `SYNTH-${code}-BASE-${String(index + 1).padStart(3, '0')}`,
    source_file: sourceFile, source_row: index + 2, import_id: importId, imported_at: at,
    ...normaliseRecord({
      apaar_id: item.identifier, student_name: `Synthetic Baseline ${code}-${String(index + 1).padStart(3, '0')}`,
      date_of_birth: `0${index + 1}/01/2005`, institution_code: code, institution_name: institution.name,
      programme: 'SYNTHETIC PROGRAMME', academic_session: 'SYNTHETIC-2026',
      admission_year: '2026', enrolment_status: item.status, source_reference: `SYNTH-REF-${code}-${String(index + 1).padStart(3, '0')}`
    })
  }));
  const db = {
    version: 1, automation_version: 1,
    institutions: [clone(institution)],
    importBatches: [{ id: importId, institution_code: code, source_file: sourceFile, rows_detected: records.length, imported: records.length, rejected: 0, skipped: 0, row_outcomes: [], created_at: at, seeded: true }],
    sourceRecords: records, capacityRules: [], findings: [], auditEvents: [],
    identityLinks: [], identityLinkEvents: [], matchDecisions: {}, correctionCandidates: [],
    lineageEvents: [], notifications: [], notificationRegistry: {}, automationRuns: [],
    decisionReceipts: [], consentRecords: []
  };
  processAll(db, { at, reason: 'generated synthetic test baseline', origin: 'seed' });
  return db;
}

function createSyntheticTestStore({ beforeCommit } = {}) {
  const partitions = new Map();
  function codeFor(principal) {
    const code = principal?.institution_code;
    if (!byCode.has(code) || principal?.method !== 'synthetic_test') throw new Error('Synthetic test institution scope is required.');
    return code;
  }
  function partition(code) {
    if (!partitions.has(code)) partitions.set(code, { data: emptyPartition(byCode.get(code)), imports: new Map() });
    return partitions.get(code);
  }
  return Object.freeze({
    kind: 'synthetic_test_memory', readOnly: false,
    get fingerprint() { return crypto.createHash('sha256').update(TEST_INSTITUTIONS.map(x => x.code).join('|')).digest('hex'); },
    load({ principal } = {}) { return clone(partition(codeFor(principal)).data); },
    lookupImport({ key, fingerprint, principal }) {
      const code = codeFor(principal);
      const existing = partition(code).imports.get(key);
      if (!existing) return null;
      if (existing.institution_code !== code || existing.fingerprint !== fingerprint) return { conflict: true };
      return { conflict: false, status: existing.status, result: clone(existing.result) };
    },
    save(db, { principal, idempotencyEntry } = {}) {
      const code = codeFor(principal);
      if (!Array.isArray(db.institutions) || db.institutions.length !== 1 || db.institutions[0].code !== code ||
          db.sourceRecords.some(row => row.institution_code !== code) ||
          db.importBatches.some(batch => batch.institution_code !== code)) throw new Error('Synthetic partition integrity check failed.');
      const current = partition(code);
      if (idempotencyEntry && (idempotencyEntry.institution_code !== code || current.imports.has(idempotencyEntry.key))) throw new Error('Synthetic idempotency key already exists or has an invalid institution scope.');
      if (beforeCommit) beforeCommit(clone(db), idempotencyEntry && clone(idempotencyEntry));
      const next = clone(db);
      const nextImports = new Map(current.imports);
      if (idempotencyEntry) nextImports.set(idempotencyEntry.key, clone(idempotencyEntry));
      // Dataset and confirmation receipts become visible through one atomic partition replacement.
      partitions.set(code, { data: next, imports: nextImports });
    }
  });
}

function validateSyntheticCsv(parsed, mapping, institutionCode) {
  if (!byCode.has(institutionCode)) throw new Error('CSV test institution is not supported.');
  if (parsed.rows.some(row => Object.values(row).some(value => String(value).includes('\uFFFD')))) throw new Error('CSV contains invalid UTF-8 replacement characters. Re-export it as UTF-8.');
  const mapped = new Set(Object.values(mapping));
  const unmapped = parsed.headers.filter(header => !mapped.has(header) && parsed.rows.some(row => String(row[header] || '').trim()));
  if (unmapped.length) throw new Error(`CSV contains non-empty unmapped columns (${unmapped.slice(0, 5).join(', ')}). Map or remove them before using the synthetic test mode.`);
  const nameHeader = mapping.student_name;
  const institutionHeader = mapping.institution_code;
  const idHeader = mapping.apaar_id;
  const referenceHeader = mapping.source_reference;
  const institutionNameHeader = mapping.institution_name;
  const programmeHeader = mapping.programme;
  const sessionHeader = mapping.academic_session;
  for (const [index, row] of parsed.rows.entries()) {
    const name = String(row[nameHeader] || '').trim();
    const rowInstitution = String(row[institutionHeader] || '').trim().toUpperCase();
    const identifier = idHeader ? String(row[idHeader] || '').trim() : '';
    const reference = referenceHeader ? String(row[referenceHeader] || '').trim() : '';
    const institutionName = institutionNameHeader ? String(row[institutionNameHeader] || '').trim() : '';
    const programme = String(row[programmeHeader] || '').trim();
    const session = String(row[sessionHeader] || '').trim();
    if (!/^Synthetic (?:Student|Baseline) [A-Z0-9-]{1,48}$/.test(name)) throw new Error(`CSV row ${parsed.row_numbers[index]} must use a generated synthetic name such as “Synthetic Student TEST-001”.`);
    if (rowInstitution !== institutionCode) throw new Error(`CSV row ${parsed.row_numbers[index]} must use the selected synthetic institution code ${institutionCode}.`);
    if (identifier && !(/^SYNTH-ID-[A-Z0-9-]{1,48}$/i.test(identifier) || /^99999999\d{4}$/.test(identifier))) throw new Error(`CSV row ${parsed.row_numbers[index]} must use a SYNTH-ID marker or a 12-digit synthetic test identifier in the 99999999xxxx range.`);
    if (reference && !/^SYNTH-REF-[A-Z0-9-]{1,48}$/i.test(reference)) throw new Error(`CSV row ${parsed.row_numbers[index]} must use a synthetic source reference beginning “SYNTH-REF-”.`);
    if (institutionName && institutionName !== byCode.get(institutionCode).name) throw new Error(`CSV row ${parsed.row_numbers[index]} must use the fixed synthetic institution name.`);
    if (!/^SYNTHETIC(?:\s|$)/.test(programme) || !/^SYNTHETIC-\d{4}$/.test(session)) throw new Error(`CSV row ${parsed.row_numbers[index]} must use synthetic programme and session markers.`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function importFingerprint(value) { return crypto.createHash('sha256').update(stableJson(value)).digest('hex'); }

module.exports = { TEST_INSTITUTIONS, syntheticTestAuthenticator, createSyntheticTestStore, validateSyntheticCsv, importFingerprint };
