// Does model assistance add measurable value over the deterministic engine?
//
// Three comparisons on labelled synthetic data, each run through the same code paths the
// application uses:
//   1. Schema mapping: deterministic suggestions (aliases + header similarity) versus the same
//      followed by validated model suggestions, scored per field against labelled mappings.
//   2. Identity: name-only candidate matches (which the deterministic engine always leaves to a
//      reviewer) versus the model's advisory assessment, scored against the labelled person.
//      The model's output is never applied; the harness checks that no link or finding changed.
//   3. Explanations: how often a model explanation of a persisted finding passes schema and
//      grounding validation.
//   4. Name variants: labelled synthetic name pairs (abbreviations, transliterations, reordering,
//      and similar but different names) sent straight to the candidate task, because the engine
//      does not flag most of them as candidates. The deterministic engine never decides these;
//      its name-token similarity and whether it would flag the pair are reported alongside.
// No real student data is used. Without a configured provider only the baseline is measured and
// every model figure is reported as pending — nothing is estimated.
const { FIELD_DEFINITIONS, isCurrent, similarity, normaliseRecord } = require('./engine');
const { CANDIDATE_SIMILARITY } = require('./identity');
const { suggestMapping } = require('./pipeline');
const { createProvider } = require('./ai-provider');
const { buildEvaluationState } = require('./evaluation');
const { explanationInput, candidateInput } = require('./assist');

