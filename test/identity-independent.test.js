require('../test-support/isolated-db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runIndependentEvaluation, scorePairs, DEFINITIONS } = require('../bench/identity-holdout/evaluate');
const { buildPairDataset, scorePairs: scoreBenchmark } = require('../src/identity-benchmark');
const { buildIdentityLinks } = require('../src/identity');
const { commitImport } = require('../src/pipeline');
const { isCurrent } = require('../src/engine');
const { assistFinding } = require('../src/assist');
const { createProvider } = require('../src/ai-provider');

const dir = path.join(__dirname, '..', 'bench', 'identity-holdout');

test('the held-out labels are independent of production matching code', () => {
  const generator = fs.readFileSync(path.join(dir, 'generate.js'), 'utf8');
  assert.doesNotMatch(generator, /require\(['"]\.\.\/\.\.\/src|require\(['"]\.\/evaluate/, 'the generator imports no production code');
  const runner = fs.readFileSync(path.join(dir, 'evaluate.js'), 'utf8');
  const imports = [...runner.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  assert.deepEqual(imports.filter(m => m.includes('src/')).sort(), ['../../src/engine', '../../src/pipeline'], 'the runner executes the pipeline; it does not call identity, name or lineage rules to decide labels');
  for (const file of ['cases.json', 'cases-confirmation.json']) {
    const cases = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.ok(cases.rows.length > 500 && cases.people.length > 350);
    for (const row of cases.rows) {
      assert.ok(row.truth.person_id && row.truth.source_key && row.truth.relation);
      assert.equal(Object.keys(row.truth).some(k => /expected|outcome|auto|candidate/.test(k)), false, 'truth describes who and which record, never an expected matcher outcome');
    }
  }
});

test('independent metrics use their documented denominators and the safety properties hold on the unseen set', () => {
  const r = runIndependentEvaluation({ casesFile: path.join(dir, 'cases-confirmation.json') });
  for (const key of ['candidate_generation_recall', 'automatic_link_precision', 'automatic_link_recall', 'review_precision', 'review_recall', 'false_positive_automatic_links', 'false_negatives', 'hard_negative_pairs', 'contradictory_pairs']) assert.ok(DEFINITIONS[key], key);
  for (const scope of Object.values(r.identity)) {
    for (const metric of Object.values(scope).filter(m => m && typeof m === 'object')) {
      assert.ok(metric.numerator <= metric.denominator);
      assert.equal(metric.value, metric.denominator ? Number((metric.numerator / metric.denominator).toFixed(4)) : null);
    }
    assert.equal(scope.candidate_generation_recall.denominator, scope.true_pairs);
    assert.equal(scope.automatic_link_precision.denominator, scope.automatic_pairs);
    assert.equal(scope.false_negatives, scope.true_pairs - scope.candidate_generation_recall.numerator);
  }
  assert.equal(r.identity.overall.false_positive_automatic_links, 0);
  assert.equal(r.contradictory_pairs.automatically_linked, 0, 'contradictory pairs are never linked automatically');
  assert.equal(r.hard_negatives.automatically_linked, 0, 'look-alike people are never linked automatically');
  assert.ok(r.identity.without_shared_identifier.automatic_pairs === 0, 'ambiguous name-only pairs stay unresolved');
  const l = r.lineage;
  assert.equal(l.corrections_with_reference.superseded_wrong_record, 0);
  assert.equal(l.corrections_with_reference.superseded_correct_version, l.corrections_with_reference.rows);
  assert.equal(l.corrections_without_reference.accepted_automatically, 0, 'corrections without a reference always wait for a reviewer');
  assert.equal(l.reference_reuse_rows.wrongly_superseded_another_student, 0);
  assert.equal(l.unchanged_reimport.new_open_findings, 0); assert.equal(l.unchanged_reimport.new_notification_items, 0);
  assert.equal(l.identity_links_involving_superseded_records, 0, 'corrected records are evaluated on the latest version only');
  assert.ok(r.late_contradictions.every(x => x.linked_before !== 'auto_linked' || (x.after !== 'auto_linked' && x.withdrawn_flag)));
});

test('precision, recall and F1 on hand-labelled pairs', () => {
  // 4 true pairs; automatic: 2 true + 1 false; review: 1 true + 1 false; 1 true pair missed.
  const p = (same, auto, review) => ({ same, auto, review });
  const s = scorePairs([p(true, true, false), p(true, true, false), p(false, true, false), p(true, false, true), p(false, false, true), p(true, false, false)]);
  assert.deepEqual([s.true_pairs, s.automatic_pairs, s.review_pairs], [4, 3, 2]);
  assert.deepEqual(s.automatic_link_precision, { value: 0.6667, numerator: 2, denominator: 3 });
  assert.deepEqual(s.automatic_link_recall, { value: 0.5, numerator: 2, denominator: 4 });
  assert.deepEqual(s.automatic_link_f1, { value: 0.5714, numerator: 4, denominator: 7 }, '2PR/(P+R) = 2·(2/3)·(1/2)/(2/3+1/2) = 4/7');
  assert.deepEqual(s.review_precision, { value: 0.5, numerator: 1, denominator: 2 });
  assert.equal(s.false_positive_automatic_links, 1); assert.equal(s.false_negatives, 1);
  assert.equal(scorePairs([p(false, false, true)]).automatic_link_f1.value, null, 'undefined when there are neither automatic nor true pairs');
  assert.equal(scorePairs([p(true, false, false)]).automatic_link_f1.value, 0, 'zero when nothing is linked automatically');
});

test('F1 on both benchmarks equals the harmonic mean recomputed from the ground-truth labels', () => {
  const r = runIndependentEvaluation({ casesFile: path.join(dir, 'cases-confirmation.json') });
  assert.ok(DEFINITIONS.automatic_link_f1);
  for (const scope of Object.values(r.identity)) {
    const P = scope.automatic_link_precision; const R = scope.automatic_link_recall; const F = scope.automatic_link_f1;
    assert.equal(F.numerator, 2 * P.numerator); assert.equal(F.denominator, scope.automatic_pairs + scope.true_pairs);
    if (P.value && R.value) assert.ok(Math.abs(F.value - (2 * P.numerator / P.denominator) * (P.numerator / R.denominator) / (P.numerator / P.denominator + P.numerator / R.denominator)) < 1e-4);
  }
  // Development benchmark: recount from each row's labelled truth, not from the reported metrics.
  const { records, pairs } = buildPairDataset();
  const score = scoreBenchmark(buildIdentityLinks(records), pairs);
  const rows = score.rows; const correct = rows.filter(x => x.got === 'auto' && x.truth === 'same').length;
  const precision = correct / rows.filter(x => x.got === 'auto').length; const recall = correct / rows.filter(x => x.truth === 'same').length;
  assert.equal(score.overall.auto_f1, Number((2 * precision * recall / (precision + recall)).toFixed(4)));
});

test('no data leakage: the pipeline sees only the submitted columns, and no production code reads labels or the benchmark', () => {
  const HEADERS = ['apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
  for (const file of ['cases.json', 'cases-confirmation.json']) {
    const cases = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const people = new Set(cases.people.map(x => x.person_id));
    for (const row of cases.rows) {
      assert.deepEqual(Object.keys(row.values).filter(k => !HEADERS.includes(k)), [], 'only submitted columns are imported');
      for (const v of [row.source_reference, ...Object.values(row.values)]) assert.ok(!people.has(v) && !String(v).includes(row.truth.person_id), 'no label is carried in a submitted value');
    }
  }
  const runner = fs.readFileSync(path.join(dir, 'evaluate.js'), 'utf8');
  assert.match(runner, /rows: g\.rows\.map\(r => \(\{ source_reference: r\.source_reference, \.\.\.r\.values \}\)\)/, 'the runner passes only source_reference and values to the pipeline');
  const files = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
  for (const file of [...files(path.join(__dirname, '..', 'src')), path.join(__dirname, '..', 'server.js')]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /person_id|source_key|identity-holdout|require\(['"][./]*bench/, `${path.basename(file)} does not read benchmark labels`);
  }
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'identity.js'), 'utf8'), /version: 'auto-link-2'/, 'the matching policy is unchanged');
});

test('a finding explanation cached before a correction is not reused once the correction changes its evidence', async () => {
  const HEADERS = ['source_reference', 'apaar_id', 'student_name', 'date_of_birth', 'institution_code', 'programme', 'academic_session', 'enrolment_status'];
  const db = { version: 1, institutions: [{ code: 'NITM', name: 'N' }, { code: 'SVU', name: 'S' }], importBatches: [], sourceRecords: [], capacityRules: [], findings: [], auditEvents: [] };
  let clock = Date.parse('2026-11-02T09:00:00.000Z');
  const load = (inst, rows, file) => commitImport(db, { parsed: { headers: HEADERS, rows: rows.map(r => ({ institution_code: inst, programme: 'BTECH CSE', academic_session: '2026-27', enrolment_status: 'Active', apaar_id: '', source_reference: '', ...r })), row_numbers: rows.map((_, i) => i + 2) }, mapping: Object.fromEntries(HEADERS.map(h => [h, h])), batchInstitution: inst, multiInstitution: false, filename: file, at: new Date(clock += 60000).toISOString() });
  load('NITM', [{ source_reference: 'N-1', student_name: 'Uma Sinha', date_of_birth: '01/01/2004' }], 'n.csv');
  load('SVU', [{ student_name: 'Uma Sinha', date_of_birth: '01/01/2004' }], 's.csv');
  const finding = db.findings.find(f => isCurrent(f) && f.rule_code === 'CANDIDATE_IDENTITY_MATCH');
  const explanation = { summary: 'Two records share a name and date of birth; neither has an identifier.', what_it_indicates: 'They may describe one student.', what_it_does_not_establish: 'It does not establish identity; nothing has been verified.', suggested_next_step: 'Request identifiers.' };
  let calls = 0;
  const ok = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'ollama' }, transport: async () => { calls++; return { model: 'stub', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(explanation) }], usage: {} }; } });
  assert.equal((await assistFinding(db, finding, ok)).result.explanation.source, 'model');
  assert.equal((await assistFinding(db, finding, ok)).result.explanation.cached, true);
  // NITM corrects the programme of its record; the candidate condition is unchanged, so the finding
  // stays current with the corrected record added to its evidence.
  load('NITM', [{ source_reference: 'N-1', student_name: 'Uma Sinha', date_of_birth: '01/01/2004', programme: 'BTECH ECE' }], 'n-corrected.csv');
  const after = db.findings.find(f => isCurrent(f) && f.rule_code === 'CANDIDATE_IDENTITY_MATCH');
  const failing = createProvider({ env: { EDUTRACE_AI_PROVIDER: 'ollama' }, transport: async () => ({ status: 503, json: { error: { type: 'overloaded', message: 'busy' } }, retry_after: null, raw_is_json: true }), sleep: async () => {} });
  const result = (await assistFinding(db, after, failing)).result.explanation;
  assert.equal(result.source, 'deterministic', 'the stale model explanation is not presented after the correction');
  if (after === finding) assert.ok(result.stale_model_explanation_withheld);
  assert.equal(calls, 1);
});
