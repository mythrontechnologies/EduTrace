// Runs the labelled synthetic evaluation in memory (no database file is read or written)
// and prints the measured results. Usage: npm run evaluate [-- --json]
const { runEvaluation } = require('../src/evaluation');
const result = runEvaluation();
if (process.argv.includes('--json')) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }
const pct = v => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const { dataset: d, processing: p, identity: i, detection: x, repeated_processing: r } = result;
console.log(`EduTrace reconciliation evaluation — ${d.rows} synthetic rows, ${d.persisted_records} persisted records, ${d.people} people (seed ${d.seed})`);
console.log(d.note + '\n');
console.log('Processing');
console.table({ ...p.by_status, processing_failed: p.processing_failed });
console.log(`Automatic processing rate: ${pct(p.automatic_processing_rate)} (${p.automatic_processing_rate_definition})`);
console.log(`Records built to be routine: ${p.expected_automatic_records}; processed automatically: ${p.expected_automatic_processed_automatically}; automatic but not routine: ${p.unexpectedly_automatic}\n`);
console.log('Identity resolution (record pairs)');
console.table({
  'automatic links': { pairs: i.automatic_links.pairs, correct: i.automatic_links.correct, precision: pct(i.automatic_links.precision), recall: pct(i.automatic_links.recall) },
  'review flags': { pairs: i.review_flags.pairs, correct: i.review_flags.same_student, precision: pct(i.review_flags.pairs ? i.review_flags.same_student / i.review_flags.pairs : null), recall: '' },
  'linked or flagged': { pairs: i.coverage_any_outcome.pairs_linked_or_flagged, correct: '', precision: '', recall: pct(i.coverage_any_outcome.recall) }
});
console.log(`True same-student pairs: ${i.true_same_student_pairs}. Automatic false-positive rate: ${i.false_positive_rate_automatic.false_links} of ${i.false_positive_rate_automatic.evaluated_non_matching_pairs} evaluated non-matching pairs (${pct(i.false_positive_rate_automatic.rate)}). Identifier collisions auto-linked: ${i.identifier_collisions_auto_linked}.\n`);
console.log('Detection');
console.table({ 'missing identifier': x.missing_identifier, 'malformed identifier': x.malformed_identifier, 'missing required values (rows)': { labelled: x.missing_required_values.labelled_rows, detected: x.missing_required_values.rejected_with_reason, recall: x.missing_required_values.recall } });
console.log(`Validation findings on records not labelled with an identifier problem: ${x.validation_findings_on_unlabelled_records}`);
console.table(Object.fromEntries(Object.entries(x.exceptions).map(([k, v]) => [k, { ...v, rate: pct(v.labelled_cases ? v.detected_cases / v.labelled_cases : null) }])));
console.log('Repeated processing');
console.log(`Revalidation runs: ${JSON.stringify(r.revalidation_runs)}`);
console.table(r.reimport_of_identical_file);
