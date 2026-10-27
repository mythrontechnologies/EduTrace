// Compares the deterministic baseline with model assistance on labelled synthetic data.
// Usage: npm run ai:evaluate [-- --json] [-- --write]
// Without a configured provider only the baseline is measured; model figures are reported as pending.
const fs = require('node:fs');
const path = require('node:path');
const { runAiEvaluation } = require('../src/ai-evaluation');
const { createProvider } = require('../src/ai-provider');

(async () => {
  const provider = createProvider();
  // One synthetic health request first: a configuration error then costs one call, not the whole run.
  if (provider.configured) {
    const check = await provider.check();
    if (!check.ok) {
      console.log(`Health check failed, so the model evaluation was not run: ${check.reason}`);
      console.log(JSON.stringify(check.health.last_error, null, 2));
      process.exitCode = 1;
      return;
    }
  }
  const r = await runAiEvaluation(provider);
  if (process.argv.includes('--write')) {
    const out = path.join(__dirname, '..', 'docs', 'ai-evaluation-results.json');
    fs.writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(`Written to ${path.relative(process.cwd(), out)}`);
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  const p = r.provider;
  console.log(`AI value evaluation — provider: ${p.configured ? `${p.provider} ${p.model} (effort ${p.settings.effort})` : 'none'}`);
  console.log(r.note + '\n');
  const s = r.schema_mapping;
  console.log(`Schema mapping: ${s.cases} labelled files × ${s.fields_scored_per_file} fields`);
  console.table(Object.fromEntries([['deterministic baseline', s.baseline], ...(typeof s.model_assisted === 'object' ? [['baseline + validated model', s.model_assisted]] : [])].map(([k, v]) => [k, { correct: v.mapped_correctly, wrong: v.mapped_wrongly, unmapped: v.left_unmapped, 'correct abstentions': v.correct_abstentions, precision: v.precision, recall: v.recall, 'files ready': `${v.files_ready_without_manual_mapping}/${v.files}` }])));
  if (s.model) {
    console.log(`Model: ${s.model.calls} calls, ${s.model.accepted_suggestions} suggestions accepted (${s.model.accepted_correct} correct, ${s.model.accepted_wrong} wrong), ${s.model.rejected_by_validation} rejected by validation (${s.model.rejected_that_would_have_been_correct} of which were correct), ${s.model.failed_calls.length} failed calls.`);
    console.log(`Latency: ${JSON.stringify(s.model.latency)}  Usage: ${JSON.stringify(s.model.usage)}`);
  } else console.log(`Model-assisted mapping: ${s.model_assisted}`);
  const i = r.identity_candidates;
  console.log(`\nIdentity candidates: ${i.candidate_pairs} name-only pairs (${i.same_person} same person, ${i.different_people} different). Deterministic: ${i.deterministic_outcome}`);
  console.log(`Abbreviated-name pairs never flagged as candidates (the model never sees them): ${i.abbreviated_name_pairs_never_flagged}`);
  console.log(typeof i.model === 'string' ? `Model: ${i.model}` : `Model: ${JSON.stringify(i.model)}\nModel changed links or findings: ${i.model_changed_links_or_findings}`);
  const nv = r.name_variants;
  console.log(`\nName variants: ${nv.pairs} labelled pairs (${nv.same_person} same person, ${nv.different_people} different); the engine would flag ${nv.engine_would_flag} (${nv.engine_would_flag_same_person} of them the same person) and decides none.`);
  console.log(typeof nv.model === 'string' ? `Model: ${nv.model}` : `Model: ${nv.model.decided_correctly}/${nv.model.decided} decided correctly, ${nv.model.insufficient_evidence} insufficient evidence, ${nv.model.said_same_but_different_people} said "same" for different people, ${nv.model.invalid.length} invalid; latency ${JSON.stringify(nv.model.latency)}`);
  const e = r.explanations;
  console.log(`\nExplanations: ${typeof e.model === 'string' ? e.model : `${e.passed_validation}/${e.findings} passed schema and grounding validation; rejected: ${JSON.stringify(e.rejected)}; latency ${JSON.stringify(e.latency)}; usage ${JSON.stringify(e.usage)}; changed findings: ${e.model_changed_findings}`}`);
  console.log(`\nProvider health after run: ${r.health_after_run.label}${r.health_after_run.last_error ? ` (last error: ${r.health_after_run.last_error.kind} — ${r.health_after_run.last_error.message})` : ''}`);
})();
