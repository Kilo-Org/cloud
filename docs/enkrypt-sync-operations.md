# Enkrypt score ingestion operations

This integration adds benchmark metadata, not runtime safety enforcement, routing rules, or a UI. The upstream `provider` and `source` describe the evaluation provenance; they do not establish that Kilo's serving providers were evaluated.

Code-review readiness is separate from production readiness. Keep ingestion and publication disabled until the relevant deployment, monitoring, and redistribution gates below are complete.

## Controls and setup

Both flags default to disabled; only the exact string `true` enables them.

| Setting | Effect |
|---|---|
| `ENKRYPT_SYNC_ENABLED` | Enables ingestion and mapped-model enrollment in the existing catalog sync. Does not enable publication. |
| `ENKRYPT_PUBLICATION_ENABLED` | Allows stored scores in public catalog/statistics responses. Does not enable ingestion. |
| `ENKRYPT_API_KEY` | Server-side authentication for the public leaderboard endpoint. Never include its value in reports or logs. |

An operator must use the shared environment workflow in [DEVELOPMENT.md](../DEVELOPMENT.md). For staging only:

```sh
pnpm web:env set ENKRYPT_API_KEY --only staging
pnpm web:env set ENKRYPT_SYNC_ENABLED --only staging
pnpm web:env set ENKRYPT_PUBLICATION_ENABLED --only staging
```

These commands are user-run. Verify database isolation, apply the single consolidated Enkrypt migration, and run the protected catalog bootstrap before the first score sync. Keep publication disabled until redistribution is approved. Redeploy the intended environment after changing a key or flag; existing instances retain their previous configuration.

To stop ingestion, disable `ENKRYPT_SYNC_ENABLED` and redeploy. To suppress already-stored scores independently, disable `ENKRYPT_PUBLICATION_ENABLED` across serving deployments. Suppression does not delete snapshots or recall responses already delivered to clients.

## Contract and identity

The response must contain `status: "success"` and a `data.scores` array. Records are validated independently: invalid records are counted and rejected without discarding unrelated valid records. Scores must be numeric, null, or absent as permitted by the schema. Empty, null, and missing source metadata remain unchanged.

Only explicit, reviewed identity tuples map to catalog IDs. Runtime matching does not infer provider prefixes, substitute sources, normalize names, or merge dated/free/reasoning variants. Duplicate or conflicting matches are skipped as ambiguous.

The required gate remains:

| Model | Provider | Source | Catalog ID |
|---|---|---|---|
| `gpt-oss-120b` | `fireworks` | `OpenAI` | `openai/gpt-oss-120b` |
| `glm-4.5` | `novita` | `zai-org` | `z-ai/glm-4.5` |
| `Qwen3-8B` | `openai_compatible` | `qwen` | `qwen/qwen3-8b` |

The existing six-hour catalog sync enrolls additional mapped models only from its public catalog. It does not reactivate additional-only models that an operator disabled. Recommendations remain derived from the monitored-model set, independently of Enkrypt enrollment.

Empty/all-rejected responses, zero matches, missing required models, or a matched count more than 20% below the highest successful count fail before score writes. An intentional reduction of the reviewed mapping set requires an operator-reviewed baseline adjustment.

## Efficient polling and freshness

The daily job normally makes one bounded public-leaderboard request. The endpoint currently advertises neither ETag nor Last-Modified validators, so conditional HTTP caching is not assumed.

Validated content fingerprints determine whether a score changed. Changes use one bulk update; identical results cause zero model-row writes. Only the small operational-state row advances, retaining the latest verification time/hash per matched model. This is not a score-history store.

| Field | Meaning |
|---|---|
| `ingestedAt` | First import or last change to score content/provenance; unchanged by identical polls. |
| `evaluatedAt` | Always `null`: upstream evaluation time is unknown. |
| `lastCheckedAt` | Latest successful check bound to this exact content hash; falls back to `ingestedAt` when verification is unavailable. |
| `staleAfter` / `freshness` | Stale at 26 hours after `lastCheckedAt`, allowing two hours beyond the daily cadence. |

