// Evaluation of autonomous reconciliation on labelled synthetic cases.
//
// Every row below is synthetic and carries its ground truth (which person it belongs to and
// which issues it was built to contain). The rows are imported through the same pipeline the
// server uses, then the persisted results are compared with the labels. The numbers describe
// how the current rules and policy behave on these designed cases; they are not an estimate
// of accuracy on real institutional data.
const { commitImport, revalidate } = require('./pipeline');
const { isCurrent } = require('./engine');

const INSTITUTIONS = [{ code: 'NITM', name: 'Northbridge Institute of Technology' }, { code: 'RCA', name: 'Riverview College of Arts' }, { code: 'SVU', name: 'Suryavardhan Valley University' }];
const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Ishaan', 'Saanvi', 'Vihaan', 'Tara', 'Arjun', 'Nila', 'Dev', 'Kavya', 'Reyansh', 'Zoya', 'Neel', 'Ira', 'Aditya', 'Myra'];
const LAST = ['Varma', 'Kulkarni', 'Iyer', 'Bose', 'Chandra', 'Desai', 'Fernandes', 'Ghosh', 'Hegde', 'Jain', 'Kapoor', 'Menon', 'Nath', 'Pillai', 'Rao', 'Sethi', 'Thakur', 'Vyas'];

function rng(seed) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }

