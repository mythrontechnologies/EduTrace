// Independent identity evaluation on the held-out synthetic sets in bench/identity-holdout/.
// Usage: npm run evaluate:independent [-- --write]
//   Runs the development hold-out (seed 8128) and the confirmation set (seed 52711, not inspected
//   while the system was being adjusted). --write saves docs/identity-independent-evaluation.json.
const fs = require('node:fs');
const path = require('node:path');
const { runIndependentEvaluation, DEFINITIONS } = require('../bench/identity-holdout/evaluate');

const dir = path.join(__dirname, '..', 'bench', 'identity-holdout');
const sets = [['development_holdout', 'cases.json'], ['confirmation_set', 'cases-confirmation.json']].filter(([, f]) => fs.existsSync(path.join(dir, f)));
const results = Object.fromEntries(sets.map(([name, file]) => [name, runIndependentEvaluation({ casesFile: path.join(dir, file) })]));
const fmt = m => (m && typeof m === 'object' && 'value' in m ? `${m.value == null ? '—' : `${(m.value * 100).toFixed(1)}%`} (${m.numerator}/${m.denominator})` : m);
for (const [name, r] of Object.entries(results)) {
  console.log(`\n${name} — ${r.dataset.rows} rows, ${r.dataset.people} people, ${r.dataset.source_records_compared} source records compared`);
  console.table(Object.fromEntries(Object.entries(r.identity).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, fmt(b)]))])));
  console.log(`Hard negatives auto-linked: ${r.hard_negatives.automatically_linked} of ${r.hard_negatives.pairs} · contradictory pairs auto-linked: ${r.contradictory_pairs.automatically_linked} of ${r.contradictory_pairs.pairs}`);
  console.log(`Lineage: ${JSON.stringify(r.lineage)}`);
  console.log(`Late contradictions: ${JSON.stringify(r.late_contradictions)}`);
}
if (process.argv.includes('--write')) {
  const out = path.join(__dirname, '..', 'docs', 'identity-independent-evaluation.json');
  fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), definitions: DEFINITIONS, note: 'The development hold-out was examined while fixing the evaluation code and one lineage heuristic (malformed-to-valid identifier corrections); the confirmation set was generated afterwards with a new seed and not used for any adjustment.', ...results }, null, 2));
  console.log(`\nWritten to ${path.relative(process.cwd(), out)}`);
}
