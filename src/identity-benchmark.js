// Labelled identity-resolution benchmark (synthetic data only).
//
// Two parts:
//   1. Pair scenarios. Small groups of synthetic records, each pair labelled with the ground truth
//      by construction (same student, different students, or unknowable from the data) and the
//      outcome a conservative policy should produce (automatic link, review, or no proposal).
//      Every scenario is generated in several variants with different synthetic people, and all
//      variants are matched together in one dataset, so blocking and cross-talk are exercised.
//      The frozen previous matcher (src/identity-baseline.js) and the current one run on the same
//      records.
//   2. Pipeline scenarios. Imports, reviewer decisions and re-imports run through the same code
//      the server uses, to check idempotence, decision persistence and withdrawal.
// The figures describe these designed cases only. They are not an estimate of accuracy on real
// institutional data, and a benchmark of this size cannot establish production reliability.
const { normaliseRecord, reconcile, isCurrent } = require('./engine');
const current = require('./identity');
const baseline = require('./identity-baseline');
const { similarity } = require('./names');
const { commitImport } = require('./pipeline');
const { listMatches, decideMatch, explainMatch } = require('./matches');

const FIRST = ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Ishaan', 'Saanvi', 'Vihaan', 'Tara', 'Arjun', 'Nila', 'Dev', 'Kavya', 'Reyansh', 'Zoya', 'Neel', 'Ira', 'Aditya', 'Myra', 'Imran', 'Farah', 'Kiran', 'Lakshmi'];
const LAST = ['Varma', 'Kulkarni', 'Iyer', 'Bose', 'Chandra', 'Desai', 'Fernandes', 'Ghosh', 'Hegde', 'Jain', 'Kapoor', 'Menon', 'Nath', 'Pillai', 'Rao', 'Sethi', 'Thakur', 'Vyas', 'Khan', 'Qureshi', 'Banerjee', 'Shetty'];
const ALT_FIRST = { Rohan: 'Rohit', Diya: 'Riya', Kabir: 'Kavir', Meera: 'Mira', Neel: 'Neil', Tara: 'Tanya', Dev: 'Devansh', Ira: 'Isha' };
const VARIANTS = 6;

function generator() {
  let p = 0; let d = 0; let id = 0;
  return {
    name() { const n = p++; return `${FIRST[n % FIRST.length]} ${LAST[Math.floor(n / FIRST.length) % LAST.length]}`; },
    dob() { const n = d++; const day = 1 + (n % 28); const month = 1 + (Math.floor(n / 28) % 12); const year = 1999 + Math.floor(n / 336); return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; },
    id() { return String(951000000000 + ++id); }
  };
}