// ── Labelled schema-mapping cases ──
// Each column: [header, canonical field or null (a decoy that must not be mapped), value kind].
const SCHEMA_CASES = [
  { id: 'S01', note: 'Standard headers', columns: [['APAAR ID', 'apaar_id', 'apaar'], ['Student Name', 'student_name', 'name'], ['Date of Birth', 'date_of_birth', 'dob'], ['Institution Code', 'institution_code', 'inst'], ['Programme', 'programme', 'programme'], ['Academic Session', 'academic_session', 'session'], ['Enrolment Status', 'enrolment_status', 'status']] },
  { id: 'S02', note: 'Learner/pupil wording', columns: [['Pupil', 'student_name', 'name'], ['Learner Registry No', 'apaar_id', 'apaar'], ['D.O.B.', 'date_of_birth', 'dob'], ['Inst', 'institution_code', 'inst'], ['Branch', 'programme', 'programme'], ['AY', 'academic_session', 'session'], ['Current State', 'enrolment_status', 'status']] },
  { id: 'S03', note: 'Guardian decoys', columns: [['Name of Student', 'student_name', 'name'], ['Father Name', null, 'person'], ['Mother Name', null, 'person'], ['Birth Dt', 'date_of_birth', 'dob'], ['College Code', 'institution_code', 'inst'], ['Course', 'programme', 'programme'], ['Session', 'academic_session', 'session'], ['Status', 'enrolment_status', 'status']] },
  { id: 'S04', note: 'Admission date and contact decoys', columns: [['Candidate', 'student_name', 'name'], ['Date of Admission', null, 'date'], ['Born On', 'date_of_birth', 'dob'], ['Mobile No', null, 'mobile'], ['Inst. Cd', 'institution_code', 'inst'], ['Stream', 'programme', 'programme'], ['Yr', 'academic_session', 'session'], ['Student Status', 'enrolment_status', 'status']] },
  { id: 'S05', note: 'Hindi-English headers', columns: [['Chhatra Naam', 'student_name', 'name'], ['Janm Tithi', 'date_of_birth', 'dob'], ['Sanstha Code', 'institution_code', 'inst'], ['Pathyakram', 'programme', 'programme'], ['Satra', 'academic_session', 'session'], ['Sthiti', 'enrolment_status', 'status'], ['APAAR', 'apaar_id', 'apaar']] },
  { id: 'S06', note: 'Optional fields present', columns: [['Full Name', 'student_name', 'name'], ['ABC Number', 'apaar_id', 'apaar'], ['DOB', 'date_of_birth', 'dob'], ['AISHE', 'institution_code', 'inst'], ['College', 'institution_name', 'inst_name'], ['Degree', 'programme', 'programme'], ['Academic Year', 'academic_session', 'session'], ['Joined', 'admission_year', 'year'], ['Quota', 'seat_category', 'seat'], ['Enrollment', 'enrolment_status', 'status']] },
  { id: 'S07', note: 'Abbreviations', columns: [['Stu Nm', 'student_name', 'name'], ['Stu DOB', 'date_of_birth', 'dob'], ['Inst Cd', 'institution_code', 'inst'], ['Prog', 'programme', 'programme'], ['Sess', 'academic_session', 'session'], ['Enr Stat', 'enrolment_status', 'status'], ['Uid', 'apaar_id', 'apaar']] },
  { id: 'S08', note: 'Remarks and short-number decoys', columns: [['Learner Name', 'student_name', 'name'], ['Aadhaar Last 4', null, 'short'], ['Remarks', null, 'remark'], ['DOB', 'date_of_birth', 'dob'], ['Institute', 'institution_code', 'inst'], ['Course Name', 'programme', 'programme'], ['Term', 'academic_session', 'session'], ['Status', 'enrolment_status', 'status']] },
  { id: 'S09', note: 'Guardian date decoy next to student date', columns: [['Student', 'student_name', 'name'], ['Guardian DOB', null, 'date'], ['Birthday', 'date_of_birth', 'dob'], ['College Code', 'institution_code', 'inst'], ['Programme', 'programme', 'programme'], ['Session', 'academic_session', 'session'], ['Status', 'enrolment_status', 'status']] },
  { id: 'S10', note: 'No identifier column', columns: [['Name', 'student_name', 'name'], ['Dt of Birth', 'date_of_birth', 'dob'], ['HEI Code', 'institution_code', 'inst'], ['Discipline', 'programme', 'programme'], ['Batch', 'academic_session', 'session'], ['Active?', 'enrolment_status', 'status'], ['Email', null, 'email']] },
  { id: 'S11', note: 'Generic column names', columns: [['Col A', 'student_name', 'name'], ['Col B', 'date_of_birth', 'dob'], ['Col C', 'institution_code', 'inst'], ['Col D', 'programme', 'programme'], ['Col E', 'academic_session', 'session'], ['Col F', 'enrolment_status', 'status']] },
  { id: 'S12', note: 'Identifier variants and admission category', columns: [['Unique Learner Id', 'apaar_id', 'apaar'], ['Student Full Name', 'student_name', 'name'], ['Birth Date', 'date_of_birth', 'dob'], ['Institution', 'institution_code', 'inst'], ['Programme of Study', 'programme', 'programme'], ['Academic Session', 'academic_session', 'session'], ['Current Enrolment', 'enrolment_status', 'status'], ['Category', 'seat_category', 'seat'], ['Year Joined', 'admission_year', 'year']] }
];
const VALUES = {
  apaar: i => `7${String(301000000 + i * 7919).padStart(11, '0')}`.slice(0, 12),
  name: i => ['Aarav Menon', 'Diya Kulkarni', 'Kabir Iyer'][i],
  person: i => ['Suresh Menon', 'Lata Kulkarni', 'Ravi Iyer'][i],
  dob: i => ['14/03/2005', '02/11/2004', '27/07/2005'][i],
  date: i => ['01/08/2024', '03/08/2024', '05/08/2024'][i],
  inst: () => 'NITM',
  inst_name: () => 'Northbridge Institute of Technology',
  programme: i => ['BTECH CSE', 'BTECH ECE', 'BTECH ME'][i],
  session: () => '2026-27',
  status: i => ['Active', 'Active', 'Transferred'][i],
  year: () => '2024',
  seat: i => ['GEN', 'OBC', 'SC'][i],
  mobile: i => `98${String(40000000 + i * 1234).padStart(8, '0')}`,
  short: i => String(1200 + i * 37),
  remark: i => ['Documents pending', 'Fee paid in full', 'Hostel resident'][i],
  email: i => `student${i}@example.edu`
};
function parsedCase(c) {
  const headers = c.columns.map(([h]) => h);
  const rows = [0, 1, 2].map(i => Object.fromEntries(c.columns.map(([h, , kind]) => [h, VALUES[kind](i)])));
  return { headers, rows, row_numbers: [2, 3, 4] };
}
const REQUIRED = FIELD_DEFINITIONS.filter(f => f.required).map(f => f.key);