function buildCases(seed = 26263) {
  const random = rng(seed);
  const used = new Set();
  let personSeq = 0; let idSeq = 0;
  const person = () => {
    let name;
    do { name = `${FIRST[Math.floor(random() * FIRST.length)]} ${LAST[Math.floor(random() * LAST.length)]} ${String.fromCharCode(65 + Math.floor(random() * 26))}`; } while (used.has(name));
    used.add(name);
    const day = 1 + Math.floor(random() * 28); const month = 1 + Math.floor(random() * 12); const year = 2003 + Math.floor(random() * 4);
    return { person: `P${String(++personSeq).padStart(3, '0')}`, name, dob: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
  };
  const newId = () => String(930000000000 + ++idSeq);
  const ddmmyyyy = iso => iso.split('-').reverse().join('/');
  const rows = [];
  const row = (batch, institution, p, values = {}, labels = []) => rows.push({ batch, institution, person: p.person, labels, apaar_id: p.id ?? '', student_name: p.name, date_of_birth: p.dob, programme: 'BTECH CSE', academic_session: '2026-27', enrolment_status: 'Active', ...values });

  // A. Clean, unique students (with routine formatting variation) — expected automatic processing.
  const clean = [];
  INSTITUTIONS.forEach(inst => { for (let i = 0; i < 30; i++) { const p = { ...person(), id: newId() }; clean.push({ p, inst: inst.code }); row(1, inst.code, p, { apaar_id: i % 3 === 0 ? p.id.replace(/(\d{4})(\d{4})(\d{4})/, '$1 $2 $3') : p.id, student_name: i % 5 === 0 ? `  ${p.name}  ` : p.name, date_of_birth: i % 2 ? ddmmyyyy(p.dob) : p.dob, enrolment_status: i % 4 === 0 ? 'Enrolled' : 'Active' }, ['clean']); } });
  // B. Exact resubmissions in a later file — expected safe automatic match.
  clean.slice(0, 8).forEach(({ p, inst }) => row(2, inst, p, {}, ['resubmission']));
  // C. Transfer history: transferred last session at one institution, active now at another.
  for (let i = 0; i < 4; i++) { const p = { ...person(), id: newId() }; row(1, 'RCA', p, { enrolment_status: 'Transferred', academic_session: '2025-26' }, ['transfer']); row(2, 'SVU', p, {}, ['transfer']); }
  // D. Same student active at two institutions in the same session.
  for (let i = 0; i < 4; i++) { const p = { ...person(), id: newId() }; row(1, 'NITM', p, { case: `D${i}` }, ['concurrent']); row(2, 'RCA', p, { case: `D${i}` }, ['concurrent']); }
  // E. Same student, same identifier, date of birth mistyped in one file.
  for (let i = 0; i < 4; i++) { const p = { ...person(), id: newId() }; row(1, 'SVU', p, { case: `E${i}` }, ['dob_typo']); row(2, 'SVU', p, { case: `E${i}`, date_of_birth: p.dob.replace(/-(\d{2})$/, (_, d) => `-${String((Number(d) % 28) + 1).padStart(2, '0')}`) }, ['dob_typo']); }
  // F. Two different students submitted with the same identifier (entry error).
  for (let i = 0; i < 3; i++) { const a = { ...person(), id: newId() }; const b = { ...person(), id: a.id }; row(1, 'NITM', a, { case: `F${i}` }, ['id_collision']); row(2, 'RCA', b, { case: `F${i}` }, ['id_collision']); }
  // G. Same student at two institutions without identifiers — expected candidate for review.
  for (let i = 0; i < 4; i++) { const p = person(); row(1, 'NITM', p, { case: `G${i}`, apaar_id: '' }, ['candidate_true', 'missing_id']); row(2, 'SVU', p, { case: `G${i}`, apaar_id: i % 2 ? newId() : '' }, i % 2 ? ['candidate_true'] : ['candidate_true', 'missing_id']); }
  // H. Same student, abbreviated first name, no identifiers — a known gap for token similarity.
  for (let i = 0; i < 3; i++) { const p = person(); const parts = p.name.split(' '); row(1, 'RCA', { ...p, name: `Mohammed ${parts[1]} ${parts[2]}` }, { case: `H${i}`, apaar_id: '' }, ['name_variant', 'missing_id']); row(2, 'NITM', { ...p, name: `Mohd ${parts[1]} ${parts[2]}` }, { case: `H${i}`, apaar_id: '' }, ['name_variant', 'missing_id']); }
  // I. Different students who share a name and date of birth, no identifiers.
  for (let i = 0; i < 3; i++) { const a = person(); const b = { ...person(), name: a.name, dob: a.dob }; row(1, 'SVU', a, { case: `I${i}`, apaar_id: '' }, ['namesake', 'missing_id']); row(2, 'RCA', b, { case: `I${i}`, apaar_id: '' }, ['namesake', 'missing_id']); }
  // J. Same name, different dates of birth, no identifiers — different students.
  for (let i = 0; i < 3; i++) { const a = person(); const b = { ...person(), name: a.name }; row(1, 'NITM', a, { case: `J${i}`, apaar_id: '' }, ['same_name_different_dob', 'missing_id']); row(2, 'SVU', b, { case: `J${i}`, apaar_id: '' }, ['same_name_different_dob', 'missing_id']); }
  // K. Malformed identifiers.
  for (let i = 0; i < 6; i++) { const p = { ...person(), id: ['93000000001', '9300-0000-000X', 'ABC123', '9300000000123', '93 00 00', 'N/A'][i] }; row(1, INSTITUTIONS[i % 3].code, p, {}, ['malformed_id']); }
  // L. Rows missing required values — expected to fail processing with a correction request.
  for (let i = 0; i < 4; i++) { const p = { ...person(), id: newId() }; row(1, INSTITUTIONS[i % 3].code, p, [{ programme: '' }, { enrolment_status: '' }, { student_name: '' }, { academic_session: '' }][i], ['required_missing']); }
  // M. Twins: same surname and date of birth, same institution, different first names and identifiers.
  for (let i = 0; i < 2; i++) { const a = { ...person(), id: newId() }; const b = { ...person(), id: newId(), dob: a.dob, name: `${FIRST[(i + 7) % FIRST.length]} ${a.name.split(' ').slice(1).join(' ')}` }; row(1, 'NITM', a, {}, ['twin']); row(1, 'NITM', b, {}, ['twin']); }
  return rows;
}

const HEADERS = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
function toParsed(rows) { return { headers: HEADERS, rows: rows.map(r => ({ ...Object.fromEntries(HEADERS.map(h => [h, r[h]])), institution_code: r.institution })), row_numbers: rows.map((_, i) => i + 2) }; }
const pairKey = (a, b) => [a, b].sort().join('|');
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);

// Imports the labelled cases through the real pipeline into an in-memory database.
function buildEvaluationState({ seed = 26263 } = {}) {
  const cases = buildCases(seed);
  const db = { version: 1, institutions: INSTITUTIONS, importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] };
  const mapping = Object.fromEntries(HEADERS.map(h => [h, h]));
  const truthByRecord = new Map();
  const imports = [];
  let clock = Date.parse('2026-10-21T09:00:00.000Z');
  for (const batchNo of [1, 2]) for (const inst of INSTITUTIONS) {
    const rows = cases.filter(r => r.batch === batchNo && r.institution === inst.code);
    if (!rows.length) continue;
    const batch = commitImport(db, { parsed: toParsed(rows), mapping, batchInstitution: inst.code, multiInstitution: false, filename: `eval-${inst.code.toLowerCase()}-${batchNo}.csv`, at: new Date(clock += 60000).toISOString() });
    imports.push({ batch, rows });
    db.sourceRecords.filter(r => r.import_id === batch.id).forEach(r => truthByRecord.set(r.id, rows[r.source_row - 2]));
  }
  return { cases, db, mapping, truthByRecord, imports, clock };
}