// Each scenario returns records (tag → attributes) and labelled pairs (by tag).
// truth: same | different | unknown.  expected: auto | review | none.
const SCENARIOS = [
  { code: 'S01', title: 'Same identifier, matching attributes', build: g => { const n = g.name(); const dob = g.dob(); const id = g.id(); return { records: { a: { inst: 'NITM', id, name: n, dob }, b: { inst: 'RCA', id, name: n, dob } }, pairs: [['a', 'b', 'same', 'auto', 'identifier']] }; } },
  { code: 'S02', title: 'Same identifier, conflicting date of birth', build: g => { const n = g.name(); const dob = g.dob(); const id = g.id(); return { records: { a: { inst: 'SVU', id, name: n, dob }, b: { inst: 'NITM', id, name: n, dob: g.dob() } }, pairs: [['a', 'b', 'unknown', 'review', 'identifier', true]] }; } },
  { code: 'S03', title: 'Identical names, no identifiers', build: g => { const n = g.name(); const dob = g.dob(); return { records: { a: { inst: 'NITM', id: '', name: n, dob }, b: { inst: 'SVU', id: '', name: n, dob } }, pairs: [['a', 'b', 'same', 'review', 'fuzzy']] }; } },
  { code: 'S04', title: 'Similar names, different people', build: (g, v) => { const n = g.name(); const [f, l] = n.split(' '); const other = `${ALT_FIRST[f] || `${f}a`} ${l}`; const dob = g.dob(); return { records: { a: { inst: 'NITM', id: '', name: n, dob }, b: { inst: 'RCA', id: '', name: other, dob } }, pairs: [['a', 'b', 'different', 'none', 'fuzzy']] }; } },
  { code: 'S04b', title: 'Namesakes: identical names and birth dates, different people', build: g => { const n = g.name(); const dob = g.dob(); return { records: { a: { inst: 'RCA', id: '', name: n, dob }, b: { inst: 'SVU', id: '', name: n, dob } }, pairs: [['a', 'b', 'different', 'review', 'fuzzy']] }; } },
  { code: 'S05', title: 'Abbreviated names', build: (g, v) => { const n = g.name(); const [f, l] = n.split(' '); const dob = g.dob(); const pair = v % 2 ? [`Mohammed ${f} ${l}`, `Mohd ${f} ${l}`] : [`${f} ${l}`, `${f[0]}. ${l}`]; return { records: { a: { inst: 'NITM', id: '', name: pair[0], dob }, b: { inst: 'SVU', id: '', name: pair[1], dob } }, pairs: [['a', 'b', 'same', 'review', 'fuzzy']] }; } },
  { code: 'S06', title: 'Unicode, whitespace and punctuation differences', build: (g, v) => { const n = g.name(); const [f, l] = n.split(' '); const dob = g.dob(); const id = g.id(); const forms = [`  ${f.toUpperCase()}   ${l.toLowerCase()} `, `${f.replace(/[aeiou]/, c => `${c}̈`)} ${l}`, `${f}-${l}`, `Ａ${f.slice(1)} ${l}`.replace('Ａ', String.fromCharCode(0xFF21 + f.charCodeAt(0) - 65))]; return { records: { a: { inst: 'RCA', id, name: n, dob }, b: { inst: 'SVU', id, name: forms[v % forms.length], dob } }, pairs: [['a', 'b', 'same', 'auto', 'identifier']] }; } },
  { code: 'S07', title: 'Different names, same identifier', build: g => { const id = g.id(); const dob = g.dob(); return { records: { a: { inst: 'NITM', id, name: g.name(), dob }, b: { inst: 'RCA', id, name: g.name(), dob } }, pairs: [['a', 'b', 'unknown', 'review', 'identifier', true]] }; } },
  { code: 'S08', title: 'Missing date of birth', build: g => { const n = g.name(); const n2 = g.name(); const dob = g.dob(); const id = g.id(); return { records: { a: { inst: 'NITM', id, name: n, dob }, b: { inst: 'SVU', id, name: n, dob: '' }, c: { inst: 'RCA', id: '', name: n2, dob: g.dob() }, d: { inst: 'SVU', id: '', name: n2, dob: '' } }, pairs: [['a', 'b', 'same', 'review', 'identifier'], ['c', 'd', 'unknown', 'none', 'fuzzy']] }; } },
  { code: 'S09', title: 'Missing programme', build: g => { const n = g.name(); const dob = g.dob(); const id = g.id(); return { records: { a: { inst: 'NITM', id, name: n, dob }, b: { inst: 'RCA', id, name: n, dob, programme: '' } }, pairs: [['a', 'b', 'same', 'auto', 'identifier']] }; } },
  { code: 'S10', title: 'Historical enrolment at the same institution', build: g => { const n = g.name(); const dob = g.dob(); const id = g.id(); return { records: { a: { inst: 'NITM', id, name: n, dob, session: '2024-25', status: 'completed' }, b: { inst: 'NITM', id, name: n, dob } }, pairs: [['a', 'b', 'same', 'auto', 'identifier']], noConcurrent: true }; } },
  { code: 'S11', title: 'Legitimate transfer', build: g => { const n = g.name(); const dob = g.dob(); const id = g.id(); return { records: { a: { inst: 'RCA', id, name: n, dob, session: '2025-26', status: 'transferred' }, b: { inst: 'SVU', id, name: n, dob } }, pairs: [['a', 'b', 'same', 'auto', 'identifier']], noConcurrent: true }; } },
  { code: 'S12', title: 'Potential concurrent enrolment', build: g => { const n = g.name(); const dob = g.dob(); const id = g.id(); return { records: { a: { inst: 'NITM', id, name: n, dob }, b: { inst: 'RCA', id, name: n, dob } }, pairs: [['a', 'b', 'same', 'auto', 'identifier']], concurrent: true }; } },
  { code: 'S17', title: 'Two equally plausible candidates', build: g => { const n = g.name(); const dob = g.dob(); return { records: { a: { inst: 'NITM', id: '', name: n, dob }, b: { inst: 'RCA', id: g.id(), name: n, dob }, c: { inst: 'SVU', id: g.id(), name: n, dob } }, pairs: [['a', 'b', 'same', 'review', 'fuzzy'], ['a', 'c', 'different', 'review', 'fuzzy'], ['b', 'c', 'different', 'none', 'fuzzy']], competing: ['a'] }; } },
  { code: 'S18', title: 'Insufficient evidence: same name, no identifiers or birth dates', build: g => { const n = g.name(); return { records: { a: { inst: 'NITM', id: '', name: n, dob: '' }, b: { inst: 'SVU', id: '', name: n, dob: '' } }, pairs: [['a', 'b', 'unknown', 'none', 'fuzzy']] }; } },
  { code: 'S19', title: 'Shared malformed identifier', build: (g, v) => { const n = g.name(); const dob = g.dob(); const bad = `12${String(345 + v)}`; return { records: { a: { inst: 'RCA', id: bad, name: n, dob }, b: { inst: 'NITM', id: bad, name: n, dob } }, pairs: [['a', 'b', 'same', 'review', 'identifier', true]] }; } },
  { code: 'S20', title: 'Same name, different date of birth, no identifiers', build: g => { const n = g.name(); return { records: { a: { inst: 'NITM', id: '', name: n, dob: g.dob() }, b: { inst: 'RCA', id: '', name: n, dob: g.dob() } }, pairs: [['a', 'b', 'different', 'none', 'fuzzy']] }; } }
];