function scoreMapping(c, mapping) {
  const truth = Object.fromEntries(c.columns.filter(([, field]) => field).map(([h, field]) => [field, h]));
  const tally = { correct: 0, wrong: 0, missed: 0, correct_abstentions: 0 };
  for (const { key } of FIELD_DEFINITIONS) {
    const expected = truth[key] || null; const got = mapping[key] || null;
    if (expected && got === expected) tally.correct++;
    else if (got) tally.wrong++;
    else if (expected) tally.missed++;
    else tally.correct_abstentions++;
  }
  tally.required_ready = REQUIRED.every(key => truth[key] && mapping[key] === truth[key]);
  return tally;
}
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] || 0), 0);
const pct = (n, d) => (d ? Number((n / d).toFixed(4)) : null);
function summarise(rows) {
  const correct = sum(rows, 'correct'); const wrong = sum(rows, 'wrong'); const missed = sum(rows, 'missed');
  return { mapped_correctly: correct, mapped_wrongly: wrong, left_unmapped: missed, correct_abstentions: sum(rows, 'correct_abstentions'), precision: pct(correct, correct + wrong), recall: pct(correct, correct + missed), files_ready_without_manual_mapping: rows.filter(r => r.required_ready).length, files: rows.length };
}
const latencySummary = values => { const v = values.filter(x => typeof x === 'number').sort((a, b) => a - b); return v.length ? { calls: v.length, mean_ms: Math.round(v.reduce((a, b) => a + b, 0) / v.length), median_ms: v[Math.floor(v.length / 2)], max_ms: v[v.length - 1] } : null; };
const tokenSummary = usages => { const u = usages.filter(Boolean); return u.length ? { input_tokens: u.reduce((n, x) => n + (x.input_tokens || 0), 0), output_tokens: u.reduce((n, x) => n + (x.output_tokens || 0), 0) } : null; };

async function runSchemaComparison(provider) {
  const disabled = createProvider({ env: {} });
  const baseline = []; const assisted = []; const model = { calls: 0, failed: [], accepted: [], rejected: [], latencies: [], usages: [] };
  for (const c of SCHEMA_CASES) {
    const parsed = parsedCase(c);
    const truth = Object.fromEntries(c.columns.map(([h, field]) => [h, field]));
    const base = await suggestMapping(parsed, disabled);
    baseline.push({ case: c.id, ...scoreMapping(c, base.mapping) });
    if (!provider.configured) continue;
    const withModel = await suggestMapping(parsed, provider);
    assisted.push({ case: c.id, ...scoreMapping(c, withModel.mapping) });
    const m = withModel.model;
    if (m.sent) { model.calls++; model.latencies.push(m.latency_ms); model.usages.push(m.usage); }
    if (m.sent && !m.used) model.failed.push({ case: c.id, reason: m.note });
    m.suggestions.forEach(s => model.accepted.push({ case: c.id, ...s, correct: truth[s.header] === s.field }));
    m.rejected.forEach(s => model.rejected.push({ case: c.id, ...s, would_have_been_correct: truth[s.header] === s.field }));
  }
  return {
    cases: SCHEMA_CASES.length,
    fields_scored_per_file: FIELD_DEFINITIONS.length,
    baseline: summarise(baseline),
    model_assisted: provider.configured ? summarise(assisted) : 'pending — no model provider configured',
    model: provider.configured ? {
      calls: model.calls, failed_calls: model.failed,
      accepted_suggestions: model.accepted.length, accepted_correct: model.accepted.filter(s => s.correct).length, accepted_wrong: model.accepted.filter(s => !s.correct).length,
      rejected_by_validation: model.rejected.length, rejected_that_would_have_been_correct: model.rejected.filter(s => s.would_have_been_correct).length,
      latency: latencySummary(model.latencies), usage: tokenSummary(model.usages), accepted: model.accepted, rejected: model.rejected
    } : null,
    per_case: SCHEMA_CASES.map(c => ({ case: c.id, note: c.note, baseline: baseline.find(r => r.case === c.id), model_assisted: assisted.find(r => r.case === c.id) || null }))
  };
}

const snapshot = db => JSON.stringify({ links: db.identityLinks, findings: db.findings.map(f => ({ id: f.id, review_status: f.review_status, lifecycle_status: f.lifecycle_status, decision: f.decision, evidence: f.evidence })) });

