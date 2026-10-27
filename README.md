# EduTrace AI

EduTrace AI is a local, synthetic-data-only prototype for SIH26263. It provides a real Node.js processing path: CSV preview and mapping, provenance-preserving normalisation, local identifier validation, explainable identity resolution, automated processing of routine records under a documented policy, an exception-first notification queue, explainable reconciliation findings, review audit decisions, role-scoped queries, a CSV report, and a relationship graph. Model assistance is optional and off by default; see [AI and automated reconciliation](#ai-and-automated-reconciliation) for exactly what is and is not AI.

## Verified setup

```powershell
npm install
npm run reset-demo
npm run user -- add --username rev.local --name "Local Reviewer" --role reviewer
npm start
```

Open `http://localhost:3000` and sign in with that account (the command asks for its password; roles are `reviewer`, `auditor`, `institution_admin --institution <code>` and `platform_admin`). Development mode has no default accounts and no role header; accounts are kept in `data/users.json` (scrypt hashes, not committed). The read-only demo (`EDUTRACE_MODE=demo`) needs no account. No external database, secret or network connection is required: the JSON store is the default, and `pg` (runtime) and `embedded-postgres` (tests only) are the only dependencies. To use PostgreSQL instead, see `docs/ORIGINAL_MVP_COMPLETION.md`.

To enable open judge registration for the read-only synthetic walkthrough, start it with `EDUTRACE_MODE=demo` and `EDUTRACE_AUTH=local` (for example, in PowerShell: `$env:EDUTRACE_MODE='demo'; $env:EDUTRACE_AUTH='local'; npm start`). This opt-in mode stores only new reviewer account hashes in the configured local users store; the demo records remain synthetic, in memory and read-only. Public registration does not verify a person's institutional identity, so do not use these demo accounts or the demo dataset for real student records. Without `EDUTRACE_AUTH=local`, the demo keeps its existing simulated viewing scopes and does not show registration.

## Testing and resetting data

```powershell
npm test
npm run evaluate
npm run ai:evaluate
npm run ai:live-test
Get-ChildItem server.js, src\*.js, scripts\*.js, public\*.js, test\*.js | ForEach-Object { node --check $_.FullName }
```

`npm test` runs the Node built-in test runner over `test/` (84 tests): request-handler workflow, import with dry-run/confirm agreement, review, audit feed, import history, graph, search/filter, filtered export, the capacity finding lifecycle, static-asset checks, the automation policy (automatic matching only under policy, conflicts and name-only matches kept as exceptions, withdrawal of an automatic match when evidence changes, idempotent re-import, and notification grouping, scoping and acknowledgement), and model assistance. **Every model-assistance test (`test/ai-provider.test.js`, `test/ai-assist.test.js`) uses a stubbed transport or a stubbed `fetch`; no test contacts Anthropic or a local Ollama server**, and `test-support/isolated-db.js` removes any `EDUTRACE_AI_*`, `EDUTRACE_OLLAMA_URL` or `ANTHROPIC_API_KEY` setting from the test process. They cover the request contract, health states, retries, refusals, timeouts, invalid JSON, schema/language/grounding rejection, key secrecy, explanation-cache invalidation, validation of mapping suggestions, the advisory-only guarantee and the evaluation harness. `npm run evaluate` runs the labelled synthetic evaluation described below, in memory; `npm run ai:evaluate` and `npm run ai:live-test` are described under [Model assistance: status and evidence](#model-assistance-status-and-evidence). There is no separate linter, type checker, or production bundler in this dependency-free JavaScript prototype.

**Tests never touch your working demo data.** Every test file first loads `test-support/isolated-db.js`, which points the app at a throwaway database in the system temp folder (via `EDUTRACE_DB_PATH`) and deletes it when the test process exits. The regression test `test/demo-db-isolation.test.js` re-runs the rest of the suite in a fresh runner and asserts that `data/demo-db.json` is byte-for-byte unchanged afterwards. New test files must load the helper first:

```js
require('../test-support/isolated-db');
```

Resetting the synthetic demo data is always an explicit, separate step. It discards imports, decisions and audit events in the target database:

```powershell
npm run reset-demo
```

To run the app or the reset script against a different database file, set `EDUTRACE_DB_PATH` (for example `$env:EDUTRACE_DB_PATH = "$env:TEMP\edutrace-scratch.json"; npm start`). Database writes go to a temporary file that is then renamed, so an interrupted write cannot leave a truncated database.

## Capacity finding lifecycle

Capacity checks use only intake rules configured in `capacityRules` (institution, programme, academic session and, optionally, `seat_category`). They are prototype settings, not official regulatory limits.

- **Counting.** Active enrolments are counted once per student identity — the same protected identifier, normalised name and date of birth — using that identity's most recent source record. Rows without an identifier are never merged on name and date of birth (two such rows in one file count as two students), but re-importing the same file does not count them again: an identifier-less row is keyed by name, date of birth and its occurrence within its own import batch. Records that share an identifier but disagree on name or date of birth are not merged. A later import that reports a student as withdrawn or transferred therefore reduces the count. (The seeded NITM BTECH CSE cohort has 40 rows but 39 identities, because two rows are a repeated submission.)
- **One current finding per condition.** Each import recomputes every configured rule. If the counted set is unchanged, the existing finding stays current. If it changed and the limit is still exceeded, a new current finding is created with `supersedes`, and the earlier one becomes `lifecycle_status: "superseded"` with `superseded_by`. If the count is now at or below the limit, the finding becomes `lifecycle_status: "cleared"`.
- **History is preserved.** Findings are never deleted. Review status and reviewer decisions on historical findings are kept, and every lifecycle change appends a system audit event (actor *EduTrace reconciliation engine (automated)*). Decisions cannot be recorded on historical findings (HTTP 409); review the current finding instead.
- **Current versus historical.** Dashboard counts, the findings list, the graph and the CSV export cover current findings by default. Pass `lifecycle=historical` or `lifecycle=all` to `/api/v1/findings` or `/api/v1/reports/findings.csv` (the export includes `lifecycle_status` and `superseded_by` columns), or use the **Lifecycle** filter in the reconciliation workspace.
- **Older databases.** A demo database created before this lifecycle existed is migrated once when the app first loads it: legacy capacity findings are recomputed under the counting rule above and superseded if their evidence differs, with an audit event explaining why. Run `npm run reset-demo` instead if you want a clean seeded dataset.

## AI and automated reconciliation

**What is and is not AI.** Every decision EduTrace makes is deterministic: normalisation, identifier format checks, exact protected-identifier comparison, name-token similarity (a word-overlap measure, not a trained model), capacity counting, automatic matching and notifications. No machine-learning model is trained or used for any of them. A language model can optionally be configured for three *advisory* tasks; with no configuration (the default), none is called and the interface says so.

**Optional model provider** (`src/ai-provider.js`). Two providers share one interface: a **local model through Ollama** (the recommended setup, below) and the Anthropic API. Configuration comes only from environment variables; an API key is never logged, stored or returned by any endpoint, and startup never contacts a provider.

**Local model (Ollama).** Run `npm run start:local-ai` with Ollama running. It starts the normal server with `EDUTRACE_AI_PROVIDER=ollama` and the default local model `gemma4:e4b`, chosen from the benchmark below; any of these variables set in the environment take precedence. Requests go only to the Ollama server on this machine: `EDUTRACE_OLLAMA_URL` must be `localhost`, `127.0.0.1` or `[::1]`, otherwise the provider stays disabled. No key is needed and no model is downloaded. Each request goes to `/api/chat` with the task's JSON schema as `format`, `think: false`, `temperature: 0`, a fixed seed and at most 1024 output tokens; the reply passes through exactly the same validation as an Anthropic reply. If Ollama is not running, the server still starts, the status shows *Temporarily unavailable*, and every task uses its deterministic result. `npm start` without these variables keeps model assistance off.

| Variable | Default | Meaning |
| --- | --- | --- |
| `EDUTRACE_AI_PROVIDER` | unset (disabled) | `ollama` for a local model, `anthropic` for the Anthropic Messages API |
| `EDUTRACE_OLLAMA_URL` | `http://localhost:11434` | Local Ollama server; loopback addresses only |
| `ANTHROPIC_API_KEY` | unset | Required for the `anthropic` provider |
| `EDUTRACE_AI_MODEL` | `gemma4:e4b` (ollama), `claude-opus-5-5` (anthropic) | Any installed Ollama model, or any current Claude model id |
| `EDUTRACE_AI_EFFORT` | `low` | `low`/`medium`/`high`/`xhigh`/`max`; these are short, bounded tasks. Not sent to models that reject the parameter (Claude Haiku 4.5, Sonnet 4.5 and older); an explicit value for such a model is listed under `settings.warnings` in the status |
| `EDUTRACE_AI_TIMEOUT_MS` | `120000` (ollama), `60000` (anthropic) | Per request, 1000–120000; the first local call includes loading the model |
| `EDUTRACE_AI_CALLS_PER_MINUTE` | `120` (ollama), `30` (anthropic) | Local call limit |
| `EDUTRACE_AI_SHARE_NAMES` | unset | `true` allows the candidate task to send the two student names to the remote (`anthropic`) provider |
| `EDUTRACE_AI_LOCAL_NAMES` | unset | `true` allows the candidate task to send the two student names to the local `ollama` provider (they stay on this machine). Separate from the remote setting |

Requests use API version `2026-10-21` and structured outputs (`output_config.format` with a JSON schema; forced tool use is not supported by current models), `max_tokens` 16000 because thinking is always on and counts toward it, and server-side refusal fallbacks (`fallbacks: "default"`) on models that support them (Claude Opus 5.5, Opus 5, Fable 5.1, Sonnet 5.5; not Haiku 5.5). The project calls the API over `fetch` rather than the Anthropic SDK to keep its zero-dependency build. Tasks:

| Task | Used for | Sent to the model | Never sent |
| --- | --- | --- | --- |
| `schema_interpretation` | Suggesting a column for fields that header aliases and header similarity could not map | Field names, header names, coarse value shapes such as "12-digit number" or "date" | Cell values |
| `finding_explanation` | The **Explain this finding** button in the evidence drawer | The persisted finding (rule, version, title, its own explanation, severity, review and processing status), and per cited record its institution code, source row, programme, session, status and identifier check | Names, identifiers, dates of birth |
| `candidate_assessment` | A second opinion on a name-only candidate match | The two student names and booleans, only when `EDUTRACE_AI_SHARE_NAMES=true` | Identifiers, dates of birth |

**What a response must pass before it is used.** The JSON must parse and match the task schema exactly (lengths, ranges and extra properties are checked locally because structured outputs do not enforce them). Prose must not use accusatory or "verified/authentic" language, must not contain digit runs, and every number in it must appear in the input it was given (the APAAR length 12 excepted), so an explanation cannot invent counts, rows or values. A mapping suggestion must name a requested field and a header in the file, and is accepted only with confidence ≥ 0.6, for a field and header not already mapped, from a non-empty column whose value shape fits the field (a phone-number column is never accepted as an APAAR ID). A `refusal` or `max_tokens` stop, invalid JSON, HTTP errors and timeouts are all caught; 429, 529, 5xx and network errors are retried once (honouring `retry-after`, at most 5 s). Every failure falls back to deterministic output with the reason shown. Model output is stored with its provenance and **never** changes a finding, a review status, a decision, an identity link or a record; a candidate assessment of "likely the same person" leaves the records unlinked, and only the documented policy can link records automatically.

**Explanation cache.** A stored model explanation is reused only while its cache key matches: the task's prompt/schema template version, the model, the rule id and version, the finding, a hash of every cited source record's content and the exact input. When any of these change the explanation is regenerated; if the provider is unavailable at that moment, the old text is withheld (the drawer says so) and the rule's own explanation is shown instead.

### Model assistance: status and evidence

**Health indicator.** `GET /api/v1/ai/status` (and the **Model assistance** line on the Overview) reports one of: *Not configured*, *Configured, not yet tested*, *Available*, *Temporarily unavailable* (rate limit, overload, server error, timeout or network), *Failed with a recoverable error* (refusal, truncation, invalid or rejected output) or *Failed: check configuration* (authentication, permission, unknown model, or a request the API rejected with HTTP 400, such as an unsupported parameter or an account without credit), with the last error (including the API's own error type and message, with keys, long digit runs and e-mail addresses redacted, and its `request-id`), the latest rate-limit headers, whether it is retried, and per-task call, token and latency counts. The regulator can press **Check connection** (`POST /api/v1/ai/check`), which sends one synthetic probe; nothing is sent at startup.

**Local model verification (25 October 2026): real responses received and validated.** With Ollama 0.40.11 on this laptop (Ryzen 7 7445HS, 15.3 GB RAM, RTX 4050 Laptop 6 GB), the running app called `gemma4:e4b` for real:
- the **Check connection** probe got a validated answer in 3.0 s and the Overview showed *Available · Local model (Ollama, this machine) · gemma4:e4b*;
- an import preview of a synthetic file with ambiguous headers got 6 validated model-suggested mappings in 6.1 s (Ollama reported 387 input and 249 output tokens);
- **Explain this finding** returned a model explanation with provenance `provider: ollama, local: true, model: gemma4:e4b` in 2.6 s.

With `EDUTRACE_OLLAMA_URL` pointing at a port with no server, the same steps fell back to deterministic output within about 1 s, and the status and toast reported *Temporarily unavailable* with `ECONNREFUSED`.

**Anthropic provider: not verified.** No successful Anthropic call has been made and no Anthropic model output has been evaluated.

*25 October 2026, with a real key:* every request returned `HTTP 400 invalid_request_error` with the API message *"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."* This happened for `claude-haiku-4-5-20251001` with and without `effort`, and for `claude-haiku-5-5` with `effort: low` (request ids `req_011CgNYPTZZXykYxAG2zgScp`, `req_011CgNYPVmmqX5N5BcJRbtji`, `req_011CgNYPXTiTGxSvH3BVuR7j`). The live test then recorded the same error for the health probe, schema mapping and explanation tasks (`docs/ai-live-test-results.json`); no rate-limit headers were returned, no tokens were used, and every task fell back to deterministic output. The billing check rejects requests before parameters are validated, so these calls do not show whether the request body is otherwise accepted. Leaving `effort` out for Haiku 4.5 follows the API documentation and has not yet been confirmed live. `npm run ai:evaluate` was not run, because the live test did not succeed; it now sends one health probe first and stops if that fails.

Earlier, with a deliberately invalid key: with the provider enabled and a deliberately invalid key, the health check reached `api.anthropic.com` and received `HTTP 401 authentication_error` (601 ms); it was reported as *Failed: check configuration*, not retried, the key did not appear in any response, and the explanation and import-mapping paths fell back to deterministic output. To run the controlled live test (synthetic fixtures only; one health probe, one ambiguous schema mapping, one explanation of a persisted synthetic finding, and a name-only candidate only when name sharing is enabled):

```powershell
$env:EDUTRACE_AI_PROVIDER = "anthropic"; $env:ANTHROPIC_API_KEY = "<your key>"; $env:EDUTRACE_AI_SHARE_NAMES = "true"
npm run ai:live-test -- --write   # writes docs/ai-live-test-results.json
npm run ai:evaluate -- --write    # writes docs/ai-evaluation-results.json
```

**Does a local model add value? Measured.** `npm run ai:benchmark-local -- --write` runs the labelled synthetic evaluation below through the application's own code paths, twice per installed model, after one warm-up call, and writes `docs/ai-local-benchmark.json`. Each figure below was identical in both runs unless two values are given. Model output is never applied: every run confirmed that no identity link or finding changed.

| Task (labelled synthetic data) | Deterministic baseline | `gemma4:e4b` | `qwen2.5-coder:7b` |
| --- | --- | --- | --- |
| Schema mapping, 12 CSV layouts × 10 fields | 35 correct, 2 wrong, 46 unmapped; precision 94.6%, recall 43.2%; 2/12 files ready | 76 correct, 2 wrong, 5 unmapped; precision 97.4%, recall 93.8%; **10/12 files ready**. 41 suggestions accepted, all correct; 3 rejected by validation (none would have been correct); 1 of 11 calls invalid (one header mapped twice) | 65 / 60 correct, 2 wrong; recall 80.2% / 74.1%; 7/12 files ready. 30 / 25 suggestions accepted, all correct; 1 / 2 of 11 calls invalid (confidence above 1) |
| Schema mapping latency per call | under 1 ms | median 5.5 s | median 14.7 s / 13.7 s |
| 7 engine-flagged candidate pairs (identical names and date of birth: 4 same person, 3 different) | All left for review | 7/7 *insufficient evidence*, which is correct: the names cannot separate them | 7/7 *insufficient evidence* |
| 12 name-variant pairs (6 same person written differently, 6 different people with similar names) | Never decided; the engine would flag only 1 (*Priya Sharma* / *Sharma Priya*) for review | 12/12 *insufficient evidence*: no decisions, no false "same person". Its `name_relationship` label was *abbreviation or initial* for 11 of 12, including all 6 different-people pairs | 12/12 *insufficient evidence*; `name_relationship` *different* for all 12, including the 6 same-person pairs |
| Explanations, one per rule (6) | Rule text | **6/6 passed** schema, language and grounding checks; mean 2.6–2.8 s | 1/6 passed: 4 rejected for prohibited conclusion language, 1 over the length limit; mean 5.6–6.1 s |
| Same answer in both runs | Yes | Schema 12/12 cases, assessments 19/19, explanation validity 6/6; explanation wording identical for 3 of 6 | Schema 11/12 cases, assessments 19/19, explanations 6/6 |
| One full evaluation run | — | 107–110 s | 261–273 s |

**Why `gemma4:e4b` is the default.** It was more accurate on schema mapping, was the only model whose explanations reliably passed validation, and was about 2.5× faster. Loaded, it uses 3.25 GB and runs entirely on the 6 GB GPU; `qwen2.5-coder:7b` uses 5.15 GB, about 1 GB of which spilled to the CPU. Only one of them fits on the GPU at a time. The 9.6 GB download size of `gemma4:e4b` includes vision and audio components that these text tasks do not load. Neither model adds value for identity matching: both declined every decision. That is safe, because nothing was merged, but it means name-only candidates still need a human reviewer.

**What changed after the first benchmark** (`docs/ai-local-benchmark-initial.json`). In the first run, `gemma4:e4b` produced 6 of 11 invalid schema answers, because it invented field names such as `student_id`, and only 3 and 2 of 6 valid explanations, because summaries exceeded 300 characters. `qwen2.5-coder:7b` was skipped after its warm-up answer was too long. The task contract was then fixed for every provider: the schema restricts `field` to the canonical field keys, the prompts state the length limits, and the benchmark records an invalid warm-up answer rather than skipping the model. The prompt template version became `p3`, which also invalidates cached explanations. The results above are from the second run.

The Anthropic comparison (`npm run ai:evaluate`) uses the same harness and is still pending:

| Comparison | Deterministic baseline (measured) | With Anthropic model assistance |
| --- | --- | --- |
| Schema mapping, 12 labelled CSV layouts × 10 fields (ambiguous, abbreviated, Hindi-English and generic headers; guardian, admission-date, phone, remarks and e-mail decoys) | 35 mapped correctly, 2 wrongly, 46 left unmapped, 37 correct abstentions; precision 94.6%, recall 43.2%; 2 of 12 files ready without manual mapping | Pending — correct, wrong, abstained and validation-rejected suggestions, latency and tokens are reported when run |
| Name-only identity candidates (7 pairs from the labelled evaluation: 4 same person, 3 different) | All 7 left for review; none linked or dismissed | Pending — accuracy when the model decides, "insufficient evidence" rate, and same-person calls on different people; the harness asserts no link or finding changes |
| Explanations of persisted findings (one per rule) | Rule text | Pending — share passing schema, language and grounding validation |

The baseline's two wrong mappings are `College` → institution code (the file's code column was `AISHE`) and `Guardian DOB` → date of birth; the model is consulted only for fields the baseline leaves unmapped, so it cannot correct these. Three abbreviated-name pairs ("Mohd"/"Mohammed") are never flagged as candidates, so the candidate assessment cannot help with them.

**Explainable identity resolution** (`src/identity.js`, `src/names.js`, policy `auto-link-2`). A layered, deterministic pipeline; no language model takes part in any outcome.

1. **Identifiers.** Only a locally well-formed identifier (12 digits after removing spaces and hyphens) is usable evidence, compared as a protected fingerprint. A malformed value is never identifier evidence, even when two records share it. Local format checks are not authoritative APAAR verification.
2. **Normalisation.** The engine stores the trimmed, NFKC-normalised, lower-cased name and a normalised date; originals are kept. For comparison only, names are also folded:
   - diacritics, punctuation and hyphens
   - word order
   - a short documented abbreviation table (`Mohd`, `Md`, `Mohammad` and similar variants of *Mohammed*)

   Initials ("A. Kumar" / "Arun Kumar") are recognised as *similar*, never as equal. Every comparison records which folding applied.
3. **Candidate generation by blocking.** Pairs are generated from records sharing an identifier value, a date of birth or a folded-name key, never from every pair of records. Records of the same institution without a shared identifier are not proposed, so resubmitted files do not produce candidates against themselves.

   The candidate rule in `src/engine.js` now uses these identity links, so the candidate findings and the persisted links are always the same pairs. The engine's previous separate all-pairs loop has been removed.
4. **Evidence.** Each compared pair stores:
   - the fields that agree, are similar, conflict or are missing
   - the name comparison method, and contributing factors with fixed weights
   - any disqualifying contradiction: identifier conflict, same identifier with a different date of birth or name, shared malformed identifier, or competing candidates
   - the reason, and an evidence key built from both records' identity evidence

   The score (identifier 8, exact or equivalent name 4, similar name 2, date of birth 3; conflicts subtract; maximum 15) orders and explains evidence. It is not a probability and never decides an outcome.
5. **Policy outcomes:**
   - `auto_linked` (AUTO_MATCHED): the same usable identifier, names exact or equivalent, dates of birth present and equal, and no record sharing the identifier conflicts. This is the only automatic association.
   - `needs_investigation` (POTENTIAL_MATCH with a contradiction).
   - `candidate_for_review` (POTENTIAL_MATCH): an identifier plus an incomplete attribute or an initial; no shared usable identifier but matching date of birth and exact, equivalent or similar names; or a shared malformed identifier.
   - `insufficient_evidence`: equal names, a date of birth missing, no usable identifier. Recorded, not proposed.
   - `not_linked` (NO_SUPPORTED_MATCH).

   Reviewer decisions add SAME_PERSON_CONFIRMED, DIFFERENT_PERSON and NEEDS_MORE_EVIDENCE. When new evidence contradicts an earlier automatic association, the link is marked MATCH_WITHDRAWN, its finding is cleared or superseded with an audit event, and the conflict becomes a pending finding.

Records are never linked automatically on name similarity, an initial, a date of birth alone, a malformed identifier, a missing or conflicting attribute, or a model suggestion. Moving a database from policy `auto-link-1` to `auto-link-2` (automation version 2) re-runs the pipeline once, with audit events for anything that changes. On the shipped demo data this only records 6 more "compared, not linked" pairs; findings, decisions and notifications are unchanged.

**Measured on the labelled identity benchmark** (`npm run evaluate:identity`, `src/identity-benchmark.js`, results in `docs/identity-evaluation.json`). The data is 17 synthetic pair scenarios × 6 variants: 102 instances, 120 labelled pairs, 66 of them the same person. It covers your 18 cases plus shared malformed identifiers and same-name/different-birth-date pairs, all matched together in one dataset. The frozen previous matcher (`src/identity-baseline.js`) runs on the same records.

| On 120 labelled pairs | Previous `auto-link-1` | Current `auto-link-2` |
| --- | --- | --- |
| Same-person pairs surfaced (auto or review) | 90.9% | 100% |
| Automatic links / automatic precision | 39 / 100% | 36 / 100% |
| Wrong automatic links | 0 | 0 |
| Contradictory pairs linked automatically | 6 (shared malformed identifiers) | 0 |
| Automatic recall, all same-person pairs | 59.1% | 54.5% |
| Automatic recall, pairs the policy should link | 91.7% | 100% |
| Review-candidate precision / recall | 46.7% / 60.0% | 55.6% / 100% |
| Inconclusive pairs kept unlinked | 24 of 24 | 24 of 24 |
| Abbreviated names surfaced | 0 of 6 | 6 of 6 |
| Unicode, whitespace or punctuation variants linked | 3 of 6 | 6 of 6 |
| Competing candidates flagged | 0 of 6 | 6 of 6 |

- **Breakdown by method.** On exact-identifier pairs, current automatic recall is 75% (previously 81.3%; the difference is the malformed pairs now held for review). On pairs without a usable identifier, candidate recall is 100% (previously 66.7%) and nothing is linked automatically.
- **Review precision stays about 56%** because namesakes (identical names and birth dates) are deliberately proposed for review. The data cannot tell them apart; a reviewer must.
- **The lower automatic recall over all same-person pairs is the intended trade:** pairs with a missing or malformed attribute wait for a reviewer instead of being linked.
- **Pipeline scenarios all pass:**
  - a candidate rejected by a reviewer stays rejected after an unchanged re-import (its 4 copies are shown once)
  - an unchanged re-import creates 0 findings and 0 notifications
  - a contradicted automatic link is withdrawn, audited and reopened as a conflict
  - supplying a missing identifier produces an automatic link
- **Latency.** On realistic synthetic loads, the removed all-pairs rule took 158 ms, 1.43 s and 5.26 s at 1,000, 3,000 and 6,000 records (18 million pairs at 6,000). Blocked generation takes 4.6 ms, 19 ms and 51 ms and finds the same candidates.

These are designed cases; they do not estimate accuracy on real institutional data. The "matches expected" figures (105 vs 120 of 120) compare each policy with labels written by the same person who wrote the new policy, so they are weak evidence. The ground-truth metrics above carry the weight.

**Source-record lineage** (`src/lineage.js`). Source records are never edited. A re-sent row is stored as a new record and classified against earlier rows from the same institution. The CSV row number is never used to identify a record.
- **Unchanged copy.** Every value is identical to an earlier record. The copy shares its lineage and version, and no new work is created. An identity pair inside one lineage is `same_source_record`: a re-sent row, not an identity inference.
- **Correction.** The institution's own record reference (`source_reference`, a new optional mapped column) matches an earlier record, and at most one identity value (identifier, name or date of birth) was replaced by a different value. Filling a missing value is not a replacement. The new row becomes version n+1 and the earlier version is superseded.
  - The earlier version keeps every value and its provenance.
  - It no longer takes part in reconciliation, identity linking, capacity counting or the automation rate.
  - Changed fields are recorded with their previous and new values; identifiers stay masked.
- **Correction candidate.** These wait for a reviewer on the Import page, where *Confirm correction* needs a note and a confirmation. Until a reviewer decides, both records stay active and independent. Two kinds of row become candidates:
  - a reference whose identity values changed too much (possible reuse for another student)
  - without a reference, a later row that fills missing values (or replaces a malformed identifier) for the same folded name, programme and session, or shares the usable identifier in the same session

  Similar names alone never create a candidate.
- **Re-evaluation.** After a correction, reconciliation runs again. A finding whose condition disappeared because a record was superseded becomes `cleared` (`lifecycle_cause: "correction"`, audit `resolved_by_correction`), with its history and decisions kept; unrelated findings are untouched. Identity links are matched across versions by lineage, so an automatic link contradicted by corrected evidence is marked withdrawn and its conflict reopens for review. Clearing is not notified. A correction never links students: identity remains under policy `auto-link-2`.
- **Where to see it.** Each source on a student profile has a *Correction history* panel showing:
  - versions, with what changed
  - findings resolved by the correction, and findings still open
  - identity decisions, marked when they were made on an earlier version

  The finding drawer marks superseded and corrected versions. Pending candidates also appear under Needs attention on the Overview. Lineage needs no migration: a record without lineage is version 1 of itself.

**Independent identity evaluation** (`bench/identity-holdout/`, `npm run evaluate:independent`, results in `docs/identity-independent-evaluation.json`). The generator imports no production code. It builds fictional people, including deliberate look-alikes, and emits their rows through documented noise channels across four batches. Ground truth is only who each row belongs to (`person_id`) and which institutional record it versions (`source_key`); no expected matcher outcome is stored. The runner imports the rows through the real pipeline and compares the persisted results with that truth. Every metric records its numerator, denominator and definition: a review pair is never counted as a match, and copies of one record are counted once.

The development set was examined while I fixed the evaluation code and one lineage heuristic (treating a malformed identifier replaced by a valid one as supplying it). The confirmation set was generated afterwards with a new seed and not used for any adjustment.

| Held-out synthetic set | Development (seed 8128) | Confirmation (seed 52711, unseen) |
| --- | --- | --- |
| Rows / people / source records compared | 585 / 382 / 436 | 580 / 382 / 436 |
| True same-person pairs | 54 | 54 |
| Candidate-generation recall | 83.3% (45/54) | 87.0% (47/54) |
| Automatic-link precision | 100.0% (22/22) | 100.0% (20/20) |
| Automatic-link recall | 40.7% (22/54) | 37.0% (20/54) |
| Review precision / recall | 46.0% (23/50) / 71.9% (23/32) | 50.9% (27/53) / 79.4% (27/34) |
| Wrong automatic links | 0 | 0 |
| False negatives (not surfaced) | 9 | 7 |
| Exact-identifier pairs: recall, automatic recall | 100.0% (29/29), 75.9% (22/29) | 100.0% (28/28), 71.4% (20/28) |
| No shared identifier: recall (all to review) | 64.0% (16/25) | 73.1% (19/26) |
| Look-alike people linked automatically | 0 of 38 | 0 of 38 |
| Contradictory pairs linked automatically | 0 of 23 | 0 of 24 |
| Corrections with a reference: correct version superseded | 15 of 15 | 19 of 19 |
| Corrections without a reference: held for the right record | 9 of 9 (0 accepted automatically) | 5 of 5 (0 accepted automatically) |
| Reused references wrongly accepted as corrections | 0 of 3 | 0 of 3 |
| Unchanged re-import: copies recognised, new open findings, notifications | 125 of 125, 0, 0 | 120 of 120, 0, 0 |
| Late contradictions: earlier automatic link withdrawn | 3 of 3 | 3 of 3 |

- **What the numbers mean.** No look-alike, contradictory or copied-identifier pair was linked automatically, and corrections never superseded the wrong record. The price is recall: pairs without a shared usable identifier are never linked automatically, and only 64–73% of them are even proposed for review.
- **What the false negatives are.** They are deliberate abstentions:
  - a row carrying another person's identifier, surfaced instead through its conflict with that identifier's owner
  - a missing birth date with no usable identifier
  - a malformed identifier combined with a mistyped birth date
- **Review precision is about 46–51%.** About half of the review queue is different people.
- **Caution.** These are synthetic cases, not real-world accuracy, and the sets are too small for statistical claims. The noise channels were written by the same author as the matcher: independent of its code, not of its designer.

**Model commentary on a pair** (local Gemma, advisory).
- **Input.** *Ask the model to explain this evidence* sends only the identity-field results (agree, equivalent, similar, conflict, missing, not comparable), separate context results, the method, the policy outcome and contradictions. No names, dates or identifiers are sent.
- **Validation.** The answer must:
  - list only supplied identity fields, each under the result it was given
  - include every conflict
  - pick its next action from a fixed list
  - pass the language and number-grounding checks
  - never call the match confirmed, proven, certain or verified
- **Effect.** It is cached per evidence key, template and model, a stale one is withheld, and it never changes a link, finding or decision. Without a model, the deterministic explanation is shown.
- **Measured with `gemma4:e4b`** on the 54 benchmark review pairs:
  - First contract (`docs/identity-evaluation-initial.json`): 6 of 54 valid. All 48 rejections listed a context difference (institution) as an identity conflict.
  - After separating context from identity fields: 53 of 54 valid. The one failure was a 120 s timeout while the machine was low on memory. Median 6.4 s, maximum 16.7 s.

  Validity means the commentary is consistent with the evidence it was given. It is not identity-matching accuracy, and the text was not reviewed by hand. Name sharing with a local model has its own setting, `EDUTRACE_AI_LOCAL_NAMES`, separate from `EDUTRACE_AI_SHARE_NAMES` (remote); both are off by default.

**Processing outcomes** (`src/automation.js`). Every record gets one status: *automatically processed*, *automatically normalised*, *safely matched*, *needs institution correction* (missing or malformed identifier, missing values), *needs investigation* (identity conflicts, candidates, possible concurrent enrolment, capacity), *authoritative verification pending*, or *processing failed* (rejected rows). A duplicate-identifier finding that satisfies the policy is closed automatically with a system audit event; if later evidence breaks the policy, the match is withdrawn and the finding returns to review. A well-formed identifier is reported as *locally well-formed, unverified*: no verification service is integrated.

**Exception-first notifications.** Each import or re-run creates notifications only for new or changed exceptions, grouped by batch and institution, each item with its explanation, affected source rows, required action and current status. Findings are keyed by the condition they describe, so re-importing the same file extends evidence instead of creating duplicates and does not notify again. Notifications are scoped like findings; acknowledging one records who and when, and does not resolve any finding.

**Measured on labelled synthetic cases** (`npm run evaluate`: 168 rows, 214 persisted records, 137 synthetic people, 13 scenario types). These figures describe the rules on cases built for this evaluation, not accuracy on real data:

| Measure | Result |
| --- | --- |
| Automatic processing rate | 51.4% of persisted records (all 110 routine records; 0 non-routine records processed automatically) |
| Automatic identity links | 16 links, precision 100%, recall 59.3% of 27 true same-student pairs |
| Linked automatically or flagged for review | 88.9% of true pairs; review flags 57.1% precise (namesakes are deliberately flagged) |
| Automatic false links | 0 of 6 evaluated non-matching pairs (a small sample); 0 identifier collisions linked |
| Missing identifier / malformed identifier / missing required value | 24/24, 6/6, 4/4 detected |
| Concurrent enrolment, DoB conflict, identifier collision, candidate, namesake | all labelled cases flagged |
| Abbreviated first names (for example "Mohd" and "Mohammed") | 0 of 3 detected: a known gap |
| Re-import of the same file | 0 superseded findings, 0 new open findings, 0 items notified, 0 duplicate current findings per condition |

The demo dataset shows 97.8% (352 of 360) because most seeded records are routine; the evaluation set is deliberately weighted towards edge cases.

## Interface

The single-page interface is plain HTML, CSS and JavaScript with no runtime dependencies. Fonts use the system stack and icons are an inline SVG sprite, so the app works fully offline.

**Themes.** Light (Ice Silver `#DDE3E8` canvas, Deep Aubergine `#3A0F34` structure, Marigold `#EAAA00` accent) and dark (Obsidian `#0A0A0A`, Ocean Blue `#007BA7`, Neon Pink `#FF2D95` selection accent). Every theme-dependent colour is a CSS custom property in `public/styles.css`; the dark theme redefines the same tokens under `:root[data-theme="dark"]`. Small text that would fail contrast in a brand colour uses an accessible variant (for example `#5CC8F0` link text on black instead of Ocean Blue). The sun/moon button in the top bar switches themes immediately and stores the choice in `localStorage` (`edutrace.theme`); without a stored choice the app follows the operating-system setting. A small inline script in `<head>` applies the theme before first paint, so the wrong theme never flashes.

**Interaction and feedback.** Small transitions (120–220 ms, opacity/transform/colour) on controls, filter chips, tooltips, the drawer, the mobile filter sheet and graph selection. Metric numbers animate only when a value the server returned differs from the one already shown (for example after a decision or import). Import shows an indeterminate progress bar only while a real request is in flight; the server does not report partial progress, so no percentage is ever shown. Every animation is disabled under `prefers-reduced-motion`.

**Keyboard.** <kbd>/</kbd> focuses the search; in the evidence drawer <kbd>J</kbd>/<kbd>K</kbd> move to the next/previous finding (ignored while typing a note); in the Integrity Graph the arrow keys move between items, <kbd>Enter</kbd> selects and <kbd>Escape</kbd> clears; <kbd>Escape</kbd> closes the drawer, dialogs, the role menu, the navigation drawer and the mobile filter sheet, and focus returns to the control that opened them.

**Overview.** The dashboard is built to be scanned in a few seconds. It shows summaries; the explanations live in the finding drawer, Potential matches, Reconciliation and Audit history.
- **Header.** "Student data, under control." with the access scope, *Import student data* (primary) and *Open reconciliation*.
- **Four metrics.** Each has a server definition in its tooltip, and the linked ones open the matching filtered view:
  - *Imported records*: persisted source records in scope.
  - *Automatically processed*: records with no open finding, with the percentage. This is not identifier verification.
  - *Open findings*: current findings pending review or awaiting verification.
  - *Pending review*: current findings with no reviewer outcome yet.

  *Validation issues* (current identifier and required-field findings, any status) remains a separate count in the summary API.
- **Suggested next step.** One line and one button, opening the highest-priority unresolved finding (pending before awaiting verification, then severity, then age).
- **Needs attention.** Open findings in up to three groups, ordered by high-severity count:
  - missing or malformed information
  - identity conflicts and candidate matches (opens Potential matches when pairs await a decision)
  - capacity and enrolment alerts
  - waiting for verification

  Each finding is counted once. Each group shows its count and a one-line breakdown, and links to the filtered findings. Empty groups are omitted.
- **Automated processing.** The percentage, *n of N*, a segmented bar and the counts per processing outcome. The definition is in a tooltip. A one-line model-assistance status has *Check* for the regulator, and *Re-run* is regulator-only.
- **Exception notifications.** The three most recent batches, each with institution, file, origin, time, the number of new or changed exceptions, correction and investigation counts, and *Acknowledge*. Each opens that batch's findings.

The severity tiles, rule chart, capacity chart, review-queue list, activity feed and import list were removed from the Overview. Their information remains in Reconciliation (severity, status, rule and capacity filters, the finding drawer), Potential matches and Audit history (decisions and import batches).
- **Records reconciled.**
- **Rule-based findings.** Every finding is raised by a deterministic rule.
- **Model explanations.** Explanations a model actually generated and that are stored with their model and time. This stays 0 until a reviewer asks for one.
- **Potential matches awaiting a reviewer.**

A small relationship diagram draws one node per institution in scope and one arc per current relationship finding (exact identifier, conflict, candidate). It has a caption with the counts and a link to the graph. Nothing in it is decorative-only data.

**Potential matches** (`#/matches`). This is the review queue for identity links that need a person: pairs with a shared identifier whose name or date of birth conflict, and pairs with no shared identifier but a matching date of birth and similar names. The rules raise these pairs; the page only lists them. If none exist, the page says so and explains what would create one.
- **Queue.** Each entry shows:
  - a masked display label (initials only)
  - both source institutions and rows
  - the method
  - which identity attributes agree, conflict or are missing
  - the review status and why the pair was raised

  It can be searched by name, institution, file or row, and filtered by institution, status, conflict type and matching evidence, with removable chips. Below 1024 px the filters move into a bottom sheet.
- **Side-by-side comparison.** The earlier-imported record is the reference and the later one is incoming. Every field is marked:
  - *agree*, *similar, not identical*, *conflict* or *differs · context* (institution or programme differences are not identity conflicts)
  - *missing on one side* or *not supplied by either*

  A missing value is never shown as a match. Identifiers are compared by fingerprint, shown masked and always labelled *not verified*. Each field opens its source file, row, import batch, the value as it appeared in the file and the normalisation applied. Below 768 px each field stacks into labelled *Reference* and *Incoming* lines.
- **Why these records are candidates.** This panel shows:
  - the method (exact identifier versus name similarity)
  - the agreeing, conflicting and missing attributes
  - the recommendation and the reason for uncertainty
  - the evidence score, labelled as a fixed weighting that is not a calibrated probability

  Once a reviewer records "same person", the heading becomes *Why these records were linked*.
- **Model contribution.** This shows any stored model explanation or name assessment, with its model and time, and otherwise says that the comparison came from deterministic rules. With a configured provider, a reviewer can request an explanation (and, when name sharing is on, a name assessment). The result is advisory and never links, separates or merges records.
- **Reviewer decision.**
  - The options are *Same person*, *Different people* and *Needs more evidence*. A note is required; validation errors appear inline next to the control.
  - *Same person* needs a confirmation dialog in the browser and `confirm: true` in the API.
  - A final decision can only be reopened with *Needs more evidence*, so every change of mind is recorded.
  - Decisions are stored against the link's stable key, so they survive re-runs. They are audited on the finding that raised the pair, and they update that finding's review status: resolved when every pair in it is decided, awaiting verification while more evidence is needed.
  - The queue, the navigation count, the Overview and Audit history update from the server response.
  - Source records are never merged or changed.

**Student profile** (`#/profile?record=<id>`). This is a read-only source view around one record. It includes the records joined to it by an automatic identifier link or a reviewer's "same person" decision, within the viewer's scope; linked records outside the scope are counted but not shown. It has five tabs, navigable with the arrow keys:
- **Overview.** Each attribute is marked consistent, conflicting or missing. Conflicting values are all listed with their sources, and none is chosen.
- **Education history.**
- **Sources.** Each record as imported, with masked identifiers and its normalisations.
- **Match history.** Every comparison with its method, outcome, reason and decision, plus the audit trail.
- **Conflicts.**

Profiles open from the comparison, the evidence drawer and graph records.

**Integrity graph.** The existing graph keeps its search, filters, zoom and table view.
- Selecting a relationship animates a flow along it in the selection accent (none under reduced motion).
- Candidate and conflict edges offer **Compare side by side**. This resolves the pair through the potential-matches API, so only a persisted link opens.
- Record nodes link to the student profile.

| File | Responsibility |
| --- | --- |
| `public/index.html` | Application shell (sidebar, top bar, views, dialogs) and icon sprite |
| `public/styles.css` | Design tokens and components; responsive layouts for 1440 / 1366 / 1024 / 768 / 390 px; reduced-motion and forced-colours support |
| `public/app.js` | API client, hash router (`#/overview`, `#/import`, `#/reconciliation`, `#/graph`, `#/matches`, `#/profile`, `#/audit`), theme toggle, toasts, confirmation dialog, demo-role switcher, Overview (metrics, reconciliation summary, automated processing, exception notifications, charts) and Audit history |
| `public/reconciliation.js` | Search, combinable filters with removable chips (a bottom-sheet filter drawer below 768 px), sortable/paginated findings table, evidence drawer (including processing outcome, identity-match evidence and explanation) and review decisions |
| `public/import.js` | Five-step import wizard: select source → map columns → preview & validate → confirm → summary |
| `public/graph.js` | Integrity Graph layout, evidence panel, relationship table, search, filters and zoom; comparison and profile links |
| `public/matches.js` | Potential matches: queue, filters and sheet, side-by-side comparison with per-field evidence, explanation, model contribution and reviewer decisions |
| `public/profile.js` | Student profile (source view) with Overview, Education history, Sources, Match history and Conflicts tabs |
| `src/matches.js` | Potential-match queue, field comparison, explanation, reviewer decisions with audit, and the source-record profile |
| `src/engine.js` | Normalisation, validation, reconciliation rules, capacity counting and lifecycle, access checks |
| `src/identity.js` | Identity-resolution pipeline (policy `auto-link-2`): usable identifiers, blocking, field comparison, factors, contradictions and outcomes |
| `src/lineage.js` | Source-record lineage: unchanged copies, corrected versions, correction candidates, reviewer confirmation and the lineage view |
| `bench/identity-holdout/` | Independent held-out identity evaluation: generator (no production imports), frozen cases, runner and README |
| `src/names.js` | Comparison-only name folding (diacritics, punctuation, word order, documented abbreviations) and initials |
| `src/identity-baseline.js` | Frozen previous matcher (`auto-link-1`), used only by the identity benchmark |
| `src/identity-benchmark.js`, `scripts/evaluate-identity.js` | Labelled identity benchmark, pipeline scenarios, latency and optional model-commentary validity |
| `src/automation.js` | Condition-keyed finding merge, automatic matching and withdrawal, processing outcomes, notifications |
| `src/pipeline.js` | The single import and re-run path shared by the server and the evaluation |
| `src/ai-provider.js` | Optional model provider (local Ollama or Anthropic): configuration, health, retries, structured outputs, schema/language/grounding validation, fallback |
| `scripts/start-local-ai.js` | `npm run start:local-ai`: starts the server with the local Ollama provider |
| `scripts/ai-benchmark-local.js` | `npm run ai:benchmark-local`: benchmarks installed Ollama models on the labelled synthetic tasks |
| `src/assist.js` | Explanation and candidate assistance for a persisted finding, with the evidence-aware cache key |
| `src/ai-evaluation.js`, `scripts/ai-evaluate.js`, `scripts/ai-live-test.js` | Baseline-versus-model comparison and the controlled live-provider test |
| `src/evaluation.js`, `scripts/evaluate.js` | Labelled synthetic evaluation |

Deep links work: `#/reconciliation?severity=high&status=pending&finding=<id>` opens a filtered workspace with that finding's evidence drawer. Press <kbd>/</kbd> to focus the search on any page.

## Fast judge demonstration

1. Run the commands above and open the app.
2. Read the **Overview**: four metrics, the suggested next step, **Needs attention**, **Automated processing** and the latest **Exception notifications**. Hover the ? icons for each metric's definition, then press *Open finding*.
3. Open **Reconciliation**, search (for example `nair`) and combine filters, then open a high-severity finding. The drawer separates *evidence* (side-by-side field comparison, masked identifiers, provenance) from *interpretation* (what the finding indicates and what it does not establish). Record a reasoned decision; consequential outcomes ask for confirmation, and the audit history, counts and Overview update immediately.
4. Use the **Demo · Regulator** chip in the top bar (or the sidebar card) to switch to the **NITM institution reviewer** and see RCA/SVU findings disappear server-side. **Export CSV** now exports only the current scope.
5. Open **Potential matches**:
   - Search for `nair`, select the pair and compare the two records field by field.
   - Open a field to see its source row and original value, then read *Why these records are candidates*.
   - Record *Needs more evidence* with a note. Then record *Same person*, confirm it, and see the status, audit history and navigation count change.
   - Open the student profile to see both source records side by side, unmerged.
6. Open **Integrity graph**, select a record or relationship to inspect its persisted evidence, try search and filters, or switch to the **Table** view.
7. In **Import data**, upload a CSV, adjust the per-field mapping, and review the server's row-by-row pre-import check before confirming. Required mappings are `student_name`, `institution_code`, `programme`, `academic_session`, and `enrolment_status`; a missing APAAR value is permitted and becomes a validation finding. The summary links directly to the new batch's findings.
8. For a CSV containing NITM, RCA, and SVU rows, use the clearly labelled **Regulator-only: import rows from multiple known institutions** mode. Institution reviewers must import only their own institution's rows; foreign rows are skipped and listed.
9. **Audit history** lists every review decision and import batch in the current scope, including automatic matches and their withdrawals by the reconciliation engine.
10. Import the same CSV twice: the second import creates no new open work and notifies nothing, and **Re-run reconciliation** reports "No changes". Open a *Repeated identifier submission* finding to see why it was matched automatically, and a *Shared identifier has conflicting identity attributes* finding to see why it was not.

## API additions for the interface

All additions are read-only or dry-run, and enforce the same principal scope as existing endpoints:

- `GET /api/v1/audit?limit=N` — review decisions on accessible findings, newest first, with finding title and source-row context.
- `GET /api/v1/imports` — import batches and institutions visible to the principal (row outcomes omitted).
- `POST /api/v1/imports/preview` now also returns `dry_run` (ready / with warnings / rejected / skipped, computed with the same row rules as confirm), masked `header_samples`, and per-sample outcomes. Nothing is persisted.
- `GET /api/v1/dashboard/summary` now also returns `open_findings` (with its definition), `by_status`, `by_rule`, `historical_findings`, and `capacity` (configured limit, observed active enrolments, and the current finding for each rule).
- `GET /api/v1/findings` and `GET /api/v1/reports/findings.csv` accept `lifecycle=current|historical|all` (default `current`) and a comma-separated `category` list (for example `category=capacity,enrolment`) alongside the existing search and filter parameters. Findings now include `automation` (outcome, queue, required action), `identity_links`, and per-record `processing`; the CSV adds `processing_outcome`.
- `GET /api/v1/automation`: processing outcomes, automatic rate and its definition, open exceptions by queue, identity-link outcomes, verification counts, the matching policy and model-provider status for the principal's scope. `GET /api/v1/ai/status` returns the provider status alone.
- `GET /api/v1/notifications` and `POST /api/v1/notifications/:id/acknowledge`: scoped exception notifications.
- `POST /api/v1/automation/revalidate` (regulator only): re-runs every rule over persisted records; idempotent.
- `POST /api/v1/findings/:id/assist`: plain-language explanation (model or deterministic fallback) with the list of fields sent and the provider's health; advisory only. Stale cached explanations are regenerated or withheld.
- `GET /api/v1/ai/status`: provider, model, settings, health state, last error and per-task usage. `POST /api/v1/ai/check` (regulator only): one synthetic health probe.
- `GET /api/v1/matches?q=&institution=&status=&conflict=&evidence=&method=`: reviewable identity links whose two records are both in scope.
  - Each entry has masked display labels, sources, method, agreeing, conflicting and missing fields, status and the reason it was raised.
  - Also returned: counts and filter options.
- `GET /api/v1/matches/:id`: the comparison.
  - Per-field states with source provenance; identifiers masked and `verification: "not_verified"`.
  - The explanation, the model contribution, the allowed decisions and the pair's audit events.
- `POST /api/v1/matches/:id/decision`: records a decision. Body: `{ decision: same_person | different_person | needs_more_evidence, note, confirm }`.
  - `same_person` requires `confirm: true`, and a note is always required.
  - A final decision can only be reopened with `needs_more_evidence`.
  - Responses: 404 outside the principal's scope, 409 on a historical finding.
- `GET /api/v1/profiles/:recordId`: the read-only source profile.
- `GET /api/v1/records/:id/lineage`: versions, changed fields (identifiers masked), findings resolved by correction or still open, related identity decisions and correction candidates; 404 outside scope. `GET /api/v1/corrections?status=pending|all` and `POST /api/v1/corrections/:id/decision` (`{ decision: confirm | reject, note, confirm: true }`): reviewer decisions on correction candidates; confirming re-runs reconciliation. Import batches report `lineage` counts and `findings_resolved_by_correction`.
- `POST /api/v1/matches/:id/explain`: model commentary on a pair's evidence. It returns `source: "model"` with provenance, or `source: "deterministic"` with the reason, and responds 404 outside the principal's scope. Queue entries also carry `resolution`, `matching_field_count`, `similar_fields`, `disqualifiers`, `competing_candidates`, `recommended_action`, `sessions` and `copies`, and the queue accepts `session=`. Decisions store the previous and new state, the reviewer's evidence snapshot and the source references, and their audit events carry `from_state`, `to_state` and `source_records`.
- `GET /api/v1/automation` now also returns `assistance`: counts of rule findings, stored model explanations and stored name assessments.

**Limitations of the matching workflow.**
- A *same person* decision joins records only in the profile and the potential-matches status. It does not change capacity counting or the automatic-linking policy, which still treat the records as separate identities.
- A finding that groups more than two records under one identifier is decided pair by pair. It resolves only when every pair is decided.
- Source records are immutable; a corrected row supersedes the earlier version only with the institution's record reference or a reviewer's confirmation. Without either, both stay active, and their candidate pairs remain until a reviewer acts.
- Phase 7 regression found and fixed in Phase 8: under `auto-link-2`, re-importing an unchanged file containing malformed identifiers opened 2 new investigations. Lineage now recognises the re-sent rows as `same_source_record`, so the existing evaluation's identical re-import again creates 0 open findings and 0 notifications.
- Local-AI browser verification in Phase 8 was cut short by low memory. The connection check succeeded in the browser (*Configured, not yet tested* → *Available*, 12.2 s including model load). The schema-mapping, finding-explanation, pair-commentary and fallback checks in the browser, and the hand review of real explanations, were not completed. The automated tests cover these paths with stub providers only.
- The demo data has three reviewable pairs, so the queue is short by design; nothing is added to fill it.
- Browser checks used a scratch copy of the database:
  - The Overview, Potential matches, profile and graph were checked for horizontal overflow and layout mode at 1440, 1366, 1024, 768 and 390 px.
  - The decision workflow, keyboard paths, the filter sheet and focus restoration were exercised.
  - Screenshots were reviewed in dark at 1440 px and in light at 1024 and 390 px.

  Automated tests cover the API, scoping, masking, transitions, audit and the UI contract, but they do not drive a browser.

## Safety and scope

- Every institution, person, identifier, finding, capacity rule, and verification claim is synthetic.
- A valid 12-digit APAAR-shaped value is labelled only as locally well-formed, never verified. There is no APAAR, Aadhaar, UDISE+, AICTE, or government integration.
- Imported file contents are not written to a public directory. The local demo database persists only canonical/provenance values and audit events in `data/demo-db.json`.
- CSV is the supported upload format. `.xlsx` is intentionally rejected in this no-dependency build rather than silently mishandled. CSV parsing supports quoted commas and rejects malformed quotes, duplicate/empty headers, bodies over 2 MB, and imports over 5,000 rows.
- The import mapper offers only headers contained in the uploaded CSV plus **Do not map**. It suggests aliases including underscore-style headers such as `student_name`, `institution_code`, `academic_session`, and `enrolment_status`; mappings are revalidated server-side.
- Source filenames are reduced to a safe basename and are never served publicly. Upload rows missing required canonical fields are rejected and counted; identifier-only issues stay visible as findings rather than being silently discarded.
- Import confirmations persist a row accounting summary (`rows_detected = imported + rejected + skipped`) with source row numbers and a reason for every rejected or skipped row. Missing and malformed APAAR identifiers do not block an otherwise importable row; they are persisted as findings. The dashboard record count is the count of persisted, currently accessible source records. Therefore an 18-row import followed by a 360-to-368 dashboard change means eight records persisted and ten did not; the earlier response did not include row outcomes, so the exact ten cannot be attributed without that CSV, while the current response identifies each outcome.
- Dashboard **Validation issues** counts current identifier and required-field findings, including findings already reviewed. **Pending decisions** counts current accessible findings whose review status is pending. Severity totals group every current accessible finding; their sum equals **Accessible findings** for the same scope. Superseded or cleared capacity findings are reported separately as historical.
- Reconciliation search supports case-insensitive partial matching across student, institution, programme, source row, finding ID/title/rule, masked APAAR suffix, source filename, and import batch. Institution, category/rule, severity, review status, academic session, and batch/file filters can be combined; result totals and severity counts show both filtered and pre-filter accessible totals. Review states and filter choices are based on actual persisted findings in the current principal's scope. Search indexes masked identifiers only, never full APAAR values.
- Integrity Graph search highlights matching institution/source-record nodes and keeps only their persisted connected relationships prominent; unrelated graph items are dimmed. It searches permitted source display data, masked identifier suffixes, and linked findings while retaining the institution, relationship, and review-status filters.
- The Student Integrity Graph uses `/api/v1/graph` and persisted findings only. It separates institutions and source rows, labels source/exact/candidate/conflict edges, filters to the user's authorized institutions, and returns masked identifiers for tooltips and details.
- The selectable roles exist only in the read-only demo (`EDUTRACE_MODE=demo`), where nothing can be changed. In development mode the role and institution come from the signed-in account on the server (or a verified OIDC token); `x-demo-role` and `x-demo-institution` headers are ignored. Production mode still refuses to start.
- The interface was exercised in Chromium (via Playwright scripts, against a scratch copy of the database) in both themes at 1440, 1366, 1024, 768 and 390 px: every view was checked for horizontal overflow; theme toggle and persistence across reloads; the reconciliation summary in both demo roles; graph keyboard selection and dimming; the mobile filter sheet; import with an invalid file, a valid CSV, the processing state and the summary; drawer J/K navigation, note validation, a recorded decision and its audit entry; no console errors. Colour contrast of the theme tokens was computed against WCAG 2.2 AA (4.5:1 text, 3:1 indicators). After the automation upgrade, the new Overview cards were checked in Chromium in both themes at 1440, 1366, 1024, 768 and 390 px for horizontal overflow and clipping (none) and console errors (none), with screenshots reviewed at 1440 (both themes), 1024 (dark) and 390 (light). Acknowledging a notification, re-running reconciliation, the institution scope, the evidence drawer with **Explain this finding** (1440, dark) and the import wizard's suggestion labels (1440, light) were exercised. There are no automated browser tests in the repository; re-run the judge demonstration manually after UI changes.
