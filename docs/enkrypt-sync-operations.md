# Enkrypt score ingestion operations

This integration imports model-level benchmark metadata. It does not enforce request safety, change routing, add a UI, or establish that Kilo's serving providers were evaluated. The upstream `provider` and `source` remain evaluation provenance, not Kilo routing instructions.

## Release status

Keep the integration in draft and both feature flags disabled until the release gates below are complete. API access does not establish permission to redistribute the scores. Redistribution approval, production scheduling, and an authenticated staging import have not been verified by the representative tests.

## Controls and deployment

Both flags default to `false`; only the exact string `true` enables them.

| Ingestion flag | Publication flag | Behavior |
|---|---|---|
| `false` | `false` | No ingestion, no health alerts, and no published Enkrypt metadata. |
| `true` | `false` | Ingest and monitor privately; public responses omit Enkrypt metadata. |
| `false` | `true` | Stop ingestion but continue publishing retained scores with their freshness status. |
| `true` | `true` | Ingest, monitor, and publish. Requires redistribution approval. |

An operator must use the shared web-environment workflow described in [DEVELOPMENT.md](../DEVELOPMENT.md), not commit credentials or edit provider projects independently. For staging only:

```sh
pnpm web:env set ENKRYPT_API_KEY --only staging
pnpm web:env set ENKRYPT_SYNC_ENABLED --only staging
pnpm web:env set ENKRYPT_PUBLICATION_ENABLED --only staging
```

These commands are user-run and prompt for values. Keep publication disabled until approval; enabling staging ingestion does not require enabling publication. Apply the generated database migration before enabling ingestion. The migration creates a single operational-status row's table, not a score-history store.

Existing deployments retain their prior environment configuration. Redeploy the intended environment after changing a flag or key. Before staging writes, verify that its primary database and any read replica are isolated from production. Configuration and deployment of production are separate operator-approved release steps.

To stop fetching and writing, set `ENKRYPT_SYNC_ENABLED=false` and redeploy. To suppress already-stored scores independently, set `ENKRYPT_PUBLICATION_ENABLED=false` and redeploy all serving web projects. Suppression covers model catalogs, the statistics list, and statistics detail endpoints; it does not delete stored snapshots. Publication checks run outside the five-minute database cache. Statistics responses are dynamic and `no-store`. Previously delivered client responses or old deployments still receiving traffic cannot be recalled by the new flag.

## Contract and identity

The envelope must contain `status: "success"` and `data.scores` as an array. Each record is validated separately. Invalid records are rejected and counted without discarding unrelated valid records. Model and provider names must be nonempty strings; scores must be numeric, null, or absent according to the schema. Empty, null, and missing `source` metadata are retained without substituting a source.

Only explicit, reviewed identity tuples are associated with catalog models. No provider-prefix guessing, source substitution, case folding, dated-model substitution, or free/reasoning-variant inheritance is performed. Conflicting mappings and multiple input records targeting one model are ambiguous and all affected records are skipped.

The initial required set is:

| Enkrypt model | Provider | Source | Kilo model ID |
|---|---|---|---|
| `gpt-oss-120b` | `fireworks` | `OpenAI` | `openai/gpt-oss-120b` |
| `glm-4.5` | `novita` | `zai-org` | `z-ai/glm-4.5` |
| `Qwen3-8B` | `openai_compatible` | `qwen` | `qwen/qwen3-8b` |

All three must match active, non-stealth existing `model_stats` rows. The importer does not invent or activate catalog models. Four review examples with empty source metadata are valid records but remain unmatched because their exact providers were not supplied. In particular, a dated GPT model must not be substituted with an undated catalog ID.

An empty response, all-rejected response, zero matches, missing required model, or a matched count more than 20% below the accepted baseline fails the coverage gate before score writes. The baseline is the highest successful matched-model count; failures never lower it. Deliberate reductions of the reviewed mapping set require an operator-reviewed baseline change rather than silently accepting lower coverage.

## Coverage reports

From the repository root:

```sh
pnpm --filter web exec tsx --tsconfig tsconfig.scripts.json src/scripts/enkrypt-coverage.ts --examples
pnpm --filter web exec tsx --tsconfig tsconfig.scripts.json src/scripts/enkrypt-coverage.ts --input /path/to/sanitized-response.json
```

The tool reads Kilo's unauthenticated public catalog and reports matched, unmatched, ambiguous, and rejected records plus the required-model gate. It does not use the provider API key or a database. Reports omit score values but contain model identities; review them before publishing, particularly if the input contains nonpublic identities.

The representative fixture contains seven review examples, with synthetic numeric/null scores and a clearly synthetic provider for the four incomplete identities. Against the public catalog, these examples yielded **3 matched, 4 unmatched, 0 ambiguous, 0 rejected**, with all three required models present. This is not a report on the full 267-record response. A full sanitized payload was not provided for this implementation.

Attach the full report, its collection time, and the tested code revision to the release evidence. Do not attach credentials or unsanitized responses to a public PR.

## Snapshot freshness

Stored snapshots contain:

- `ingestedAt`: when the successful import transaction prepared the snapshot, not when the upstream evaluation occurred.
- `evaluatedAt: null`: evaluation time is unknown; the upstream contract does not supply it.

Published snapshots also contain:

- `staleAfter`: `ingestedAt` plus 26 hours, allowing two hours beyond the daily cadence.
- `freshness`: `fresh` before that boundary and `stale` at or after it, computed when serializing each response rather than cached as a fixed value.