async function runIdentityComparison(provider) {
  const { db, truthByRecord } = buildEvaluationState();
  const before = snapshot(db);
  const candidates = db.findings.filter(f => isCurrent(f) && f.rule_code === 'CANDIDATE_IDENTITY_MATCH' && f.evidence.length === 2);
  const labelled = candidates.map(f => ({ finding: f, same: truthByRecord.get(f.evidence[0]).person === truthByRecord.get(f.evidence[1]).person }));
  const unflaggedSamePairs = ['name_variant'].map(label => [...new Set(db.sourceRecords.filter(r => truthByRecord.get(r.id).labels.includes(label)).map(r => truthByRecord.get(r.id).case))].length)[0];
  const base = { candidate_pairs: labelled.length, same_person: labelled.filter(x => x.same).length, different_people: labelled.filter(x => !x.same).length, deterministic_outcome: 'All are left as candidates for review; none is linked or dismissed automatically.', abbreviated_name_pairs_never_flagged: unflaggedSamePairs };
  const availability = provider.status().tasks.candidate_assessment;
  if (!availability.available) return { ...base, model: `pending — ${availability.reason}` };
  const results = [];
  for (const x of labelled) {
    const r = await provider.run('candidate_assessment', candidateInput(db, x.finding));
    results.push({ pair: results.length + 1, same: x.same, ok: r.ok, assessment: r.ok ? r.output.assessment : null, name_relationship: r.ok ? r.output.name_relationship : null, latency_ms: r.provenance?.latency_ms ?? r.latency_ms ?? null, usage: r.provenance?.usage ?? null, reason: r.ok ? null : r.reason });
  }
  const decided = results.filter(r => r.ok && r.assessment !== 'insufficient_evidence');
  const correct = decided.filter(r => (r.assessment === 'likely_same_person') === r.same);
  return {
    ...base,
    model: {
      assessed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).map(r => r.reason),
      insufficient_evidence: results.filter(r => r.ok && r.assessment === 'insufficient_evidence').length,
      decided: decided.length, decided_correctly: correct.length, decided_wrongly: decided.length - correct.length, accuracy_when_decided: pct(correct.length, decided.length),
      said_same_but_different_people: decided.filter(r => r.assessment === 'likely_same_person' && !r.same).length,
      latency: latencySummary(results.map(r => r.latency_ms)), usage: tokenSummary(results.map(r => r.usage)),
      // Per pair, without names: the label, the model's answer and whether it was valid.
      per_pair: results.map(r => ({ pair: r.pair, labelled_same_person: r.same, ok: r.ok, assessment: r.assessment, name_relationship: r.name_relationship, latency_ms: r.latency_ms }))
    },
    model_changed_links_or_findings: snapshot(db) !== before
  };
}

async function runExplanationCheck(provider) {
  const { db } = buildEvaluationState();
  const byRule = new Map();
  db.findings.filter(isCurrent).forEach(f => { if (!byRule.has(f.rule_code)) byRule.set(f.rule_code, f); });
  if (!provider.status().tasks.finding_explanation.available) return { findings: byRule.size, model: 'pending — no model provider configured' };
  const before = snapshot(db);
  const results = [];
  for (const f of byRule.values()) {
    const r = await provider.run('finding_explanation', explanationInput(db, f));
    results.push({ rule_code: f.rule_code, ok: r.ok, rejected_because: r.ok ? null : r.error?.kind || r.reason, latency_ms: r.provenance?.latency_ms ?? r.latency_ms ?? null, usage: r.provenance?.usage ?? null, summary: r.ok ? r.output.summary : null, output: r.ok ? r.output : null, detail: r.ok ? null : r.reason });
  }
  return { findings: results.length, passed_validation: results.filter(r => r.ok).length, rejected: results.filter(r => !r.ok).map(r => ({ rule_code: r.rule_code, reason: r.rejected_because })), latency: latencySummary(results.map(r => r.latency_ms)), usage: tokenSummary(results.map(r => r.usage)), samples: results.filter(r => r.ok).map(r => ({ rule_code: r.rule_code, summary: r.summary })), per_rule: results.map(r => ({ rule_code: r.rule_code, ok: r.ok, rejected_because: r.rejected_because, detail: r.detail, latency_ms: r.latency_ms, output: r.output })), model_changed_findings: snapshot(db) !== before };
}

