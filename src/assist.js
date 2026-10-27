// Model assistance for one persisted finding: a plain-language explanation and, for name-only
// candidate matches, an advisory name assessment.
//
// The model only ever sees what the finding actually rests on: the rule, its persisted
// explanation, and a summary of the cited source records (institution, file row, programme,
// session, status, identifier check). Names, identifiers and dates of birth are never part of
// the explanation input. Results are advisory, stored with provenance under a cache key, and
// never change the finding, its review status or any identity link.
//
// Cache key = template version (prompt + schema) + model + rule id and version + finding id +
// a hash of every cited source record's content + the exact input. When any of these change,
// the stored explanation is stale: it is regenerated when a provider is available, and is
// otherwise withheld (never shown as current).
const crypto = require('node:crypto');
const { TASK_VERSIONS } = require('./ai-provider');
const { assessFinding } = require('./assessment');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const EVIDENCE_LIMIT = 10;

function evidenceRecords(db, f) { return f.evidence.map(id => db.sourceRecords.find(r => r.id === id)).filter(Boolean); }
// Record content as persisted, without the processing summary (recomputed on every run).
function recordHash(r) { const { processing, ...content } = r; return sha(JSON.stringify(content)).slice(0, 16); }

function explanationInput(db, f) {
  const records = evidenceRecords(db, f);
  const links = (db.identityLinks || []).filter(l => (f.identity_link_ids || []).includes(l.id));
  return {
    rule_code: f.rule_code, rule_version: f.rule_version || null, rule_title: f.title, rule_explanation: assessFinding(db, f).summary,
    category: f.category, severity: f.severity, review_status: f.review_status, processing_outcome: f.automation?.outcome || null,
    record_count: records.length, institution_count: new Set(records.map(r => r.institution_code)).size,
    evidence: records.slice(0, EVIDENCE_LIMIT).map(r => ({ institution_code: r.institution_code, source_row: r.source_row, programme: r.programme, academic_session: r.academic_session, enrolment_status: r.enrolment_status, identifier_check: r.processing?.identifier_check || null })),
    evidence_truncated: records.length > EVIDENCE_LIMIT,
    match_method: links[0]?.method || null, match_score: links[0]?.score ?? null,
    agreeing_fields: [...new Set(links.flatMap(l => l.agreeing_fields))], conflicting_fields: [...new Set(links.flatMap(l => l.conflicting_fields))], missing_fields: [...new Set(links.flatMap(l => l.missing_fields))],
    authoritative_verification: 'not available'
  };
}

function cacheKey(db, f, task, input, model) {
  return sha(JSON.stringify({ template: TASK_VERSIONS[task], model, rule: f.rule_code, rule_version: f.rule_version || null, finding: f.id, evidence: evidenceRecords(db, f).map(r => [r.id, recordHash(r)]).sort(), input }));
}

function candidateInput(db, f) {
  const records = evidenceRecords(db, f);
  const links = (db.identityLinks || []).filter(l => (f.identity_link_ids || []).includes(l.id));
  return { name_a: records[0].student_name, name_b: records[1].student_name, date_of_birth_agrees: records[0].date_of_birth === records[1].date_of_birth, same_institution: records[0].institution_code === records[1].institution_code, identifiers: 'missing on at least one record', name_token_similarity: links[0]?.name_similarity ?? null };
}

// Returns { result, changed } — `changed` tells the caller the finding's stored assistance changed
// and should be saved. Never throws (the provider never throws).
async function assistFinding(db, f, provider) {
  const status = provider.status();
  const input = explanationInput(db, f);
  const deterministic = { source: 'deterministic', summary: assessFinding(db, f).summary, suggested_next_step: f.automation?.required_action || f.recommended_action };
  const key = cacheKey(db, f, 'finding_explanation', input, status.model);
  let changed = false;
  let explanation;
  const cached = f.assist?.explanation;
  const stale = cached && cached.cache_key !== key;
  if (cached && !stale) explanation = { ...cached, cached: true };
  else {
    const result = await provider.run('finding_explanation', input);
    if (result.ok) {
      explanation = { source: 'model', ...result.output, provenance: result.provenance, cache_key: key };
      f.assist = { ...(f.assist || {}), explanation };
      changed = true;
      if (stale) explanation = { ...explanation, replaced_stale: true };
    } else {
      explanation = { ...deterministic, model_unavailable_reason: result.reason };
      if (stale) {
        // Never present an explanation of evidence that has since changed.
        explanation.stale_model_explanation_withheld = { generated_at: cached.provenance?.generated_at || null, reason: 'The finding\'s evidence, rule, prompt or model changed after it was generated.' };
        delete f.assist.explanation;
        changed = true;
      }
    }
  }

  let candidate = null;
  if (f.rule_code === 'CANDIDATE_IDENTITY_MATCH' && evidenceRecords(db, f).length === 2) {
    const cInput = candidateInput(db, f);
    const cKey = cacheKey(db, f, 'candidate_assessment', cInput, status.model);
    const stored = f.assist?.candidate_assessment;
    if (stored && stored.cache_key === cKey) candidate = { ...stored, cached: true };
    else {
      const result = await provider.run('candidate_assessment', cInput);
      if (result.ok) {
        candidate = { source: 'model', ...result.output, provenance: result.provenance, cache_key: cKey, effect: 'Advisory only — the records stay unlinked until a reviewer records a decision.' };
        f.assist = { ...(f.assist || {}), candidate_assessment: candidate };
        changed = true;
      } else {
        candidate = { source: 'unavailable', reason: result.reason };
        if (stored) { delete f.assist.candidate_assessment; changed = true; }
      }
    }
  }
  const strip = value => value && (({ cache_key, ...rest }) => rest)(value);
  return { changed, result: { explanation: strip(explanation), candidate_assessment: strip(candidate), sent_fields: Object.keys(input), ai: { provider: status.provider, model: status.model, configured: status.configured, health: status.health, data_policy: status.data_policy } } };
}

// The rule-text explanation alone, for a read-only request: no provider call and no stored model
// output is read, written or removed. Stored model output is not shown, because it cannot be
// re-checked against the current evidence without the cache path above.
function deterministicAssist(db, f, provider) {
  const status = provider.status();
  const reason = status.reason || 'Model assistance is not used for read-only requests.';
  const explanation = { source: 'deterministic', summary: assessFinding(db, f).summary, suggested_next_step: f.automation?.required_action || f.recommended_action, model_unavailable_reason: reason };
  const candidate = f.rule_code === 'CANDIDATE_IDENTITY_MATCH' && evidenceRecords(db, f).length === 2 ? { source: 'unavailable', reason } : null;
  return { explanation, candidate_assessment: candidate, sent_fields: Object.keys(explanationInput(db, f)), ai: { provider: status.provider, model: status.model, configured: status.configured, health: status.health, data_policy: status.data_policy } };
}

module.exports = { assistFinding, deterministicAssist, explanationInput, candidateInput, cacheKey, recordHash };
