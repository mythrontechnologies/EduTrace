// The read-only demo's dataset: synthetic, built in memory at startup, never read from or written
// to a file.
//
// It starts from the same synthetic seed as development (buildDemo) and then runs a few reviewer
// steps through the real pipeline, so the walkthrough has lineage, corrections, decisions and audit
// history to show: a later NITM file that re-sends one row unchanged and supplies two missing or
// malformed identifiers, a confirmed correction (one stays pending), and two match decisions.
//
// The pipeline stamps new findings and links with crypto.randomUUID() and new Date(). Rather than
// thread a clock and an id source through every module, the build runs inside deterministic(),
// which swaps both for fixed, seeded versions for the duration of one synchronous call and then
// restores them. The same code therefore yields byte-identical data on every start.
const crypto = require('node:crypto');
const { buildDemo } = require('./seed');
const { commitImport, processAll } = require('./pipeline');
const { decideCorrection } = require('./lineage');
const { decideMatch, REVIEWABLE } = require('./matches');
const { recordConsent } = require('./apaar');

const DEMO_SEED = 'edutrace-demo-v1';
const DEMO_STORES = new WeakSet();
const REVIEWER = Object.freeze({ role: 'regulator', institution_code: null, name: 'Demo Regulator Reviewer' });
// Synthetic consent states, so the demo shows granted, withdrawn and not-recorded students.
const CONSENT = [['SRC-3', 'granted', '2026-10-21T09:00:00.000Z'], ['SRC-4', 'granted', '2026-10-21T09:05:00.000Z'], ['SRC-6', 'granted', '2026-10-21T09:10:00.000Z'], ['SRC-121', 'granted', '2026-10-21T09:15:00.000Z'], ['SRC-201', 'granted', '2026-10-21T09:20:00.000Z'], ['SRC-201', 'withdrawn', '2026-10-24T16:00:00.000Z']];
const STEPS = Object.freeze({ seed: '2026-10-20T09:00:00.000Z', resubmission: '2026-10-22T10:30:00.000Z', correction: '2026-10-23T11:15:00.000Z', needsEvidence: '2026-10-24T14:05:00.000Z', differentPerson: '2026-10-24T15:40:00.000Z' });
const HEADERS = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'admission_year', 'enrolment_status'];
// Rows re-sent by NITM. Values mirror seed rows 1, 2 and 10 of BTECH CSE (see buildDemo).
const RESUBMISSION = [
  { apaar_id: '700000000901', student_name: 'Student NITM 1', date_of_birth: '02/02/2001' },
  { apaar_id: '700000000902', student_name: 'Student NITM 2', date_of_birth: '03/03/2002' },
  { apaar_id: '700000000010', student_name: 'Student NITM 10', date_of_birth: '02/03/2004' }
].map(row => ({ ...row, institution_code: 'NITM', programme: 'BTECH CSE', academic_session: '2026-27', admission_year: '2026', enrolment_status: 'Active' }));

class ReadOnlyError extends Error { constructor() { super('Demo mode is read-only.'); this.name = 'ReadOnlyError'; this.status = 403; } }

function seededUuid(n) {
  const h = crypto.createHash('sha256').update(`${DEMO_SEED}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function deterministic(build) {
  const RealDate = Date; const realUuid = crypto.randomUUID;
  let now = RealDate.parse(STEPS.seed); let counter = 0;
  class FixedDate extends RealDate { constructor(...args) { if (args.length) super(...args); else super(now); } static now() { return now; } }
  globalThis.Date = FixedDate; crypto.randomUUID = () => seededUuid(++counter);
  try { return build({ at: iso => { now = RealDate.parse(iso); return iso; } }); } finally { globalThis.Date = RealDate; crypto.randomUUID = realUuid; }
}

function buildDemoDataset() {
  return deterministic(({ at }) => {
    const db = buildDemo();
    const parsed = { headers: HEADERS, rows: RESUBMISSION, row_numbers: RESUBMISSION.map((_, i) => i + 2) };
    commitImport(db, { parsed, mapping: Object.fromEntries(HEADERS.map(h => [h, h])), batchInstitution: 'NITM', multiInstitution: false, filename: 'nitm-resubmission.csv', at: at(STEPS.resubmission) });
    const candidates = (db.correctionCandidates || []).filter(c => c.status === 'pending');
    if (candidates.length) {
      at(STEPS.correction);
      decideCorrection(db, REVIEWER, candidates[0].id, { decision: 'confirm', confirm: true, note: 'NITM confirmed by email that the re-sent row supplies the missing APAAR ID for the same student.' });
      processAll(db, { at: STEPS.correction, reason: 'after a confirmed correction', origin: 'correction' });
    }
    const reviewable = (db.identityLinks || []).filter(l => REVIEWABLE.has(l.outcome) && !l.withdrawn);
    if (reviewable[0]) { at(STEPS.needsEvidence); decideMatch(db, REVIEWER, reviewable[0].id, { decision: 'needs_more_evidence', note: 'Requested admission documents from both institutions before deciding.' }); }
    if (reviewable[1]) { at(STEPS.differentPerson); decideMatch(db, REVIEWER, reviewable[1].id, { decision: 'different_person', note: 'Source documents show two different students; dates of birth were entered correctly.' }); }
    CONSENT.forEach(([id, status, when]) => recordConsent(db, REVIEWER, db.sourceRecords.find(r => r.id === id), { status, reference: status === 'granted' ? 'Synthetic signed consent form' : 'Synthetic withdrawal letter' }, when));
    return db;
  });
}

// The demo store hands every request its own parsed copy of one immutable JSON snapshot, so even a
// read path that mutated its input could not change what the next request sees. save() and reset()
// always throw: the request guard in server.js rejects writes first, and this is the second line.
function createDemoStore(dataset = buildDemoDataset(), { onLoad } = {}) {
  const snapshot = JSON.stringify(dataset);
  const fingerprint = crypto.createHash('sha256').update(snapshot).digest('hex');
  const store = Object.freeze({
    kind: 'memory', readOnly: true, fingerprint,
    load: (...args) => { onLoad?.(...args); return JSON.parse(snapshot); },
    save() { throw new ReadOnlyError(); },
    reset() { throw new ReadOnlyError(); },
    verify: () => crypto.createHash('sha256').update(snapshot).digest('hex') === fingerprint
  });
  DEMO_STORES.add(store);
  return store;
}

function isDemoStore(store) { return Boolean(store && DEMO_STORES.has(store)); }

module.exports = { DEMO_SEED, STEPS, ReadOnlyError, deterministic, buildDemoDataset, createDemoStore, isDemoStore };