// Labelled by construction: "same" pairs are one synthetic person written two ways; "different"
// pairs are two synthetic people with similar names. Every pair has an agreeing date of birth and
// no usable identifier, as a real candidate would.
const NAME_VARIANT_CASES = [
  ['V01', 'Mohammed Imran Khan', 'Mohd Imran Khan', true, 'abbreviation'],
  ['V02', 'Syed Abdul Rahman', 'Syed Abdul Rehman', true, 'transliteration'],
  ['V03', 'Lakshmi Narayanan', 'Laxmi Narayanan', true, 'transliteration'],
  ['V04', 'Venkatesh Subramanian', 'Venkatesh Subramaniam', true, 'spelling'],
  ['V05', 'Priya Sharma', 'Sharma Priya', true, 'order swapped'],
  ['V06', 'Fatima Sheikh', 'Fatima Shaikh', true, 'transliteration'],
  ['V07', 'Aarav Sharma', 'Aarav Verma', false, 'different surname'],
  ['V08', 'Rohan Mehta', 'Rohit Mehta', false, 'different first name'],
  ['V09', 'Sneha Patil', 'Neha Patil', false, 'different first name'],
  ['V10', 'Arjun Reddy', 'Arun Reddy', false, 'different first name'],
  ['V11', 'Ananya Iyer', 'Ananya Iyengar', false, 'different surname'],
  ['V12', 'Kiran Joshi', 'Kiran Joshi Rao', false, 'extra surname']
];
async function runNameVariantComparison(provider) {
  const norm = name => normaliseRecord({ student_name: name }).normalized_name;
  const cases = NAME_VARIANT_CASES.map(([id, a, b, same, kind]) => { const sim = similarity(norm(a), norm(b)); return { id, same, kind, input: { name_a: a, name_b: b, date_of_birth_agrees: true, same_institution: false, identifiers: 'missing on at least one record', name_token_similarity: Number(sim.toFixed(2)) }, engine_would_flag: sim >= CANDIDATE_SIMILARITY }; });
  const base = { pairs: cases.length, same_person: cases.filter(c => c.same).length, different_people: cases.filter(c => !c.same).length, deterministic_outcome: 'Never decided automatically. A pair reaches a reviewer only when name-token similarity is at least ' + CANDIDATE_SIMILARITY + '.', engine_would_flag: cases.filter(c => c.engine_would_flag).length, engine_would_flag_same_person: cases.filter(c => c.engine_would_flag && c.same).length };
  const availability = provider.status().tasks.candidate_assessment;
  if (!availability.available) return { ...base, model: `pending — ${availability.reason}` };
  const results = [];
  for (const c of cases) {
    const r = await provider.run('candidate_assessment', c.input);
    results.push({ case: c.id, kind: c.kind, labelled_same_person: c.same, engine_would_flag: c.engine_would_flag, ok: r.ok, assessment: r.ok ? r.output.assessment : null, name_relationship: r.ok ? r.output.name_relationship : null, latency_ms: r.provenance?.latency_ms ?? r.latency_ms ?? null, usage: r.provenance?.usage ?? null, detail: r.ok ? null : r.reason });
  }
  const decided = results.filter(r => r.ok && r.assessment !== 'insufficient_evidence');
  const correct = decided.filter(r => (r.assessment === 'likely_same_person') === r.labelled_same_person);
  return {
    ...base,
    model: {
      valid: results.filter(r => r.ok).length, invalid: results.filter(r => !r.ok).map(r => ({ case: r.case, reason: r.detail })),
      insufficient_evidence: results.filter(r => r.ok && r.assessment === 'insufficient_evidence').length,
      decided: decided.length, decided_correctly: correct.length, decided_wrongly: decided.length - correct.length, accuracy_when_decided: pct(correct.length, decided.length),
      said_same_but_different_people: decided.filter(r => r.assessment === 'likely_same_person' && !r.labelled_same_person).length,
      said_different_but_same_person: decided.filter(r => r.assessment === 'likely_different_people' && r.labelled_same_person).length,
      latency: latencySummary(results.map(r => r.latency_ms)), usage: tokenSummary(results.map(r => r.usage)),
      per_pair: results.map(({ usage, detail, ...r }) => r)
    },
    applied: 'Nothing. Assessments are advisory and are not written to any record, link or finding.'
  };
}

async function runAiEvaluation(provider = createProvider()) {
  const status = provider.status();
  return {
    generated_at: new Date().toISOString(),
    provider: { provider: status.provider, model: status.model, configured: status.configured, settings: status.settings, reason: status.reason },
    note: 'Synthetic labelled data only. Baseline figures are deterministic and reproducible; model figures come from real provider calls when a provider is configured and are otherwise reported as pending.',
    schema_mapping: await runSchemaComparison(provider),
    identity_candidates: await runIdentityComparison(provider),
    name_variants: await runNameVariantComparison(provider),
    explanations: await runExplanationCheck(provider),
    health_after_run: provider.status().health,
    usage_after_run: provider.status().usage,
    rate_limits_after_run: provider.status().rate_limits
  };
}

module.exports = { SCHEMA_CASES, NAME_VARIANT_CASES, parsedCase, scoreMapping, runSchemaComparison, runIdentityComparison, runNameVariantComparison, runExplanationCheck, runAiEvaluation };
