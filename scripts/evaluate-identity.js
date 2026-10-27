// Identity-resolution benchmark on labelled synthetic data.
// Usage: npm run evaluate:identity [-- --local-ai] [-- --json] [-- --write]
//   --local-ai  also asks the local Ollama model (default gemma4:e4b) to explain every review pair,
//               and reports how many explanations passed validation. Without it no model is called.
//   --write     writes docs/identity-evaluation.json
const fs = require('node:fs');
const path = require('node:path');
const { runIdentityBenchmark } = require('../src/identity-benchmark');
const { createProvider } = require('../src/ai-provider');

const pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
(async () => {
  const provider = process.argv.includes('--local-ai') ? createProvider({ env: { ...process.env, EDUTRACE_AI_PROVIDER: 'ollama', EDUTRACE_AI_CALLS_PER_MINUTE: '600' } }) : null;
  const r = await runIdentityBenchmark({ provider, sizes: [1000, 3000, 6000] });
  if (process.argv.includes('--write')) {
    const out = path.join(__dirname, '..', 'docs', 'identity-evaluation.json');
    fs.writeFileSync(out, JSON.stringify(r, null, 2));
    console.log(`Written to ${path.relative(process.cwd(), out)}`);
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`Identity-resolution benchmark — ${r.data}\n${r.caution}\n`);
  const row = (m) => ({ 'candidate recall': pct(m.candidate_generation_recall), 'auto links': m.auto_links, 'auto precision': pct(m.auto_precision), 'auto F1': pct(m.auto_f1), 'auto recall (all same)': pct(m.auto_recall_all_same), 'auto recall (eligible)': pct(m.auto_recall_policy_eligible), 'false auto links': m.false_positive_auto_links, 'review precision': pct(m.candidate_precision), 'review recall': pct(m.candidate_recall), 'contradictions auto-linked': m.contradictory_pairs_auto_linked, 'inconclusive kept unlinked': m.inconclusive_correctly_not_linked });
  console.table({ [`baseline ${r.baseline.policy}`]: row(r.baseline.overall), [`current ${r.current.policy}`]: row(r.current.overall) });
  console.log('Exact-identifier pairs'); console.table({ baseline: row(r.baseline.exact_identifier_pairs), current: row(r.current.exact_identifier_pairs) });
  console.log('Pairs without a shared usable identifier'); console.table({ baseline: row(r.baseline.fuzzy_pairs), current: row(r.current.fuzzy_pairs) });
  console.log('By scenario (outcome agrees with the labelled expectation)');
  console.table(Object.fromEntries(r.current.by_scenario.map((s, i) => [s.scenario, { title: s.title, expected: s.expected, baseline: `${r.baseline.by_scenario[i].matches_expected}/${s.pairs}`, current: `${s.matches_expected}/${s.pairs}` }])));
  console.log(`Checks — baseline: ${JSON.stringify(r.baseline.checks)}\n         current:  ${JSON.stringify(r.current.checks)}`);
  console.log(`Unexpected surfaced pairs — baseline ${r.baseline.unexpected_surfaced_pairs}, current ${r.current.unexpected_surfaced_pairs}\n`);
  console.log('Pipeline scenarios (current system)');
  r.pipeline.forEach(p => console.log(`  ${p.passed ? 'PASS' : 'FAIL'} ${p.scenario} ${p.title}: ${JSON.stringify(p.observed)}${p.note ? `\n       ${p.note}` : ''}`));
  console.log('\nLatency');
  console.table(r.latency);
  console.log(`\nModel explanations: ${typeof r.ai_explanations.status === 'string' ? r.ai_explanations.status : JSON.stringify(r.ai_explanations)}`);
})();