Failures retain last-known-good scores. They remain publishable, marked stale when appropriate, until publication is disabled. Reimporting unchanged scores advances ingestion freshness only; it does not establish a recent evaluation. Future-dated or malformed snapshots are not published. Legacy snapshots containing only the draft's former `lastUpdated` field are omitted until a successful new import replaces them.

## Operational state and counters

`enkrypt_sync_state` contains one row for the latest operational state: attempt identity, timestamps, outcome, safe failure category, counters, accepted coverage baseline, and delivered-alert suppression. Score snapshots and the successful state update commit in the same transaction. Failed or superseded runs cannot replace a newer successful run. No score values, payload bodies, credentials, or historical evaluations are stored in this status row.

| Counter | Meaning |
|---|---|
| `fetchedCount` | Records in the received array, including rejected records. |
| `rejectedCount` | Records rejected by record validation. |
| `matchedCount` | Unambiguous accepted records mapped to distinct eligible models. |
| `unmatchedCount` | Valid records with no reviewed identity or no eligible catalog target. |
| `ambiguousCount` | Valid records involved in conflicting or duplicate-target matches. |
| `updatedCount` | Committed model updates; failed transactions report zero committed updates. |

For a classified complete array, fetched equals rejected plus matched plus unmatched plus ambiguous. Unknown counters remain absent/null after failures that occur before parsing; they are not invented as zero. Disabled runs are explicitly skipped and do not advance last success. A missing API key is reported as a configuration failure without performing a fetch or database write; the health endpoint independently reports that configuration condition.

## Schedule, monitoring, and alerts

- Daily ingestion: `GET /api/cron/sync-enkrypt`, scheduled at **04:00 UTC**.
- Independent health check: `GET /api/cron/check-enkrypt-health`, scheduled **hourly at minute 30**.
- Both endpoints require the configured `Authorization: Bearer <CRON_SECRET>` header. Use a secret-aware client; do not include actual header values in public reports or logs.

A healthy sync responds with `status: "succeeded"`, its ingestion time, and counters. Disabled ingestion responds with `status: "disabled"`. Failures return HTTP 500 with a bounded category and any known counters or numeric upstream status.

The health endpoint uses the primary database, is `no-store`, and returns HTTP 200 for healthy/disabled or HTTP 503 for degraded, stale, never-successful, or unavailable state. It reports the last successful sync independently of the most recent attempt. No success within 26 hours is stale. A newly enabled installation with no success is unhealthy until its initial successful import.

An unhealthy production health check sends a notification through the existing administrative Slack notification integration. Staging/local checks simulate delivery instead. Alerts with the same reason are suppressed for 24 hours only after delivery is recorded; recovery or a different failure reason re-arms delivery. Notification failures do not consume suppression. A database outage can prevent suppression from being recorded and may cause repeated alerts until recovery.

Configure an independently scheduled external monitor to call the authenticated health endpoint and alert on HTTP 503, timeouts, missing responses, or authentication failure. The hourly job detects missed ingestion invocations, but cannot detect the scheduler stopping all jobs. Assign an operational owner, notification destination, and recovery policy before enabling ingestion. Verify actual delivery rather than assuming that checked-in schedules or webhook variables prove it works.

Scheduled-job events use `web.sync_enkrypt` and `web.check_enkrypt_health`, with safe scalar categories, counters, timestamps, and run identifiers. Error reporting discards raw exceptions and response bodies. Useful failure categories are:

| Category | Investigation |
|---|---|
| `configuration` | Check enabled flags and server-side key configuration. |
| `authentication` | Check upstream access/expiry; rotate through the approved secret workflow. |
| `rate_limited` | Inspect bounded retry outcomes and provider limits. |
| `timeout`, `network`, `upstream` | Check provider availability and connectivity. |
| `response_validation` | Review a privately obtained, sanitized contract sample. |
| `coverage` | Inspect the identity-only report, required models, and accepted baseline. |
| `database` | Check migration/application compatibility and database availability. |
| `superseded` | A newer attempt owns the status row; inspect the newer run. |
| `unexpected`, `monitor_error` | Investigate using safe run metadata; do not enable raw payload logging. |

## Release checklist

- [ ] Confirm permission to redistribute the selected fields through public catalog APIs, including any attribution or retention requirements.
- [ ] Review a full sanitized response and produce the matched/unmatched/ambiguous/rejected report against the actual catalog.
- [ ] Confirm the agreed three-model gate and review every additional mapping before adding it.
- [ ] Apply the migration and provision the key in an isolated staging environment; keep publication disabled initially.
- [ ] Demonstrate an authenticated staging sync with all required models and nonzero committed updates.
- [ ] After redistribution approval, enable staging publication and verify the three catalog records, preserved provenance, unknown evaluation dates, and freshness fields.
- [ ] Verify repeated imports preserve sibling benchmarks; failures retain scores and last success while producing actionable categories.
- [ ] Exercise stale/coverage-drop monitoring, notification delivery, suppression/recovery, and both independent disable controls.
- [ ] Configure and test the external monitor, including scheduler-wide failure detection.
- [ ] Verify the intended production cron registration, credentials, migration, monitor owner, and notification destination before production enablement.

The representative examples and automated tests do not satisfy the unchecked live, deployment, or redistribution gates.
