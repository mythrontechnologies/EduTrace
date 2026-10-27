// Controlled real-provider test on small synthetic fixtures (no demo or production records).
// Usage: npm run ai:live-test [-- --write]
// Requires EDUTRACE_AI_PROVIDER=anthropic and ANTHROPIC_API_KEY in the environment; the
// candidate task additionally requires EDUTRACE_AI_SHARE_NAMES=true. Without configuration
// nothing is sent and the test is reported as pending.
const fs = require('node:fs');
const path = require('node:path');
const { createProvider } = require('../src/ai-provider');
const { suggestMapping } = require('../src/pipeline');
const { SCHEMA_CASES, parsedCase } = require('../src/ai-evaluation');
const { buildEvaluationState } = require('../src/evaluation');
const { explanationInput, candidateInput } = require('../src/assist');
const { isCurrent } = require('../src/engine');

(async () => {
  const provider = createProvider();
  const status = provider.status();
  if (!status.configured) {
    console.log(`PENDING: no real model request was sent. ${status.reason}`);
    console.log('Set EDUTRACE_AI_PROVIDER=anthropic and ANTHROPIC_API_KEY (and EDUTRACE_AI_SHARE_NAMES=true for the candidate task), then re-run.');
    return;
  }
  console.log(`Provider ${status.provider_label}, model ${status.model}${status.local ? `, server ${status.settings.base_url}` : `, effort ${status.settings.effort}, API version ${status.settings.api_version}`}`);
  const report = { generated_at: new Date().toISOString(), model: status.model, settings: status.settings, tasks: {} };

  const check = await provider.check();
  report.health_check = check;
  console.log(`Health check: ${check.health.label}${check.reason ? ` — ${check.reason}` : ''}`);

  // 1. Ambiguous schema mapping (synthetic headers and values; only header names and shapes are sent).
  const schemaCase = SCHEMA_CASES.find(c => c.id === 'S02');
  const mapping = await suggestMapping(parsedCase(schemaCase), provider);
  const truth = Object.fromEntries(schemaCase.columns.map(([h, field]) => [h, field]));
  report.tasks.schema_interpretation = { sent: mapping.model.sent, used: mapping.model.used, note: mapping.model.note, latency_ms: mapping.model.latency_ms, usage: mapping.model.usage, accepted: mapping.model.suggestions.map(s => ({ ...s, correct: truth[s.header] === s.field })), rejected_by_validation: mapping.model.rejected, final_mapping: mapping.mapping, sources: mapping.sources };

  // 2. Explanation of a persisted synthetic finding.
  const { db } = buildEvaluationState();
  const f = db.findings.find(x => isCurrent(x) && x.rule_code === 'IDENTIFIER_ATTRIBUTE_CONFLICT');
  const input = explanationInput(db, f);
  const explained = await provider.run('finding_explanation', input);
  report.tasks.finding_explanation = { rule_code: f.rule_code, sent_fields: Object.keys(input), ok: explained.ok, output: explained.output || null, reason: explained.reason || null, provenance: explained.provenance || null };

  // 3. Ambiguous name-only candidate (only with explicit name-sharing permission).
  if (status.tasks.candidate_assessment.available) {
    const c = db.findings.find(x => isCurrent(x) && x.rule_code === 'CANDIDATE_IDENTITY_MATCH' && x.evidence.length === 2);
    const assessed = await provider.run('candidate_assessment', candidateInput(db, c));
    report.tasks.candidate_assessment = { ok: assessed.ok, output: assessed.output || null, reason: assessed.reason || null, provenance: assessed.provenance || null, applied: false };
  } else report.tasks.candidate_assessment = { skipped: status.tasks.candidate_assessment.reason };

  report.health_after = provider.status().health;
  report.usage = provider.status().usage;
  report.rate_limits = provider.status().rate_limits;
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--write')) {
    const out = path.join(__dirname, '..', 'docs', 'ai-live-test-results.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`Written to ${path.relative(process.cwd(), out)}`);
  }
})();