function toRecord(id, r, row) {
  const ddmmyyyy = iso => (iso ? iso.split('-').reverse().join('/') : '');
  return { id, source_file: `bench-${r.inst.toLowerCase()}.csv`, source_row: row, import_id: null, imported_at: '2026-10-21T09:00:00.000Z', ...normaliseRecord({ apaar_id: r.id, student_name: r.name, date_of_birth: ddmmyyyy(r.dob), institution_code: r.inst, programme: r.programme ?? 'BTECH CSE', academic_session: r.session || '2026-27', enrolment_status: r.status || 'Active' }) };
}

function buildPairDataset() {
  const g = generator();
  const records = []; const pairs = []; const instances = [];
  let row = 2;
  for (const scenario of SCENARIOS) for (let v = 0; v < VARIANTS; v++) {
    const built = scenario.build(g, v);
    const ids = {};
    for (const [tag, attrs] of Object.entries(built.records)) { ids[tag] = `B-${scenario.code}-${v}-${tag}`; records.push(toRecord(ids[tag], attrs, row++)); }
    built.pairs.forEach(([a, b, truth, expected, kind, contradiction = false]) => pairs.push({ scenario: scenario.code, variant: v, a: ids[a], b: ids[b], truth, expected, kind, contradiction }));
    instances.push({ scenario, variant: v, ids, built });
  }
  return { records, pairs, instances };
}

const classify = outcome => (outcome === 'auto_linked' ? 'auto' : ['candidate_for_review', 'needs_investigation'].includes(outcome) ? 'review' : 'none');
const ratio = (n, d) => (d ? Number((n / d).toFixed(4)) : null);