function runEvaluation({ seed = 26263 } = {}) {
  const state = buildEvaluationState({ seed });
  const { cases, db, mapping, truthByRecord, imports } = state;
  let { clock } = state;

  // ── Row processing ──
  const records = db.sourceRecords;
  const automaticSet = new Set(['automatically_processed', 'automatically_normalised', 'safely_matched']);
  const status = Object.fromEntries(['automatically_processed', 'automatically_normalised', 'safely_matched', 'needs_institution_correction', 'needs_investigation', 'verification_pending'].map(s => [s, records.filter(r => r.processing.status === s).length]));
  const rejected = imports.reduce((n, i) => n + i.batch.rejected, 0);
  const expectedAutomatic = records.filter(r => ['clean', 'resubmission', 'transfer', 'twin'].some(l => truthByRecord.get(r.id).labels.includes(l)));
  const automatic = records.filter(r => automaticSet.has(r.processing.status));

  // ── Identity resolution (pairs of persisted records) ──
  const truthPairs = new Set();
  const byPerson = new Map();
  records.forEach(r => { const p = truthByRecord.get(r.id).person; byPerson.set(p, [...(byPerson.get(p) || []), r.id]); });
  byPerson.forEach(ids => { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) truthPairs.add(pairKey(ids[i], ids[j])); });
  // Automatic links are transitive within an identifier group: compare connected components.
  const parent = new Map(records.map(r => [r.id, r.id]));
  const find = x => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  // An unchanged re-import of the same source record (same_source_record) is resolved without review like a policy link.
  db.identityLinks.filter(l => l.outcome === 'auto_linked' || l.outcome === 'same_source_record').forEach(l => parent.set(find(l.records[0]), find(l.records[1])));
  const components = new Map();
  records.forEach(r => components.set(find(r.id), [...(components.get(find(r.id)) || []), r.id]));
  const autoPairs = new Set();
  components.forEach(ids => { for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) autoPairs.add(pairKey(ids[i], ids[j])); });
  const autoTrue = [...autoPairs].filter(k => truthPairs.has(k)).length;
  const flagged = new Map();
  db.identityLinks.filter(l => l.outcome === 'needs_investigation' || l.outcome === 'candidate_for_review').forEach(l => flagged.set(pairKey(...l.records), l.outcome));
  const flaggedTrue = [...flagged.keys()].filter(k => truthPairs.has(k)).length;
  const evaluatedPairs = new Set(db.identityLinks.map(l => pairKey(...l.records)));
  const evaluatedNegatives = [...evaluatedPairs].filter(k => !truthPairs.has(k)).length;
  const covered = [...truthPairs].filter(k => autoPairs.has(k) || flagged.has(k)).length;

  // ── Detection of labelled issues ──
  const current = db.findings.filter(isCurrent);
  const hasFinding = (recordId, rules) => current.some(f => rules.includes(f.rule_code) && f.evidence.includes(recordId));
  const labelled = label => records.filter(r => truthByRecord.get(r.id).labels.includes(label));
  const detect = (label, rules) => { const rs = labelled(label); return { labelled: rs.length, detected: rs.filter(r => hasFinding(r.id, rules)).length }; };
  const missing = detect('missing_id', ['APAAR_MISSING']);
  const malformed = detect('malformed_id', ['APAAR_MALFORMED']);
  const falseValidation = current.filter(f => ['APAAR_MISSING', 'APAAR_MALFORMED'].includes(f.rule_code) && !f.evidence.some(rid => ['missing_id', 'malformed_id'].some(l => truthByRecord.get(rid).labels.includes(l)))).length;
  const requiredLabelled = cases.filter(r => r.labels.includes('required_missing')).length;
  // A case counts as detected when one current finding of the expected rule covers both of its records.
  const pairsDetected = (label, rules) => {
    const byCase = new Map();
    labelled(label).forEach(r => { const c = truthByRecord.get(r.id).case; byCase.set(c, [...(byCase.get(c) || []), r.id]); });
    const detected = [...byCase.values()].filter(ids => current.some(f => rules.includes(f.rule_code) && ids.every(rid => f.evidence.includes(rid)))).length;
    return { labelled_cases: byCase.size, detected_cases: detected };
  };
  const exceptions = {
    concurrent_enrolment: pairsDetected('concurrent', ['POTENTIAL_CONCURRENT_ENROLMENT']),
    date_of_birth_conflict: pairsDetected('dob_typo', ['IDENTIFIER_ATTRIBUTE_CONFLICT']),
    identifier_collision: pairsDetected('id_collision', ['IDENTIFIER_ATTRIBUTE_CONFLICT']),
    candidate_same_student: pairsDetected('candidate_true', ['CANDIDATE_IDENTITY_MATCH']),
    abbreviated_name_same_student: pairsDetected('name_variant', ['CANDIDATE_IDENTITY_MATCH']),
    namesakes_flagged_for_review: pairsDetected('namesake', ['CANDIDATE_IDENTITY_MATCH']),
    same_name_different_dob_flagged: pairsDetected('same_name_different_dob', ['CANDIDATE_IDENTITY_MATCH'])
  };
  const collisionAutoLinked = labelled('id_collision').filter(r => db.identityLinks.some(l => l.outcome === 'auto_linked' && l.records.includes(r.id))).length;

  // ── Repeated processing ──
  const conditionCounts = () => { const counts = new Map(); db.findings.filter(isCurrent).forEach(f => counts.set(f.condition_key, (counts.get(f.condition_key) || 0) + 1)); return [...counts.values()].filter(n => n > 1).length; };
  const revalidations = [revalidate(db, { at: new Date(clock += 60000).toISOString() }), revalidate(db, { at: new Date(clock += 60000).toISOString() })];
  const openBefore = db.findings.filter(f => isCurrent(f) && f.review_status !== 'resolved').length;
  const reimportRows = cases.filter(r => r.batch === 1 && r.institution === 'NITM');
  const reimport = commitImport(db, { parsed: toParsed(reimportRows), mapping, batchInstitution: 'NITM', multiInstitution: false, filename: 'eval-nitm-1-resubmitted.csv', at: new Date(clock += 60000).toISOString() });
  const openAfter = db.findings.filter(f => isCurrent(f) && f.review_status !== 'resolved');
  const repeated = {
    duplicate_current_findings_per_condition_after_revalidation: conditionCounts(),
    revalidation_runs: revalidations,
    reimport_of_identical_file: {
      rows: reimport.imported, findings_created: reimport.findings_created, findings_superseded: reimport.findings_superseded,
      automatically_resolved: reimport.automation.automatically_resolved_findings, exception_items_notified: reimport.automation.notified, repeat_notifications_suppressed: reimport.automation.suppressed_repeats,
      open_findings_before: openBefore, open_findings_after: openAfter.length,
      new_open_investigations: openAfter.filter(f => f.automation.queue === 'investigation' && f.created_at === reimport.created_at).length,
      new_open_corrections: openAfter.filter(f => f.automation.queue === 'correction' && f.created_at === reimport.created_at).length,
      duplicate_current_findings_per_condition: conditionCounts()
    }
  };

  return {
    dataset: { seed, rows: cases.length, persisted_records: records.length, rejected_rows: rejected, people: byPerson.size, note: 'Synthetic labelled cases built for this evaluation. Results describe rule and policy behaviour on these cases, not accuracy on real data.' },
    processing: {
      by_status: status, processing_failed: rejected,
      automatic_processing_rate: ratio(automatic.length, records.length),
      automatic_processing_rate_definition: 'Persisted records with no open finding (automatically processed, normalised or safely matched) divided by persisted records.',
      expected_automatic_records: expectedAutomatic.length,
      expected_automatic_processed_automatically: expectedAutomatic.filter(r => automaticSet.has(r.processing.status)).length,
      unexpectedly_automatic: automatic.filter(r => !expectedAutomatic.includes(r)).length
    },
    identity: {
      true_same_student_pairs: truthPairs.size,
      automatic_links: { pairs: autoPairs.size, correct: autoTrue, precision: ratio(autoTrue, autoPairs.size), recall: ratio(autoTrue, truthPairs.size), false_links: autoPairs.size - autoTrue },
      review_flags: { pairs: flagged.size, same_student: flaggedTrue, different_students: flagged.size - flaggedTrue },
      coverage_any_outcome: { pairs_linked_or_flagged: covered, recall: ratio(covered, truthPairs.size) },
      false_positive_rate_automatic: { false_links: autoPairs.size - autoTrue, evaluated_non_matching_pairs: evaluatedNegatives, rate: ratio(autoPairs.size - autoTrue, evaluatedNegatives) },
      identifier_collisions_auto_linked: collisionAutoLinked
    },
    detection: {
      missing_identifier: { ...missing, recall: ratio(missing.detected, missing.labelled) },
      malformed_identifier: { ...malformed, recall: ratio(malformed.detected, malformed.labelled) },
      validation_findings_on_unlabelled_records: falseValidation,
      missing_required_values: { labelled_rows: requiredLabelled, rejected_with_reason: rejected, recall: ratio(Math.min(rejected, requiredLabelled), requiredLabelled) },
      exceptions
    },
    repeated_processing: repeated
  };
}

module.exports = { buildCases, buildEvaluationState, runEvaluation };