A shared, single-flight, five-minute primary-database snapshot serves list, detail, and gateway lookups. Unknown slugs do not create cache entries. Freshness and publication eligibility are checked after asynchronous work, immediately before serialization; responses remain `no-store`.

Failed refreshes may retain base model metadata, but an expired or invalidated snapshot cannot authorize Enkrypt publication. Provider outages can still expose last-known-good scores as stale when model eligibility remains verifiable. Administrative model changes and completed syncs invalidate the current instance's cache; other instances have the five-minute eligibility bound. Failed refreshes have a short retry cooldown.

## Results and failures

Successful runs return `checkedAt`, fetched/rejected/matched/unmatched/ambiguous/updated counts, and derived `unchangedCount`. Positive matched coverage with zero updates is healthy. Disabled runs are explicitly skipped and do not advance last success.

The latest operational state, changed snapshots, and verification entries commit atomically. Failures preserve earlier successful data. Superseded attempts cannot overwrite a newer attempt's state.

A database transport failure after a transaction starts has an uncertain commit outcome. The response omits commit counters rather than claiming zero writes; retrying is safe because content-identical scores are not rewritten. Inspect the health response and retry through the authenticated sync endpoint rather than manually editing scores.

Errors use bounded categories such as `configuration`, `authentication`, `rate_limited`, `response_validation`, `coverage`, `database`, `timeout`, `network`, `upstream`, and `superseded`. Diagnostics never need credentials, authentication headers, raw provider responses, or original database exceptions.

## Scheduling and monitoring

| Endpoint | Owner and cadence |
|---|---|
| `GET /api/cron/sync-model-stats` | Existing six-hour catalog job; run once for initial bootstrap. |
| `GET /api/cron/sync-enkrypt` | Daily at 04:00 UTC in the designated cron-owning deployment. |
| `GET /api/cron/check-enkrypt-health` | Read-only probe polled by one independently scheduled external monitor. |

All require the configured cron authorization header. Use a secret-aware client and keep header values out of public artifacts.

The health probe returns HTTP 200 for healthy/disabled and HTTP 503 for failed, stale, never-successful, or unavailable state. It reads the primary database, reports the last successful run separately from the latest attempt, and becomes stale after 26 hours without success. It does not mutate database state or send notifications.

The external monitor owns alert delivery, deduplication, recovery, and escalation. Configure it to alert on HTTP 503, timeouts, missing responses, and authentication failures, and test delivery before enabling ingestion. It must run independently of the application scheduler so it can detect scheduler-wide failures. There is no second application health cron or custom Slack delivery state.

## Coverage evidence

```sh
pnpm --filter web exec tsx --tsconfig tsconfig.scripts.json src/scripts/enkrypt-coverage.ts --examples
pnpm --filter web exec tsx --tsconfig tsconfig.scripts.json src/scripts/enkrypt-coverage.ts --input /path/to/sanitized-response.json
```

Reports contain identities and classifications, not score values or credentials. Review them before publishing. Fixtures use synthetic metrics; authenticated local checks are not substitutes for staging validation or redistribution approval.

## Follow-up release actions

- [ ] Resolve base-branch conflicts and regenerate the single migration against the final base before merging.
- [ ] Obtain approval to redistribute the selected score fields, including attribution/retention requirements.
- [ ] Provision staging configuration through the shared environment workflow, apply migrations, and bootstrap the catalog against an isolated database.
- [ ] Run authenticated staging syncs; verify coverage, unchanged-row preservation, advancing `lastCheckedAt`, and published metadata after approval.
- [ ] Verify provider failures retain prior scores, stale or unavailable eligibility suppresses publication, and both disable controls work.
- [ ] Configure one external monitor; test alerts, recovery, scheduler-wide failure detection, and the notification destination with the operational owner.
- [ ] Verify one production cron owner, deploy the approved revision, enable ingestion, and enable publication only after its approval gate is satisfied.