function scorePairs(links, pairs) {
  const byPair = new Map();
  links.forEach(l => { const k = [...l.records].sort().join('|'); const prev = byPair.get(k); if (!prev || classify(l.outcome) === 'auto' || (classify(l.outcome) === 'review' && classify(prev.outcome) === 'none')) byPair.set(k, l); });
  const rows = pairs.map(p => { const l = byPair.get([p.a, p.b].sort().join('|')); return { ...p, outcome: l ? l.outcome : 'not_compared', got: l ? classify(l.outcome) : 'none', competing: Boolean(l?.competing_candidates) }; });
  const labelled = new Set(pairs.map(p => [p.a, p.b].sort().join('|')));
  const unexpected = [...byPair.entries()].filter(([k, l]) => !labelled.has(k) && classify(l.outcome) !== 'none').length;
  const metrics = subset => {
    const same = subset.filter(r => r.truth === 'same');
    const auto = subset.filter(r => r.got === 'auto');
    const review = subset.filter(r => r.got === 'review');
    const surfaced = subset.filter(r => r.got !== 'none');
    return {
      labelled_pairs: subset.length, same_person_pairs: same.length,
      candidate_generation_recall: ratio(same.filter(r => r.got !== 'none').length, same.length),
      auto_links: auto.length, auto_precision: ratio(auto.filter(r => r.truth === 'same').length, auto.length),
      auto_recall_all_same: ratio(auto.filter(r => r.truth === 'same').length, same.length),
      // F1 of automatic linking against all same-person pairs: 2PR/(P+R) = 2·correct auto links / (auto links + same-person pairs).
      auto_f1: ratio(2 * auto.filter(r => r.truth === 'same').length, auto.length + same.length),
      auto_recall_policy_eligible: ratio(subset.filter(r => r.expected === 'auto' && r.got === 'auto').length, subset.filter(r => r.expected === 'auto').length),
      false_positive_auto_links: auto.filter(r => r.truth !== 'same').length,
      review_candidates: review.length, candidate_precision: ratio(review.filter(r => r.truth === 'same').length, review.length),
      candidate_recall: ratio(subset.filter(r => r.truth === 'same' && r.expected === 'review' && r.got === 'review').length, subset.filter(r => r.truth === 'same' && r.expected === 'review').length),
      surfaced_pairs: surfaced.length,
      inconclusive_correctly_not_linked: `${subset.filter(r => r.truth === 'unknown' && r.got !== 'auto').length} of ${subset.filter(r => r.truth === 'unknown').length}`,
      contradictory_pairs_auto_linked: subset.filter(r => r.contradiction && r.got === 'auto').length,
      outcome_matches_expected: `${subset.filter(r => r.got === r.expected).length} of ${subset.length}`
    };
  };
  const byScenario = SCENARIOS.map(s => {
    const list = rows.filter(r => r.scenario === s.code);
    return { scenario: s.code, title: s.title, pairs: list.length, expected: [...new Set(list.map(r => r.expected))].join('/'), matches_expected: list.filter(r => r.got === r.expected).length, outcomes: Object.entries(list.reduce((m, r) => ({ ...m, [r.outcome]: (m[r.outcome] || 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ') };
  });
  return { overall: metrics(rows), exact_identifier_pairs: metrics(rows.filter(r => r.kind === 'identifier')), fuzzy_pairs: metrics(rows.filter(r => r.kind === 'fuzzy')), by_scenario: byScenario, unexpected_surfaced_pairs: unexpected, rows };
}

// Extra checks that are not pair outcomes: competing-candidate flags and concurrent-enrolment rules.
function scenarioChecks(dataset, links) {
  const findings = reconcile({ sourceRecords: dataset.records, capacityRules: [] });
  const concurrent = new Set(findings.filter(f => f.rule_code === 'POTENTIAL_CONCURRENT_ENROLMENT').flatMap(f => f.evidence));
  const checks = { competing_flagged: [0, 0], concurrent_raised: [0, 0], no_false_concurrent: [0, 0] };
  for (const inst of dataset.instances) {
    if (inst.built.competing) { checks.competing_flagged[1]++; if (links.some(l => l.records.includes(inst.ids.a) && l.competing_candidates)) checks.competing_flagged[0]++; }
    if (inst.built.concurrent) { checks.concurrent_raised[1]++; if (concurrent.has(inst.ids.a) && concurrent.has(inst.ids.b)) checks.concurrent_raised[0]++; }
    if (inst.built.noConcurrent) { checks.no_false_concurrent[1]++; if (!concurrent.has(inst.ids.a)) checks.no_false_concurrent[0]++; }
  }
  return Object.fromEntries(Object.entries(checks).map(([k, [n, d]]) => [k, `${n} of ${d}`]));
}

// ── Pipeline scenarios (current system) ──
const HEADERS = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
const REGULATOR = { role: 'regulator', name: 'Benchmark reviewer' };
function emptyDb() { return { version: 1, institutions: [{ code: 'NITM', name: 'Northbridge Institute of Technology' }, { code: 'RCA', name: 'Riverview College of Arts' }, { code: 'SVU', name: 'Suryavardhan Valley University' }], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] }; }
function importRows(db, inst, rows, file, at) {
  const parsed = { headers: HEADERS, rows: rows.map(r => ({ apaar_id: r.id || '', student_name: r.name, date_of_birth: r.dob ? r.dob.split('-').reverse().join('/') : '', institution_code: inst, programme: 'BTECH CSE', academic_session: '2026-27', enrolment_status: 'Active' })), row_numbers: rows.map((_, i) => i + 2) };
  return commitImport(db, { parsed, mapping: Object.fromEntries(HEADERS.map(h => [h, h])), batchInstitution: inst, multiInstitution: false, filename: file, at });
}
const openCurrent = db => db.findings.filter(f => isCurrent(f) && f.review_status !== 'resolved');
const duplicateConditions = db => { const keys = db.findings.filter(isCurrent).map(f => f.condition_key).filter(Boolean); return keys.length - new Set(keys).size; };

function runPipelineScenarios() {
  const results = [];
  const at = n => new Date(Date.parse('2026-10-22T09:00:00.000Z') + n * 60000).toISOString();

  // P13 + P15: a candidate rejected by a reviewer stays rejected when the same files are re-imported.
  {
    const db = emptyDb();
    const a = [{ id: '', name: 'Tara Shetty', dob: '2004-05-06' }]; const b = [{ id: '', name: 'Tara Shetty', dob: '2004-05-06' }];
    importRows(db, 'NITM', a, 'p13-nitm.csv', at(1)); importRows(db, 'SVU', b, 'p13-svu.csv', at(2));
    const first = listMatches(db, REGULATOR);
    const pair = first.data[0];
    decideMatch(db, REGULATOR, pair.id, { decision: 'different_person', note: 'Different guardians and schools on the source documents.' });
    const findingsBefore = db.findings.length; const openBefore = openCurrent(db).length; const notesBefore = (db.notifications || []).flatMap(n => n.items).length;
    importRows(db, 'NITM', a, 'p13-nitm.csv', at(3)); importRows(db, 'SVU', b, 'p13-svu.csv', at(4));
    const after = listMatches(db, REGULATOR);
    results.push({ scenario: 'P13', title: 'Candidate previously rejected by a reviewer, then both files re-imported unchanged', passed: first.total === 1 && after.total === 1 && after.data[0].status === 'different_person' && after.data[0].copies === 4 && openCurrent(db).length === openBefore,
      observed: { queue_before: first.total, queue_after: after.total, status_after: after.data[0]?.status, pair_copies_grouped: after.data[0]?.copies, open_findings_before: openBefore, open_findings_after: openCurrent(db).length } });
    results.push({ scenario: 'P15', title: 'Re-import of unchanged files', passed: db.findings.length === findingsBefore && duplicateConditions(db) === 0 && (db.notifications || []).flatMap(n => n.items).length === notesBefore,
      observed: { findings_created_by_reimport: db.findings.length - findingsBefore, duplicate_current_conditions: duplicateConditions(db), new_notification_items: (db.notifications || []).flatMap(n => n.items).length - notesBefore } });
  }
  // P14: an automatic association contradicted by a later record is withdrawn and audited.
  {
    const db = emptyDb();
    importRows(db, 'NITM', [{ id: '952000000001', name: 'Farah Qureshi', dob: '2003-03-03' }], 'p14-nitm.csv', at(1));
    importRows(db, 'RCA', [{ id: '952000000001', name: 'Farah Qureshi', dob: '2003-03-03' }], 'p14-rca.csv', at(2));
    const linkedBefore = db.identityLinks.filter(l => l.outcome === 'auto_linked').length;
    const autoMatched = db.auditEvents.filter(e => e.action === 'automatically_matched').length;
    importRows(db, 'SVU', [{ id: '952000000001', name: 'Farah Qureshi', dob: '2005-09-09' }], 'p14-svu.csv', at(3));
    const withdrawnLink = db.identityLinks.find(l => l.withdrawn);
    const conflict = db.findings.find(f => isCurrent(f) && f.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
    const cleared = db.auditEvents.filter(e => ['condition_cleared', 'superseded', 'automatic_match_withdrawn'].includes(e.action)).length;
    const queue = listMatches(db, REGULATOR);
    results.push({ scenario: 'P14', title: 'Automatic association later contradicted by a new record', passed: linkedBefore === 1 && autoMatched === 1 && Boolean(withdrawnLink) && Boolean(conflict) && conflict.review_status === 'pending' && cleared >= 1 && queue.data.some(m => m.resolution === 'MATCH_WITHDRAWN'),
      observed: { auto_links_before: linkedBefore, automatic_match_audited: autoMatched, link_marked_withdrawn: Boolean(withdrawnLink), conflict_finding_pending: conflict?.review_status || null, lifecycle_audit_events: cleared, auto_links_after: db.identityLinks.filter(l => l.outcome === 'auto_linked').length, queue_resolutions: queue.data.map(m => m.resolution) } });
  }
  // P16: a later file supplies the missing identifier for one record.
  {
    const db = emptyDb();
    importRows(db, 'NITM', [{ id: '952000000002', name: 'Kiran Banerjee', dob: '2004-12-12' }], 'p16-nitm.csv', at(1));
    importRows(db, 'SVU', [{ id: '', name: 'Kiran Banerjee', dob: '2004-12-12' }], 'p16-svu.csv', at(2));
    const before = listMatches(db, REGULATOR);
    decideMatch(db, REGULATOR, before.data[0].id, { decision: 'needs_more_evidence', note: 'Asked SVU for the identifier.' });
    importRows(db, 'SVU', [{ id: '952000000002', name: 'Kiran Banerjee', dob: '2004-12-12' }], 'p16-svu-corrected.csv', at(3));
    const autoAfter = db.identityLinks.filter(l => l.outcome === 'auto_linked').length;
    const after = listMatches(db, REGULATOR);
    results.push({ scenario: 'P16', title: 'Re-import after correcting one source record (identifier supplied)', passed: before.total === 1 && autoAfter === 1,
      observed: { candidates_before: before.total, auto_links_after_correction: autoAfter, candidates_still_listed: after.total, earlier_pair_status: after.data[0]?.status || null },
      note: 'Source records are immutable: the corrected row is a new record, so the earlier identifier-less row and its candidate pair (with the reviewer\'s "needs more evidence") remain until a reviewer closes them.' });
  }
  return results;
}

// ── Latency at scale: the previous all-pairs candidate rule versus blocked generation ──
// Realistic load: about 1,200 distinct birth dates shared by many students, a quarter of records
// without an identifier, and every 15th record a re-submission of an earlier student at another
// institution (half with the identifier, half without), so all candidate paths are exercised.
function scaleDataset(n) {
  const g = generator(); const records = []; const dobs = Array.from({ length: 1200 }, () => g.dob());
  for (let i = 0; i < n; i++) {
    const inst = ['NITM', 'RCA', 'SVU'][i % 3];
    if (i >= 15 && i % 15 === 0) {
      const earlier = records[i - 7];
      records.push({ ...toRecord(`L-${i}`, { inst: ['NITM', 'RCA', 'SVU'][(i + 1) % 3], id: i % 30 ? '' : earlier.apaar_id, name: earlier.student_name, dob: earlier.date_of_birth }, i + 2) });
      continue;
    }
    const name = `${FIRST[i % FIRST.length]} ${LAST[Math.floor(i / FIRST.length) % LAST.length]} ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 2000)}`;
    records.push(toRecord(`L-${i}`, { inst, id: i % 4 ? g.id() : '', name, dob: dobs[i % dobs.length] }, i + 2));
  }
  return records;
}
function allPairsCandidateRule(records) {
  let compared = 0; let found = 0;
  for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) { const a = records[i], b = records[j]; compared++; if ((a.apaar_fingerprint && b.apaar_fingerprint) || a.institution_code === b.institution_code) continue; if (similarity(a.normalized_name, b.normalized_name) >= 0.8 && a.date_of_birth && a.date_of_birth === b.date_of_birth) found++; }
  return { compared, found };
}
function timeIt(fn) { const t = process.hrtime.bigint(); const out = fn(); return { ms: Number((Number(process.hrtime.bigint() - t) / 1e6).toFixed(1)), out }; }
function measureLatency(sizes = [1000, 3000]) {
  return sizes.map(n => {
    const records = scaleDataset(n);
    const old = timeIt(() => allPairsCandidateRule(records));
    const base = timeIt(() => baseline.buildIdentityLinks(records));
    const cur = timeIt(() => current.buildIdentityLinks(records));
    const count = (links, outcome) => links.filter(l => l.outcome === outcome).length;
    return { records: n, previous_all_pairs_candidate_rule_ms: old.ms, previous_rule_pairs_examined: old.out.compared, previous_rule_candidates: old.out.found, baseline_identity_links_ms: base.ms, baseline_candidates: count(base.out, 'candidate_for_review'), current_identity_links_ms: cur.ms, current_candidates: count(cur.out, 'candidate_for_review'), current_auto_links: count(cur.out, 'auto_linked'), current_links_recorded: cur.out.length };
  });
}

// ── Optional: model explanations of the review pairs (advisory; never changes outcomes) ──
async function runAiExplanations(provider, dataset, links) {
  if (!provider?.configured) return { status: 'not run: no model provider configured' };
  const db = { ...emptyDb(), sourceRecords: dataset.records, identityLinks: links, findings: [] };
  const review = links.filter(l => ['candidate_for_review', 'needs_investigation'].includes(l.outcome));
  const before = JSON.stringify(links.map(l => [l.id, l.outcome]));
  const results = [];
  for (const l of review) {
    const t = Date.now();
    const { result } = await explainMatch(db, REGULATOR, l.id, provider);
    results.push({ link: l.id, source: result.source, reason: result.model_unavailable_reason || null, ms: Date.now() - t });
  }
  const valid = results.filter(r => r.source === 'model');
  const latencies = valid.map(r => r.ms).sort((a, b) => a - b);
  const reasons = results.filter(r => r.source !== 'model').reduce((m, r) => { const k = (r.reason || '').replace(/; deterministic.*$/, '').slice(0, 120); m[k] = (m[k] || 0) + 1; return m; }, {});
  return { model: provider.status().model, provider: provider.status().provider_label, pairs: results.length, valid_explanations: valid.length, rejected_or_failed: results.length - valid.length, rejection_reasons: reasons, median_ms: latencies[Math.floor(latencies.length / 2)] ?? null, max_ms: latencies.at(-1) ?? null, identity_outcomes_changed: JSON.stringify(links.map(l => [l.id, l.outcome])) !== before, note: 'Explanation validity is not identity-match accuracy: the model only describes the deterministic evidence.' };
}

async function runIdentityBenchmark({ provider = null, sizes } = {}) {
  const dataset = buildPairDataset();
  const baseLinks = baseline.buildIdentityLinks(dataset.records);
  const curLinks = current.buildIdentityLinks(dataset.records);
  const strip = r => { const { rows, ...rest } = r; return rest; };
  return {
    generated_at: new Date().toISOString(),
    data: `${SCENARIOS.length} pair scenarios × ${VARIANTS} synthetic variants = ${dataset.instances.length} instances, ${dataset.records.length} records, ${dataset.pairs.length} labelled pairs; plus 4 pipeline scenarios.`,
    caution: 'Designed synthetic cases. The figures show how each policy behaves on these cases; they do not estimate accuracy on real data.',
    baseline: { policy: baseline.AUTO_LINK_POLICY.version, ...strip(scorePairs(baseLinks, dataset.pairs)), checks: scenarioChecks(dataset, baseLinks) },
    current: { policy: current.AUTO_LINK_POLICY.version, ...strip(scorePairs(curLinks, dataset.pairs)), checks: scenarioChecks(dataset, curLinks) },
    pipeline: runPipelineScenarios(),
    latency: measureLatency(sizes),
    ai_explanations: await runAiExplanations(provider, dataset, curLinks)
  };
}

module.exports = { SCENARIOS, VARIANTS, buildPairDataset, scorePairs, runPipelineScenarios, measureLatency, runIdentityBenchmark };
