// Benchmarks local Ollama models on the labelled synthetic AI evaluation (no demo or production records).
// Usage: npm run ai:benchmark-local [-- --models=gemma4:e4b,qwen2.5-coder:7b] [-- --runs=2] [-- --write]
// Every request goes to the Ollama server on this machine. The candidate task uses the synthetic names
// of the labelled evaluation, so name sharing is enabled for this run only; nothing leaves the machine.
// Each model gets one warm-up health check (which includes loading the model), then the full
// evaluation is repeated to measure whether the same input gives the same validated answer.
const fs = require('node:fs');
const path = require('node:path');
const { createProvider } = require('../src/ai-provider');
const { runAiEvaluation } = require('../src/ai-evaluation');

const arg = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').split('=')[1] || fallback;
const baseUrl = process.env.EDUTRACE_OLLAMA_URL || 'http://localhost:11434';
const runs = Math.min(Math.max(Number(arg('runs', 2)) || 2, 1), 5);

const share = (a, b) => (b ? Number((a / b).toFixed(4)) : null);
// Fraction of items whose validated answer was identical in every run.
function agreement(runsOfItems) {
  const keys = Object.keys(runsOfItems[0] || {});
  const same = keys.filter(k => runsOfItems.every(r => JSON.stringify(r[k]) === JSON.stringify(runsOfItems[0][k])));
  return { items: keys.length, identical_in_every_run: same.length, rate: share(same.length, keys.length), differing: keys.filter(k => !same.includes(k)) };
}
const schemaItems = r => Object.fromEntries(r.schema_mapping.per_case.map(c => [c.case, {
  accepted: r.schema_mapping.model.accepted.filter(s => s.case === c.case).map(s => `${s.field}=${s.header}`).sort(),
  rejected: r.schema_mapping.model.rejected.filter(s => s.case === c.case).map(s => `${s.field}=${s.header}`).sort(),
  failed: r.schema_mapping.model.failed_calls.some(f => f.case === c.case)
}]));
const identityItems = r => Object.fromEntries((r.identity_candidates.model.per_pair || []).map(p => [`pair ${p.pair}`, p.ok ? p.assessment : 'invalid']));
const explanationItems = r => Object.fromEntries(r.explanations.per_rule.map(x => [x.rule_code, x.ok ? x.output : `invalid: ${x.rejected_because}`]));
const explanationValidity = r => Object.fromEntries(r.explanations.per_rule.map(x => [x.rule_code, x.ok]));
const baselineItems = r => ({ schema: r.schema_mapping.baseline, per_case: r.schema_mapping.per_case.map(c => c.baseline) });

(async () => {
  let installed;
  try { installed = (await (await fetch(`${baseUrl}/api/tags`)).json()).models.map(m => ({ name: m.name, size_gb: Number((m.size / 1e9).toFixed(1)), parameters: m.details?.parameter_size, quantization: m.details?.quantization_level })); }
  catch (error) { console.log(`No benchmark was run: the Ollama server at ${baseUrl} could not be reached (${error.cause?.code || error.message}).`); process.exitCode = 1; return; }
  const models = arg('models', installed.map(m => m.name).join(',')).split(',').filter(Boolean);
  const report = { generated_at: new Date().toISOString(), server: baseUrl, installed, runs_per_model: runs, data: 'Labelled synthetic evaluation only (12 schema cases, 7 engine-flagged candidate pairs, 12 name-variant pairs, one finding per rule).', models: {} };

  for (const model of models) {
    if (!installed.some(m => m.name === model)) { report.models[model] = { skipped: 'not installed (no model is downloaded by this script)' }; continue; }
    const env = { EDUTRACE_AI_PROVIDER: 'ollama', EDUTRACE_OLLAMA_URL: baseUrl, EDUTRACE_AI_MODEL: model, EDUTRACE_AI_SHARE_NAMES: 'true', EDUTRACE_AI_CALLS_PER_MINUTE: '600' };
    console.log(`\n${model}: warm-up health check…`);
    const warm = createProvider({ env });
    const started = Date.now();
    const check = await warm.check();
    const entry = { warm_up: { ok: check.ok, wall_ms: Date.now() - started, reason: check.reason }, runs: [] };
    report.models[model] = entry;
    console.log(`  ${check.ok ? 'answered and validated' : `failed: ${check.reason}`} in ${entry.warm_up.wall_ms} ms`);
    // Only an unreachable server or a missing model stops the benchmark; an answer that fails
    // validation is a result to record, not a reason to skip the model.
    if (!check.ok && ['network', 'timeout', 'not_found', 'authentication', 'permission', 'invalid_request'].includes(check.health.last_error?.kind)) continue;
    for (let i = 0; i < runs; i++) {
      const provider = createProvider({ env });
      const t = Date.now();
      const r = await runAiEvaluation(provider);
      entry.runs.push({ wall_ms: Date.now() - t, result: r });
      const s = r.schema_mapping; const id = r.identity_candidates.model; const nv = r.name_variants.model; const ex = r.explanations;
      console.log(`  run ${i + 1}: ${Math.round((Date.now() - t) / 1000)} s · schema ${s.model_assisted.mapped_correctly} correct / ${s.model_assisted.mapped_wrongly} wrong (baseline ${s.baseline.mapped_correctly}/${s.baseline.mapped_wrongly}), ${s.model.failed_calls.length} invalid calls · candidates ${id.decided_correctly}/${id.decided} decided correctly, ${id.insufficient_evidence} insufficient, ${id.failed.length} invalid · name variants ${nv.decided_correctly}/${nv.decided} decided correctly, ${nv.insufficient_evidence} insufficient, ${nv.said_same_but_different_people} false "same", ${nv.invalid.length} invalid · explanations ${ex.passed_validation}/${ex.findings} valid`);
    }
    if (!entry.runs.length) continue;
    const results = entry.runs.map(x => x.result);
    entry.consistency = {
      baseline: agreement(results.map(r => ({ baseline: baselineItems(r) }))),
      schema_suggestions: agreement(results.map(schemaItems)),
      identity_assessments: agreement(results.map(identityItems)),
      name_variant_assessments: agreement(results.map(r => Object.fromEntries(r.name_variants.model.per_pair.map(p => [p.case, p.ok ? p.assessment : 'invalid'])))),
      explanation_validity: agreement(results.map(explanationValidity)),
      explanation_text: agreement(results.map(explanationItems))
    };
    console.log(`  consistency: schema ${entry.consistency.schema_suggestions.rate}, candidates ${entry.consistency.identity_assessments.rate}, name variants ${entry.consistency.name_variant_assessments.rate}, explanation validity ${entry.consistency.explanation_validity.rate}, explanation text ${entry.consistency.explanation_text.rate}`);
  }

  if (process.argv.includes('--write')) {
    const out = path.join(__dirname, '..', 'docs', 'ai-local-benchmark.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\nWritten to ${path.relative(process.cwd(), out)}`);
  }
})();
