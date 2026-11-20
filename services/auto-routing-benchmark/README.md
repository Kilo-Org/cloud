# auto-routing-benchmark

Cloudflare Worker that benchmarks candidate models and publishes the artifacts
that drive `kilo-auto/efficient` and `kilo-auto/frontier` routing. It is the **sole writer** of the
per-router routing tables and shared classifier winner; `services/auto-routing` and the `apps/web`
gateway only read them. See `docs/adr/0002-auto-routing-efficient.md` for the
design, invariants, and rollout/rollback.

## What it does

- **Classifier benchmark** — replays the 72 golden classifier cases through the
  production System One classifier (`classifyWithSystemOne` from
  `@kilocode/auto-routing-contracts/classifier`, OpenRouter `POST
  /api/v1/systemone`). Candidates are System One models (OpenRouter models whose
  `output_modalities` include `decisions`, e.g. `typesafe/jev-1.13`). Each case
  gets a weighted per-field score and a route hit (predicted
  `taskType/subtaskType` equals the golden route key — the only axes the
  decision engine reads); run summaries report both `accuracy` and
  `routeAccuracy`. The classifier winner is the cheapest model whose weighted
  `accuracy` meets `minAccuracy`. A failed call scores 0 and counts as a route
  miss; there is no fallback classification.
- **Decider benchmark** — runs the selected router's golden tasks per candidate through the real
  `kilo` CLI inside a Cloudflare Container and grades mechanically. Efficient uses `DECIDER_CASES`;
  frontier uses only `FRONTIER_CASES`, including its harder long-context tasks, tagged `frontier`.
  Results land in the decider registry (`benchmark_profiles`), keyed by
  `(router, model, variant, engine identity, repetitions)`. Engine identity includes the router
  and a hash of all selected dataset inputs. Each router's platform list and owner requests share
  that router's measurements; frontier measurements never satisfy efficient profiles.
- Normalized results live in D1 (`BENCH_DB`); published artifacts are cached in
  the shared `AUTO_ROUTING_CONFIG` KV namespace (publish = delete the keys so the
  next read repopulates from D1).

## Router isolation and activation

`router` is `efficient` or `frontier`; omitted API selectors default to `efficient`.
Each router owns its saved decider model list, catalog-expanded effort entries, registry,
runs, routing table, and publication cache key. Accuracy thresholds, `accuracyNoiseBand`,
token profile, and switch horizon are configured independently.
The classifier and its winner remain shared:
classifier runs use the efficient configuration even when requested from the frontier view.
Classifier inference billing is owned by the routing worker. Usage IDs and durable delivery
objects include the router, so an otherwise identical call on another router cannot be
deduplicated as a retry of the first call.
Capability lookups derive candidate IDs from the selected router's table; the capability
cache remains a shared model-ID union because modalities and context limits belong to models.

Both routers are custom-router bases (ADR 0005): owner profile admission, the owner queue,
custom router tables, and client evals accept `efficient` and `frontier`.
Owner work for a base uses that base's configuration, dataset, engine identity, and quota.

Client and direct-BYOK custom-router entries can explicitly link `measuredAs` to a globally
measured platform model. Same-name variants reuse the base router's live platform measurement;
other variants remain client-measured. Linked variants neither enter client eval plans nor accept
client uploads, and status reads do not admit additional platform work for them. Custom tables
preserve the entry's candidate identity and reprice the linked measurement at its owner's prices:
token means give exact costs, while older summaries use the blended input/output price ratio.
Missing client pricing means zero cost; an unpriceable linked summary is excluded from ranking.
Ready history remains available as stale when its identity changes or its model leaves the catalog.
`GET /admin/platform-measurements?router=efficient|frontier` lists models and variants with ready
global history for link selection, including owner-requested platform-key measurements.

## System-optimal policy settings

The daily platform sync recomputes each router's policy settings before publishing, and stores
the result on the router's `benchmark_config` row (`policy_computed`) with its `computedAt`,
`source`, and a short evidence string. The effective value of an auto setting is
`override ?? computed ?? stored default`, so an admin override always wins and clearing it
falls back to the system value. Publishing reads effective values only.

- `minAccuracy` and `accuracyNoiseBand`: chosen from a grid over the registry's measured
  summaries, scored on held-out cases (a deterministic sha256 train/held-out split of the case
  ids). The objective is mean held-out accuracy per estimated request dollar, subject to a
  quality floor, and the chosen point is the middle of the stable plateau rather than its edge.
  Insufficient held-out data (`< 20` distinct graded held-out cases summed over routes, or `< 2`
  evaluated routes) leaves the current value in place, as does a catalog or registry failure;
  production-derived settings are still saved in that case.
- `productionTokenProfile` and `switchHorizonTurns`: derived from production auto-request usage.
  The worker has no Postgres access, so it reads mean uncached/cached input tokens and the
  median requests per auto session from `GET /api/internal/auto-routing-benchmark/production-profile`
  on apps/web over a 6-hour window, with a 10-second timeout. An unavailable or slow endpoint
  leaves the previous computed values.
- Each setting has its own value schema. `PUT /admin/config` rejects an override that does not
  fit its setting (400), and stored overrides or computed values that do not fit are ignored.
- `frontierMinAccuracyDelta`, `switchCostFactor`, `bestAccuracySwitchThreshold`,
  `lowConfidenceThreshold`, classifier/decider repetitions, and `classifierMaxP95LatencyMs` are
  fixed serving constants with no config field and no admin override: the held-out benchmark
  scores single requests, so session-economics and measurement-effort knobs have no measured
  basis for a daily recomputation. The Policy tab shows each value and the reason it is fixed,
  read-only. A stored config that still carries one keeps parsing, and its value is ignored.
- Decider repetitions are fixed per router: Efficient measures every case three times, because
  with a few dozen cases per route one repetition lets noise decide which candidates clear the
  accuracy floor; Frontier measures once. Registry admission, run creation, profile currency,
  publish and client eval all read the same router value, and a profile is current only at
  its router's count.

An omitted Frontier pool uses its router-specific alias preset.
The worker benchmarks that pool before it publishes a complete Frontier table.
It does not fabricate measurements or reuse the Efficient table.

Frontier serves all authenticated callers through the benchmark router.
It has no per-user rollout toggle or mode-based legacy model selection.
Publish a complete Frontier table before deploying the gateway cutover.
Missing or invalid Frontier decisions return service unavailable without invoking a legacy or organization fallback model.
Authentication, organization access, privacy restrictions, and classification billing retain their existing checks.
Catalog annotations and pre-classification denial hints use visible Frontier table candidates, independently of Efficient custom pools.

Decider execution uses a global pool of reusable container slots, not run reservations.
An atomic D1 claim selects an eligible unfinished chunk from any running run whenever a
slot becomes free. Queued and executing claims both count against the limit.
The pool is bounded by `BENCHMARK_CONTAINER_BUDGET`, the queue consumer concurrency,
and container `max_instances`; increasing the platform ceiling requires a Cloudflare limit increase.
Containers are named by slot and run one CLI at a time. There are no fixed shard chains.
One-case chunks leave room for warmup, the existing empty-output retry, and grading within
the queue invocation deadline; prompts, variants, CLI timeouts, repetitions, cost accounting,
and CLI-reported latency remain unchanged.

`BENCHMARK_SCHEDULER_CONFIG` is a JSON object. Defaults are `slots: 250` and
`modelConcurrency: 12`. An optional `modelLimits` object overrides the model cap by exact
model id. `shares` defaults to
`{"efficient/platform":2,"frontier/platform":2,"efficient/user":1,"frontier/user":1}`.
The least-occupied weighted share receives the next eligible claim; unused shares are
borrowed without reservations or preempting active work. Model caps span variants and runs.
Only slots and model caps bound a claim. There is no per-provider limit: the gateway sends
each request to one aggregator (Vercel AI Gateway, else OpenRouter), which picks one
upstream, so the catalog's `inference_provider_ids` list says nothing about which provider a
chunk loads. Each router has an owner queue with its own share.

Admins can override `slots` and `modelConcurrency` at runtime, without a deploy, from the
Scheduler card on the admin panel's Benchmarks tab or with `PUT /admin/scheduler-config`.
Each limit resolves admin override, then `BENCHMARK_SCHEDULER_CONFIG`, then the default.
Overrides live in the single-row `scheduler_settings` D1 table; each dispatch pass reads it
once by primary key, so a change applies on the next completion or one-minute tick. The PUT
body replaces the whole override set: a missing or `null` limit clears that override. Values
must be integers from 1 to `BENCHMARK_CONTAINER_BUDGET`; anything else, including an unknown
key, is a 400. Until the web release after the provider-limit removal is promoted (ADR 0003,
invariant 7), the PUT also accepts and ignores the retired `providerConcurrency` and
`unknownProviderConcurrency`, and the response serves both as the container budget.
`modelLimits` still comes only from the env config and takes precedence over
`modelConcurrency` for its exact models.
`GET /admin/scheduler-config` returns each limit's `effective` value, its `source`
(`admin`, `env`, or `default`), the `override`, and the `fallback` used without one.

### Spend caps

Three USD caps bound what the benchmark can spend. They live in the same scheduler config,
so one admin save raises them without a deploy, and they are never unlimited: `0`, a negative
value and a missing value are all rejected, and a `null` override means "use the env value or
the default", never "no cap".

| Cap | Default | Bounds |
| --- | --- | --- |
| `perRunUsd` | 50 | one run's fresh execution cost |
| `perDayUsd` | 150 | every run's fresh cost, over one UTC day |
| `perOwnerDayUsd` | 25 | one subscription owner's pairs, over one UTC day |

Admission **fails closed**. Before a run row is written, the worker estimates the batch's
cost by running that run's own case selection — the dataset for `(router, revision)`, minus
what `initializeScheduledRun` would copy from an earlier run (re-measure baselines first, then
prior-results reuse, both gated by `minimumCaseRevisions`), for every repetition — and prices
each pair per context bucket from its own graded rows. Without a measurement it uses catalog
price times that case's own tokens. With neither, the pair is **refused**: an unpriceable
model is never admitted as if it were free. A forecast above the run cap, above the day's
remaining budget, or above the owner's remaining budget starts nothing.

A refusal drops no work. The pairs stay `pending`, a `benchmark_budget_holds` row records the
cap, the estimate and the remaining budget, and the console shows why they are waiting; the
next drain that fits admits them. Runs already in flight are bounded too: the day's ledger is
seeded once from the day's recorded fresh results (`case_results` joined to
`scheduler_executions`), so a run that started before the caps shipped sees the real spend at
its first claim. Dispatch then marks a run `paused` at whichever cap it reached, and the
lane-head query claims nothing for a paused run or one already at its own cap. A raised cap
(or the UTC day rolling) resumes it, as does `POST /admin/runs/:runId/resume`.

The day total is a running per-day, per-owner ledger written in the same batch as each fresh
result, so admission and the guard read one indexed row instead of aggregating
`case_results`. A reused copy is never counted: historical cost is not today's spend.

`benchmark_config.user_queue_paused` pauses the owner queue by itself: while set, the user
drain starts no run and owner admissions queue no rows, but subscription snapshots are still
recorded so a save during the pause loses nothing. The platform queue is unaffected.

```sh
curl -s -X PUT "$WORKER_URL/admin/scheduler-config" \
  -H "Authorization: Bearer $INTERNAL_API_SECRET_PROD" -H 'content-type: application/json' \
  -H 'x-updated-by: you@kilocode.ai' -d '{"modelConcurrency":12}'
```

Claims carry fencing tokens, and stale tokens cannot release newer ownership. A same-token
redelivery resumes its executing claim instead of being dropped: the Workers runtime can
cancel an in-flight queue invocation mid-case, so none of its error handling runs, and Queues
redelivers the message within about a minute. A resumed delivery skips completed cases,
reuses recoverable output, and never begins a ledgered paid case again. A queued lease lasts
30 minutes; an executing lease lasts 20 minutes, beyond the queue's 15-minute invocation
limit, and a resume keeps the running lease. The one-minute tick recovers abandoned claims;
completion refills slots immediately without waiting for a tick. Recovery and
infrastructure/grader waits are bounded to six claims, with 15–300 second backoff. Capacity
and unbilled provider-throttle waits do not create model-failure rows. A provider throttle
refunds its claim and counts against a separate budget of 16 throttle deferrals (about an
hour of backoff), so a briefly rate-limited model is paced instead of losing its lanes; after
that budget, the chunk falls back to the six-claim limit, so a persistent throttle still fails
its lane. The gateway exempts only the default benchmark user (`bot-internal-benchmark`)
from its free-model account limit; a `benchmarkUserId` override is limited like other accounts.

A dispatch pass reads current occupancy and the next pending chunk of every lane — one
`(run, model, variant, repetition)` chunk chain — and claims as many of those lanes as fit.
Both reads are index seeks: occupancy is bounded by the slot budget, lane heads by the
number of lanes, so cost does not grow with the pending backlog. Each claim is a
conditional `UPDATE ... WHERE id = ? AND status = 'pending'` that assigns a free slot.
Only one pass runs at a time; a pass holds a short lease row and a dispatcher that finds it
held returns immediately, because the holding pass has already read that wake's
completions. The per-minute tick is the backstop if a lease expires without a release, and
the `(status, run_id, model, variant, repetition, chunk)` index bounds lane reads.

A throttle cools only its own model: other models stay claimable, because a throttle names
no upstream. The cooldown is a deadline row rather than a stamp on every pending row, so one
throttle event costs a bounded write instead of rewriting the backlog.

Materialization writes chunks in bounded batches and checks the run's status once per batch
rather than per row. A chunk is inserted already completed when all of its cases have
results; that check is a `case_results` primary-key probe per case, so its cost follows the
batch, not the run. One initialization pass spends at most 20 seconds per run, and each batch
commits on its own: the next pass reads how many chunks every lane already holds and resumes
after that prefix, so a large run initializes over several passes instead of restarting from
its first lane. The `scheduler_runs` marker commits with the final batch, once every chunk
exists, and only marked runs are dispatched. Dispatch claims for initialized runs before it
materializes, and a second lease row keeps concurrent dispatchers from initializing at the
same time; a pass that completes a run's initialization claims again so its chunks start at
once.

Starting a decider run writes the run row and returns; it reuses nothing and materializes
nothing in the request. The first initialization pass copies every entry's compatible prior
results before it writes any chunk, so a run's chunks exist only once its reuse is complete.
A pass whose reuse fails writes no chunk, and the next pass repeats the reuse, which skips
rows the run already holds. The reuse statement filters the prior runs first and then seeks
each run's pair in `case_results`: D1 keeps no planner statistics, so the join order is
pinned with `CROSS JOIN`.

Initialization failures stay isolated to their run, so healthy runs can still dispatch.
A run without its saved execution identity fails and releases its claimed profiles.
Transient catalog or reuse failures leave the run eligible for another initialization attempt.

Run completion accounting reads every case result of the run, so it does not run per
completed chunk. A completion first asks whether the run still has scheduled work — an
index probe for a chunk that is pending, queued or active in a lane that has not
dead-lettered — and only settled runs are accounted. Chunks of a dead-lettered lane never
count as unsettled, so a run with a dead lane still settles once its live lanes finish, and
runs with no scheduler chunks (legacy whole-run work) are always accounted. The dispatch
sweep and the dead-letter path remain responsible for runs that settle without a train of
completions. Chunk recovery and the 24-hour prune batches are likewise bounded: recovery
completes only the runs that still hold unsettled chunks, the failed-lane check reads only
running runs' failed chunks, execution and marker pruning start from the per-run scheduler
markers, and chunk pruning walks the distinct run ids that still hold chunks, so a run that
stopped before its marker was written is pruned too.

Completed cases are skipped, and all final CLI outputs are persisted before grading.
A separate paid-execution ledger records when each paid case started and prevents automatic
repetition if a worker disappears after inference may have started but before an output was
saved. The container posts every completed case to the worker, and `not_started` for accepted
cases that provably did not spawn the CLI. A post the worker accepts on the first attempt
precedes the HTTP response. If the first post fails, the container answers the HTTP request
and keeps posting with backoff for up to about 5.5 minutes. Each callback carries the paid
attempt's start time, so a stale callback cannot replace a newer empty-output retry.

A request that never reached the container server is not a paid call. `BenchRunnerContainer`
turns the `@cloudflare/containers` 500s that precede forwarding ("Failed to start container",
and the runtime's "The container just exited" or "The container is not running" refusals)
into a 503 with `errorCategory` `container_not_reached`, which takes the container-capacity
path: the unbilled ledger row is cleared and the chunk is deferred. Other proxy failures
("Container suddenly disconnected", a closed port connection) can follow a delivered request
and stay ambiguous. When a retry cannot reach its container, an empty-output first attempt is
graded as it is, while a first attempt killed before any event is cleared and deferred the same
way. A case the ledger refuses to open because the chunk lost its lease, its lane already failed
or its run stopped is not ambiguous either: the chunk is released (`claim_lost`) without
recording a lane failure.

Output that arrives after its lane failed or its run became terminal is graded later by a
single-case recovery message. Recovery never starts inference. A per-case grading lease
prevents the live and recovery paths from grading the same output twice.
Unbilled throttle, provider-outage (5xx or "temporarily unavailable") and catalog-load
failures are cleared and deferred instead of measured, including one that ends a multi-step
run after partial text but before any billed answer. A CLI process killed by a signal before
its first event gets the same single retry as an empty completion; a timeout, a kill after
events, or an invalid-request rejection stays a measured failure.

A chunk that finds a ledgered case without output waits for it instead of failing its lane.
It keeps its slot, so the wait cannot oversubscribe the model or slot caps, and its
claim is redelivered every 30 seconds to recheck. The wait ends when the output arrives,
which the chunk then grades, or once the decider case timeout (180 seconds) plus the
container's delivery window (7 minutes) has passed since the case's latest paid call started
(an empty-output retry restarts it in the ledger). Only then does the case count as genuinely
ambiguous (a container hard-killed mid-flight, or a lost delivery): it fails its measurement
lane as infrastructure uncertainty instead of inventing a score or issuing another paid call.
A recheck mints no user token and warms no container.
Manual requeue creates a new run and may repeat that unknown case; compatible completed cases
and pending successful outputs are still reused.
Terminal scheduler rows are pruned in bounded batches after 24 hours. Benchmark history,
completed case results, and pending outputs remain available for compatible reuse.

Production benchmark deploys use `pnpm run deploy`. The wrapper holds the scheduler dispatch
lease, waits until no active chunks and no queued chunks with an unexpired queue lease remain,
applies D1 migrations, deploys, waits for the container rollout to finish, then releases the
lease. A queued claim whose queue lease expired cannot start, so it does not hold the drain;
`recoverChunks` returns it to pending. It renews the lease throughout and fails closed when
draining exceeds its limit. It never pauses or resumes operator-controlled queues.

Busy dispatch takes the lease back as soon as each pass releases it, so the wrapper first writes
a deploy intent: `scheduler_dispatch_lock` row 3 with a `deploy-intent-` token and a lease that
ends with the wrapper's lock wait (`BENCHMARK_DEPLOY_LOCK_TIMEOUT_MS`, 60 seconds by default).
While that lease is unexpired, no dispatch pass takes row 1, so the wrapper takes it when the
current pass ends, at most one dispatch lease (20 seconds) later. It retries at the poll interval
(`BENCHMARK_DEPLOY_POLL_INTERVAL_MS`, 5 seconds), or sooner when the holder's lease ends, and
clears the intent once it holds row 1 or gives up; a dead wrapper's intent expires with its lock
wait. A worker deployed before this change ignores the intent: if dispatch is busy, deploy it
under an operator pause.

Each deploy records a hash of the container inputs (the `containers` configuration, each local
image's Dockerfile, and every file in its build context, even when the Dockerfile sits outside
that context) as the Worker version message
`container-inputs:<sha256>`. The rolled-out hash is the message of the Worker version that was
live when the container application last changed, so a deploy whose image never reached the
containers is not trusted. When the rolled-out hash matches, the wrapper deploys with
`--containers-rollout none`, so running containers are not replaced. A different, missing or
unreadable hash deploys with the configured rollout, and a failed deploy without a rollout is
retried with it. After a rolling deploy the wrapper polls `wrangler containers info` until the
application has no `active_rollout_id`, for at most `BENCHMARK_DEPLOY_ROLLOUT_TIMEOUT_MS`
(15 minutes by default), and then releases the lease either way.

When the rolled-out hash matches and every file in `migrations/` is recorded in
`d1_migrations`, the wrapper deploys without the lease and without draining. In-flight
invocations finish on the version that accepted them. Each `BenchRunnerContainer` keeps its old
code until its deferred code update resets it (at most 5 minutes after the deploy); the reset
drops the Durable Object's request to the container, but the container keeps the case running
and posts the result to `/container/case-result`, and the chunk waits for that output. A drained
deploy does not avoid that reset either: it lands after the lease is released, on work
dispatched since. A pending or unreadable migration list, or an unknown hash, takes the full
drained path.

An operator pauses dispatch by holding `scheduler_dispatch_lock` row 1 with a token that starts
with `operator-pause-` and an unexpired lease. The wrapper treats that row as the dispatch hold:
it never acquires, renews, releases or modifies it, still waits for queued and active chunks to
drain, and verifies the same token with an unexpired lease before migrations, before the deploy,
throughout the deploy and after it. It fails closed if the pause disappears, changes or expires,
and logs `operator_pause_retained` without the token. Any other unexpired owner is contention.
Resume dispatch after the deploy with:

```sql
UPDATE scheduler_dispatch_lock SET token=NULL, lease_until=0 WHERE id=1 AND token LIKE 'operator-pause-%'
```

Diagnostic events contain run, model, variant, repetition, case, chunk, slot, outcome and
safe error categories. They never contain claim tokens, prompts, model output or raw stderr:

| Event | Use |
|---|---|
| `benchmark_case_execution_started` / `benchmark_case_execution_retry_started` | Paid attempt start and output deadline |
| `benchmark_scheduler_wait` | Retry, wait or lane-failure reason and `errorCategory` |
| `benchmark_container_result_*` | Callback delivery and worker persistence |
| `benchmark_output_recovery_*` / `benchmark_late_output_graded` | Late output handling |
| `benchmark_decider_run_completed` | Expected, measured, missing, failed-lane and error coverage |

Efficient publications invalidate `routing_table_v1`; frontier publications invalidate
`routing_table_frontier_v1`. Router, engine/dataset identity, ranking settings, and contributing
measurements are included in routing-table version hashes.


## Platform model selection

- Select a model, not one effort, in the platform configuration.
- An omitted Efficient pool defaults to `~deepseek/deepseek-flash-latest`; an omitted Frontier pool defaults to `~openai/gpt-sol-latest`.
- New admin forms use these presets. Explicit saved pools remain unchanged, and an explicit empty pool is invalid.
- Admission uses the authenticated catalog for the benchmark identity, including its organization context.
- Resumed runs preserve their saved user and organization scope. Configuration defaults do not replace a saved personal execution scope.
- The worker applies the CLI's tool-support rule and validates exact reasoning variants before scheduling.
- The drain also requires at least 20,000 input tokens after the completion budget the CLI reserves: catalog `context_length` minus `min(top_provider.max_completion_tokens || max_completion_tokens || 20% of the window, 32,000)`. The CLI harness prompt alone is about 16.6k tokens. A smaller pair is registered, then its profile fails with a context-window reason before any paid call. An absent context length is admitted.
- Platform and owner pools share measurements for identical concrete model, variant, engine, and repetition settings.
- Variants must contain explicit `reasoning.enabled` or `reasoning.effort` controls. Unrelated presets do not create benchmark entries.
- A model without reasoning controls creates one `(model, null)` entry.
- An unavailable model fails its profile without blocking unrelated entries. Catalog request failures leave the existing snapshots intact.
- Catalog requests have a bounded deadline, including body reads.
- Manual and automatic selections use the same expansion. Existing saved effort selections no longer restrict platform measurements.
- Status responses preserve requested alias IDs. Routing tables contain measured concrete IDs.

### Daily alias snapshots

- New subscriptions resolve once when admitted. Existing subscriptions check for target changes daily at 05:00 UTC.
- Queue dispatch, publication, policy edits, and status reads use persisted targets. They do not silently retarget an existing alias.
- An unchanged target with current measurements needs no benchmark.
- A changed target reuses current cached measurements or enters the normal benchmark queue.
- The previous serving target remains active until every replacement variant is ready.
- Resolution failures, unavailable replacements, and failed measurements retain the previous serving target. A target that is still saved but has no ready measurement keeps serving instead of dropping out of the routing table, and the hold is logged as `benchmark_alias_serving_held`.
- Removing an alias stops its subscription from following later updates.
- Daily target changes do not consume the owner's request quota.
- An unchanged concrete ID has no automatic measurement expiry. Use targeted refresh after a confirmed provider change.

The 05:00 run covers platform aliases and every owner subscription on both routers, in bounded
work units it can resume: the platform aliases are re-resolved once, then owners are reconciled a
keyset page at a time (`benchmark_daily_alias_sync`, one row per router). The one-minute tick
continues an unfinished day, and a failed catalog resolution is retried on later ticks the same
day until 30 attempts are spent. Each step of the daily branch — stale sweep, alias sync,
registry sync, policy recomputation, drain, publish — runs in its own isolation, so one failure
does not skip the others, and one `benchmark_daily_sync_summary` event per router carries every
step's outcome. Per-owner failures are logged as `benchmark_subscription_daily_failed` and do not
stop the pass.

Existing benchmark subscriptions retain their persisted alias targets. Backfill known owners
with the full model list before relying on daily coverage for historical pools.
Send the existing full pool to `POST /admin/profiles/subscriptions`:

```json
{
  "ownerType": "user",
  "ownerId": "owner-id",
  "entries": [{ "model": "~vendor/latest" }]
}
```

This authenticated endpoint replaces the owner's tracked benchmark models without editing
its custom router. Send `entries: null` to remove its subscriptions.
Use `restorePrevious: true` only to compensate a failed router save.
Ordinary removal and re-addition resolve a new subscription instead of restoring its previous target.
Apply the additive D1 migration and deploy the benchmark worker before resuming paused benchmark queues.



### Unavailable models and targeted refresh

A confirmed lookup failure for the requested model is not a quality score.
It fails that exact profile and stops its remaining queued work.
Already executing cases retain their slots and paid-execution records until they settle.
Ordinary incorrect answers and genuine model failures retain their existing scoring.

Use `POST /admin/registry/refresh` with explicit concrete model/variant pairs:

```json
{
  "router": "efficient",
  "mode": "repair_unavailable",
  "entries": [{ "model": "vendor/model", "variant": null }]
}
```

- `repair_unavailable` resets only selected profiles with recorded model-lookup failures.
- `refresh` explicitly invalidates selected current measurements, including otherwise valid ready profiles.
- Executable pairs become pending. Unavailable pairs remain failed instead of entering another doomed run.
- The response lists `refreshed`, `unavailable`, and `skipped` pairs.
- A selection containing an in-flight measurement returns conflict without partial changes.
- Historical results remain available for inspection. The invalidation cutoff prevents their reuse by refreshed pairs.
- Other profiles and ordinary retry reuse remain unchanged. No global engine-version bump occurs.

The refresh endpoint handles affected `ready` rows directly. The failed-only requeue endpoint cannot repair them.
Container callbacks are bounded by ten attempts over about 5.5 minutes. Exhausted delivery logs
contain categories, not credentials or result contents.

Each pair uses its own CLI variant, results, cost, latency, and registry provenance.
The worker admits bounded oldest-first registry batches independently of available execution slots.
New routing tables rank exact pairs and emit `variant`, not `reasoningEffort`.
Legacy nullable effort storage columns remain. Router isolation requires D1 schema migration;
existing rows stay in the efficient namespace, with noise band 0.05 and frontier delta 0.

The admin panel shows measured coverage and pending, running, or failed efforts per model.
Each route starts collapsed with its first-ranked pair, accuracy, and cost.
Expand a route to inspect every ranked model/effort pair.

## Ranking

- `rankCandidates` (`@kilocode/auto-routing-contracts`) orders every route's candidates.
- A candidate competes within the router's `accuracyNoiseBand` of its effective `minAccuracy` (default noise band 0.05).
- Frontier's effective threshold is `min(1, minAccuracy + frontierMinAccuracyDelta)`. The delta is a fixed policy constant of 0, not a configured value, so the frontier router uses its own system-computed `minAccuracy`.
- Both routers share candidate ranking, with separate validation objectives over their own measured pools.
- Efficient minimizes estimated request cost without reducing the current policy's validation accuracy.
- Frontier maximizes validation accuracy without increasing the current policy's estimated request cost.
- Daily re-evaluation includes the current effective thresholds in its validation grid.
  Incomplete, unmatched, or duplicate case coverage leaves the current settings unchanged.
  Equivalent outcomes keep the current thresholds.
- These request-level validation objectives are proxies, not verified full-task success or total task cost.
  The grid selects settings; it does not provide independent evidence of improvement.
  Freeze the policy before evaluating untouched full tasks and their complete costs.
- `productionTokenProfile` and `switchHorizonTurns` still use production usage estimates.
  Admin overrides retain precedence over computed settings.
- Competing candidates are ordered by `estimatedRequestCostUsd × effectiveLatency^1.5 / wilson^15`, lowest first. With known TTFT, `effectiveLatency = p50TtftMs + LATENCY_TOTAL_WEIGHT × p50LatencyMs`, where the exported `LATENCY_TOTAL_WEIGHT` is 0.15 (tuned on a fully streamed offline sweep); without TTFT, total `p50LatencyMs` alone preserves legacy ordering.
- Published `estimatedRequestCostUsd` adds the configured input profile to the observed per-pair benchmark cost.
  Fresh selection uses known request tokens at the prompt price, without assuming cache hits.
  Unpriced candidates retain their published estimates.
  The observed benchmark cost remains a limited base estimate, not a prediction of full-task output or remaining turns.
  Tables without stored noise-band metadata retain their published ordering until republished.
- `wilson` is the Wilson lower bound (z = 1) of accuracy over the candidate's measured `cases`. A well-measured candidate beats a thinly measured one at equal accuracy. Without `cases`, raw accuracy is used.
- A candidate whose `estimatedRequestCostUsd` is exactly 0 outranks every paid candidate inside the accuracy band and takes no cost term (ADR 0005): $0 candidates are ordered by `effectiveLatency^1.5 / wilson^15` alone, so a free-but-slow or thinly measured one still loses to a free candidate with latency and coverage. Paid ordering is unchanged. Client models in a custom router are the usual source of $0.
- The other candidates follow by accuracy, then cost.
- When `lowConfidenceThreshold` is set and the classifier's route confidence is below it, the worker picks the most accurate eligible candidate of the route instead of the first-ranked one.
- `meetsThreshold` stays strict (`accuracy >= minAccuracy`) for sticky routing.
- The ranking policy version is part of every registry table version, so a policy change republishes.

Published tables retain measured total latency, time to first token, and the policy noise band through D1 storage.
If every final candidate lacks total latency, request-time repricing compares cost and Wilson-adjusted accuracy without a latency factor.
Unknown measurements remain unknown; a candidate missing latency remains conservative when another candidate has measured latency.

The optional `effortByComplexity` mapping filters each model to its measured variant before fresh model selection.
The filter preserves published relative ordering and cannot restore an ineligible pair.
Known request pricing then re-ranks those final pairs within the stored quality band.
Cheapest mode skips the complexity mapping.
Sticky decisions keep their existing exact-pair identity and cache-switch economics.
Sticky-immediate turns retain the incumbent variant until classification is available.

Platform and custom-table builds read `case_results` for each ready pair's exact
provenance run and join the committed `src/datasets/case-complexity.json` labels.
Missing labels are ignored. Each route/model/bucket ranks its measured variants
with the same value policy, falling back to the route-level variant when fewer
than six distinct graded cases are available. Mappings are persisted with the
table and included in its version identity.

Apply the additive routing-evidence migration before deploying readers that select its columns.
Deploy the benchmark writer and republish from ready measurements to populate the new evidence.
Do not backfill old policy bands or latency from current configuration or unrelated profiles.


Regenerate the labels with the production classifier and gateway normalization:

```bash
OPENROUTER_API_KEY=... pnpm --filter auto-routing-benchmark exec tsx scripts/label-case-complexity.ts
```

If a classifier call fails, the script atomically saves completed labels to
`<output>.checkpoint` and identifies the failed case without changing the
published dataset. Use `--resume` to read that checkpoint. Only a successful
complete run atomically replaces the output and removes the checkpoint.

## Grading

- Decider cases use mechanical checks (`exact`, `contains_all`, `regex`, `json_equal`) wherever an answer can be checked.
- `judged` checks, at most 30% of a route, are graded by a System One model (`typesafe/jev-1.13`). The case score is its probability that the answer meets the rubric.
- Calibrate the grader with `pnpm judge:calibrate --in labels.jsonl` or `--from-mechanical cases.json`. The command reports accuracy, the Brier score and a reliability table.
- Grader cost is logged per job. It is not added to the model's `cost_usd`.


## Scoreboard

Build a versioned latency, cost, and quality scoreboard without changing routing:

```bash
pnpm --filter auto-routing-benchmark scoreboard build --label baseline --table table.json --prod prod.json --replay replay.json --out baseline.json
pnpm --filter auto-routing-benchmark scoreboard build --label candidate --table live --prod prod.json --replay replay.json --out candidate.json
pnpm --filter auto-routing-benchmark scoreboard compare baseline.json candidate.json
pnpm --filter auto-routing-benchmark scoreboard compare baseline.json candidate.json --relative-only
```

`--table` defaults to `live`, which reads the latest published platform table and
the current classifier winner from remote D1 through Wrangler. File inputs are
validated; table candidates may include optional nullable `p50LatencyMs`. Live
latency comes from each exact model/variant's ready, current-engine/repetition
registry profile and its measuring-run summary for that route, or is null if absent.
The live input also retains the published token profile, switch horizon, candidate
pricing, and request-cost estimates; stored JSON fields are decoded and validated.
Production and replay inputs are optional. Without production input, benchmark
weights are uniform over table routes; otherwise they use the observed route mix.
Missing routes and null benchmark metrics are excluded and the remaining weights normalized.
Quality includes benchmark accuracy and classifier route accuracy; supplying `--sweep`
also evaluates the exact first model/variant picks on held-out cases.
`benchmarkP50Weighted` is the weighted benchmark model latency, not production TTFT.
Use `--relative-only` for PR bodies so raw production measurements stay local.
Unavailable comparisons are `n/a`; rows unavailable on both sides are omitted.
Axis summaries are `mixed` only when metrics both improve and worsen, and `flat`
when no comparable metric improves or worsens.

Simulate production-input-aware ranking against the published table without spending
on benchmarks or publishing a routing change:

```bash
pnpm --filter auto-routing-benchmark scoreboard build --label baseline --table live --pricing live --cost-profile p.json --out baseline.json
pnpm --filter auto-routing-benchmark scoreboard build --label candidate --table live --pricing live --cost-profile p.json --rerank-profile p.json --out candidate.json
pnpm --filter auto-routing-benchmark scoreboard compare baseline.json candidate.json --relative-only
```

Both profile flags take JSON with `uncachedInputTokens` and `cachedInputTokens`
(nonnegative token counts). `--rerank-profile` re-ranks each route using the table's
accuracy threshold and the contracts ranking policy before computing all metrics.
Without it, the published order is preserved. `--cost-profile` only affects the
estimated request cost; it takes precedence over the rerank profile, which otherwise
also supplies the cost estimate. If neither flag is supplied, the estimate uses the
table's `productionTokenProfile`, or just the benchmark cost when that is absent.

For held-out measurement without deploying, set `OPENROUTER_API_KEY` and save pairs
as `[{"model":"provider/model","variant":null}]`. `--suite efficient` (default) selects
`DECIDER_CASES`; `--suite frontier` selects only `FRONTIER_CASES`, including its own
harder long-context cases. Long-context prompts are materialized deterministically
from each case's generator, seed, and target size. Efficient long-context cases target
32k, 96k, and 160k tokens; frontier cases target 160k. These are deterministic size
estimates using combined system/user characters divided by four, not model-specific
tokenizer counts. The long-context set covers all 12 implementation, debugging,
refactoring, and investigation routes with 36 efficient and 24 frontier `json_equal`
checks. Agentic cases run through the real Kilo CLI container; all other cases use
OpenRouter directly with streaming enabled.
The sweep grades rubric cases with the decider judge and hashes case ids into stable
train/held-out splits. `--rebuild-from-sweep` ranks train data only with Wilson counts,
pricing, and the cost profile; both builds evaluate exact first picks on held-out
accuracy, estimated request cost, wall-clock latency, and TTFT
(`quality.heldOut.p50TtftMsWeighted`, compared on the latency axis).
Supply `--complexity-labels src/datasets/case-complexity.json` with
`--rebuild-from-sweep` to learn complexity-specific effort choices from training
cases only. Held-out accuracy, cost, latency, and TTFT then aggregate the raw
per-case results of the mapped variant for each bucket, not the route-level
variant's overall summary. Without labels, the existing route-level evaluation
is unchanged.
Direct TTFT is time to the first nonempty content or reasoning delta. Streaming
usage frames are cumulative receipts: a later billing frame supersedes an earlier
one and is never added to it. Without BYOK, `usage.cost` is the total charge.
With BYOK, `usage.cost` is only the router fee, so the row cost is that fee plus
`cost_details.upstream_inference_cost`; either value alone leaves the total
unknown (`costUsd: null`). Container TTFT uses the first text event timestamp (or text
`time.start`) relative to request start, and is null when timestamps are unavailable.
Legacy sweeps without TTFT remain readable and do not substitute total latency.
Missing picks are excluded; `quality.heldOut.routes` reports coverage.
`--max-usd` compares known model and grader spend only. In-flight requests can
overshoot it; this stop is not a financed bound on total charges.
An unknown model cost stops new model and paid-judge requests across workers.
Mechanical checks continue. Already dispatched work finishes and retains its receipts.
Resume preserves this stop when any stored row has unknown cost. A request blocked
before dispatch creates no result row and remains unattempted for a later resume.
Direct and container requests send one attempt. HTTP and transport failures do not
trigger automatic redispatch because the earlier attempt can have an unknown charge.
The row retains an unknown cost; this does not create a funded reservation.
An HTTP status alone does not supply a complete billing receipt, including BYOK
provider charges and auxiliary service fees. Do not infer a zero total charge.
Legacy null-cost rows remain blocked without independent billing evidence;
an old error string is not proof that no earlier request reached a provider.
Atomic checkpoints every 200 cases retain each pair's raw `results`;
`--resume sweep.json` requires the same suite and pairs, skips completed
pair/case/repetitions, and retains accumulated spend.
Infrastructure/grader failures are excluded from graded `cases` and counted in summary
`errors`; empty answers score zero. Missing usage still permits mechanical grading.
New paid judging stays blocked; judged rows without a grade record `grader_failed`.
An unknown `costUsd` excludes that row from the cost mean. Graded training candidates
with unknown cost still compete at the route's maximum known request-cost estimate
(or benchmark cost zero if the entire route lacks costs), without imputing held-out cost.
Recompute old summaries without
an API key or network calls using
`sweep:offline --summarize-only --resume sweep.json --out corrected.json`;
old missing-usage rows without saved answers remain excluded.

```bash
pnpm --filter auto-routing-benchmark sweep:offline --suite efficient --pairs pairs.json --catalog live --container-url http://localhost:3000 --cli-api-url "$KILO_CLI_API_URL" --concurrency-agentic 1 --max-usd 20 --out sweep.json
pnpm --filter auto-routing-benchmark scoreboard build --label baseline --table live --pricing live --cost-profile p.json --sweep sweep.json --out baseline.json
pnpm --filter auto-routing-benchmark scoreboard build --label candidate --table live --pricing live --cost-profile p.json --sweep sweep.json --rebuild-from-sweep --out candidate.json
pnpm --filter auto-routing-benchmark scoreboard compare baseline.json candidate.json --relative-only
```

Use `--accuracy-noise-band <0..1>` when rebuilding or reranking a scoreboard with a
nondefault ranking band. It applies to both route ranking and learned complexity
variants; omitting it preserves the default `0.05` band.

On the work VM, build and start the existing bench image (from the repository root):

```bash
docker build -t kilo-bench-local services/auto-routing-benchmark/container
docker run --rm -d --name kilo-bench-local -p 127.0.0.1:3000:3000 --add-host=host.docker.internal:host-gateway kilo-bench-local
```

Export `KILO_TOKEN` in the sweep process environment (never pass it as a command-line
argument), plus `KILO_CLI_API_URL` or `--cli-api-url`. The CLI API URL must be a running,
container-reachable Kilo gateway base URL with the CLI's model-discovery and chat
endpoints, and the token must authenticate there and have model access/credit.
For a gateway on the VM host, use `http://host.docker.internal:<gateway-port>` rather
than `localhost`, and bind the gateway to an address reachable from Docker.
The runner posts `/run` with the same model, prompt, variant, token, API URL,
optional `KILO_ORG_ID`, and timeout fields as the benchmark worker.
The container maps that API URL to the CLI's `KILO_API_URL`; it cannot use an
OpenRouter key alone in place of a Kilo gateway/token. No gateway or credentials
are provisioned by the sweep. Keep the container port loopback-only because `/run`
accepts credentials. Stop it after the sweep with `docker stop kilo-bench-local`.
`--concurrency` controls direct requests independently of `--concurrency-agentic`.
The existing container serializes CLI runs for sqlite safety: the default agentic
concurrency is 1; higher values queue requests, not parallel CLI executions.

`--pricing live` hydrates candidates by model id from
`https://app.kilo.ai/api/openrouter/models`. Prompt, completion, and optional
`input_cache_read` prices are USD **per token**, not per million tokens. A pricing
file can be a saved catalog response (`{"data":[{"id":"fixture/model","pricing":
{"prompt":"0.001","completion":"0.002","input_cache_read":"0.0001"}}]}`), or a
model-id map of `CandidatePricing` objects (`promptUsdPerToken`,
`completionUsdPerToken`, nullable `cacheReadUsdPerToken`). These example values are
synthetic. When no pricing flag is supplied, candidate pricing already in the table
is used. Models absent from a supplied catalog have unavailable pricing.

`cost.estimatedRequestUsdWeighted` weights each first pick's benchmark cost plus
uncached input at prompt price and cached input at cache-read price (or prompt
price when cache pricing is absent). It is null if any included first pick lacks
pricing. Lower estimated cost is better in comparisons. Keep the same profile,
route mix, table, and pricing snapshot for base and head; use saved table and pricing
files if the live inputs may change between builds. `benchmarkPerTaskUsdWeighted`
remains the benchmark-only cost and can move differently from this production-input
estimate.

### Prospective full-task experiment protocol (not admitted)

This section states requirements for a future full-task experiment. It does not
describe an admitted runner, a passed gate, or a measured result. No quality or
cost gain is claimed under this protocol.

The scoreboard, sweep, and policy grid above optimize and check single requests.
That request-validation proxy can select a candidate policy. It cannot prove
full-task success, full-task cost, or a routing improvement. Only frozen,
untouched full tasks with complete charges can supply that evidence.

The production worker and sweep keep their own paid-execution ledger. The
bundled `repo-study` driver and `router-*` scripts implement the separate
full-task research protocol below. Historical scripts and evidence remain
audit-only; they cannot authorize new dispatch. Use the bundled runner rather
than introducing another execution framework.

**Frozen design.** Freeze the spec before any paid request, and bind it by hash.

- Tasks: the frozen 18 tuning tasks and 32 final tasks, disjoint and unchanged.
- Every final arm runs every final task with exactly 2 repetitions. A repetition
  is a repeat measurement, not a new independent task. Include any paid tuning
  in the frozen plan and allowance; this protocol does not add a tuning campaign.
- Per-run limits: 60 steps, 1800 s wall time, 180 s per action, 16384 requested
  output tokens, and the approved $60 per-run ceiling. The other pinned
  resource limits stay unchanged. Prove a finite hidden-output ceiling.
- Tune only on tuning tasks. Keep final tasks untouched until final selection.
- Do not add tuning tasks, repetitions, arms, or limits silently. Any change is
  a prospective amendment with a new freeze, quote, and admission decision.

**Objectives.** Judge Efficient and Frontier separately, with the floor, bound,
and interval rule frozen before outcomes exist.

- Efficient: minimize total full-task cost subject to meeting the frozen
  full-task success floor.
- Frontier: maximize verified full-task success subject to the frozen
  total-cost bound.
- A rule that requires both strictly higher success and strictly lower cost for
  both routers is a strict diagnostic only. It replaces neither objective.

**Mandatory comparisons.** The denominator is every arm × task × repetition.

- Arms: one live router arm per mode (`kilo-auto/efficient` or
  `kilo-auto/frontier`), a cost-matched content-blind control, and every
  fixed pool model. Give each fixed model its frozen variant policy.
- The content-blind control selects without task content and matches the
  router cost budget. It separates routing signal from spend alone.
- Share one physical observation between arms only under an immutable,
  hash-bound identical-intervention mapping. The mapping must prove the same
  executable, task revision, model, variant, payload, limits, and grader.
  Any other observation is a separate run.
- Do not shrink the denominator after dispatch. Missing, failed, and invalid
  rows stay visible with their reason and charges.

**Financial admission gates.** Version 6 is capped exploration. It has no
full-plan funding guarantee. A budget stop leaves the plan inconclusive.
Version 6 dispatches every solver request through the Kilo AI gateway.
Old version 5 manifests are audit-only.

1. **Continuity.** Retain all historical settled charges and unknown holds at
   their full bound. Do not reset the ledger, attempt history, or candidate
   history. Cumulative new allowance across all amendments stays at or below
   the authorized $100. An amendment never rebases the allowance, and a
   tranche inside it is not new allowance. A larger legacy ledger cap is not
   spending permission.
2. **Whole-plan cost forecast.** Register one hash-bound forecast for the whole
   plan: every arm, task, and repetition. Price every `(model, variant)` pair
   reachable from the baseline and candidate tables, not only first picks. A
   missing or unpriced mandatory pair blocks registration. The forecast total
   can exceed $100. The forecast is evidence, not funding.
3. **Nested caps at dispatch.** Reserve each request in full before dispatch.
   Settled plus held plus the next bound must fit three nested caps: the $100
   cumulative new allowance, the $60 pilot ceiling for pilot work, and the $60
   per-run ceiling. The frozen per-run resource limit can bind first. Count
   incurred commitments only. Do not count unattempted rows. Do not count the
   unused part of an active run cap. A claim records its per-run cap. The claim
   reserves no money. Known settlement replaces a hold with the actual charge.
   The unused part then stops counting. An unknown or breached charge stays at
   its full bound and stops dispatch.
4. **Pilot ceiling.** A router-arm protocol pilot has an independent $60
   ceiling inside the same cumulative allowance. A frozen pilot cap can be
   lower. The pilot checks execution, grading, and receipts only. It cannot
   certify either objective. No final request may run before exact successful
   pilot evidence exists. The live worker picks its classifier from live
   config. The code does not check the billed classifier. Before approving
   final dispatch, the operator must confirm the billed classifier model and
   cost from the organization's recorded usage on the read replica.
5. **Component tariffs.** Reserve at the dearest public provider price.
   Take per-component maxima over the Kilo catalog pricing and every public
   OpenRouter endpoint price for the model, including every override tier,
   with positive discounts undone. Keep the raw catalog entry and the frozen
   endpoint snapshots with their hashes as evidence. Sum the component
   maxima for input, cached read, cache write, output, and hidden reasoning.
   Add the per-request fee. Never assume a component is free. Missing or
   unparseable endpoint evidence fails the quote. Hidden reasoning is
   assumed bounded by `max_tokens`; this is unproven, and a charge above
   the reservation stops dispatch.
6. **Gateway worst case.** The gateway selects the provider. The request
   carries no provider controls. Price a router arm from the maximum over
   every pool model of its mode. Add the frozen classifier allowance to each
   router-arm reservation and settlement: the gateway bills the classifier
   as a separate organization usage row outside `usage.cost`. The Kilo
   catalog does not list the classifier model, so its price comes from its
   public endpoints only. The bound is the dearest public input rate times
   32,768 input tokens, times six questions, times two attempts, plus the
   request fee per attempt-question: one billed classification runs per
   gateway request, billing may be per question, and each classification
   gets at most two HTTP attempts. The classifier request sends no
   `max_tokens`, so every endpoint output price must be exactly zero or the
   quote fails. The allowance must be positive and at least this bound; a
   lower allowance is rejected at quote time. Settlement records the full
   allowance, so a router arm's settled cost is an upper bound. A router
   cost claim needs the organization's recorded classifier charges for the
   run from the read replica.
7. **Payload guard.** After all variant mutation, validate the final serialized
   payload. Admit string text only. Reject media, files, native tools, search
   plugins, cache controls, automatic continuation, budget escalation, and any
   passthrough field that can add billable work. Reject; do not silently strip.
   The payload has no `usage`, `provider`, `plugins`, or `tools` field.
   Bind the guard, its hash, and negative proofs to the executable identity.
8. **Identity.** Bind the complete executable and input identity before
   dispatch: source and bundle hashes, parser and grader revisions, task
   split, pool snapshots, variant catalog, run order seed, resource limits,
   the frozen Kilo organization ID, the gateway model per mode, the recorded
   gateway routing table version, and quote evidence. Dispatch only inside
   the quote validity window; an expired quote needs a fresh quote.
   Any identity mismatch blocks dispatch.

**Tariff incompatibility is a no-go, not an outage.** If a tariff cannot be
bounded under this contract, record an accounting failure. Do not mark the
model unavailable, invent an outage, strip tariff fields, drop a pair, or
reduce the denominator to escape it.

**Outcome interpretation.** Never retry an attempt that may have been paid.

- Happy path: the run completes, the deterministic grade is valid, and every
  charge settles. Record resolved or not, with settled total cost.
- Empty: a dispatched attempt returns no answer or no submission, with settled
  charges. Score it as a failure, retain its charges, and do not retry it.
- Retryable: only an attempt proven not dispatched, with no paid call started.
  It stays undispatched and missing, never a failure, and may run later under
  the same frozen identity.
- Nonretryable: any attempt that may have reached a provider. Never dispatch it
  again. Hold an unknown charge at its full bound, stop further dispatch until
  the stop is cleared under the frozen policy, and give ambiguous quality the
  full interval instead of an invented score.
- A provider outage with a valid outage record is an arm failure.
  Infrastructure and grader failures block completeness instead. They are not
  model-quality failures.
- Budget stop: a cap stops a later request. The plan is partial and
  inconclusive. A favorable prefix cannot establish a pass, superiority over a
  fixed model, or control cost matching.

**No-go states.** Paid dispatch stays blocked while an applicable gate fails:
unaccounted unknown charges; unresolved historical candidate uncertainty;
incomplete or expired tariff coverage; an unbounded tariff component; a
missing or malformed gateway token or organization ID; a missing payload
guard; an executable identity mismatch; or a changed denominator. A forecast
above the caps is not a no-go. The next unaffordable request is the stop.
Final dispatch also requires exact successful pilot evidence. The pilot cannot
prove its own admission retroactively. Report blocked while any applicable gate fails.

The version 6 prospective protocol is implemented by the bundled `repo-study`
driver and the `router-*` coordinator scripts. Old manifests and old financing
manifests are audit-only. Paid execution requires, in order:

1. A capped-exploration authorization whose cumulative new allowance is within
   the $100 programme ceiling and whose origin snapshot is immutable.
2. A frozen version 6 spec with the complete router, content-blind control and
   fixed-model arms for each mode, the unchanged task split and resources, the
   frozen `kilo_organization_id`, the frozen `classifier_allowance_usd`, and
   `gateway_routing_table_version` (null when no version is published).
3. A fresh complete tariff quote for every mandatory pair. An unsupported tariff
   is an accounting failure, not a model outage.
4. A registered whole-plan cost forecast covering every mandatory row.
   The `finance` command registers that forecast. It does not fund the plan.
   Audit executability requires current authorization and frozen plan
   validation. Each forecast keeps its own total.

The coordinator validates the final text-only payload after variant resolution,
posts exactly the approved bytes, and consumes each reservation once. It reports
no pass or savings claim unless every arm has settled charges, determinate grades
and the frozen coverage. An incomplete analysis is `inconclusive`.

Variant validation accepts the shared gateway catalog's complete verbosity
vocabulary, including `xhigh`, without dropping its frozen reasoning controls.

These are pre-dispatch reservation checks, not a guaranteed ceiling on final
provider charges. An over-bound charge is detected after billing and stops
further dispatch. A provider dashboard budget is not a hard cap either:
already-dispatched requests can finish after that budget is reached. Real
dispatch requires independent evidence that all billed exposure stays inside
the authorization; a quote or dashboard limit alone does not prove that.

Recovery releases a coordinator reservation at zero cost only when neither its
dispatch admission nor its receipt indicates dispatch. Historical and admitted
requests retain their full holds. Receipt or observer failures cannot overwrite
a settled charge. Admission denials finalize their receipt and budget-limit
evidence even when admission already settled the unused reservation.

Gateway settlement uses one rule for every arm. A charge settles only when
`usage.cost` is a finite nonnegative number and `usage.is_byok` is exactly
false. Router-arm settlement records `usage.cost` plus the frozen classifier
allowance, because the classifier is billed separately. BYOK, a missing
flag, or a missing cost is an unknown charge: the full hold stays and all
further dispatch stops.

**Gateway transport.** Every solver request goes to
`POST https://ai-gateway.kilo.ai/api/v1/chat/completions`. The host-only
`KILO_API_TOKEN` environment variable authenticates the request as the Kilo
account. The frozen `kilo_organization_id` is sent as
`X-KiloCode-OrganizationId`, so the Kilo organization is billed. The
organization ID is stored in the spec and receipts; it is not secret. The
token is never stored. The router arm requests `kilo-auto/efficient` or
`kilo-auto/frontier`; the receipt records the concrete routed model from
the response `model`. A routed model outside the frozen pool keeps the full
hold and stops dispatch. Fixed and control arms request their frozen
concrete model through the same transport. A router arm needs a valid quote
for every pool pair of its mode, or it blocks admission. The gateway's
optional `x-kilo-max-cost-microdollars` bound accepts only system and user
messages, so multi-turn agent requests do not send it. The local serialized
ledger is the spending control: it reserves each request's quoted worst case
before dispatch and enforces the cumulative $100 allowance and the $60 pilot
and $60 per-run ceilings. A charge above its reservation stops all further
dispatch. A rejected response after dispatch keeps its full hold. This is not
a provider-invoice hard cap: the gateway balance is a snapshot and in-flight
requests can finish after a cap is reached. A daily member limit on the
organization account is a recommended backstop, not a ceiling. Live routing tables
can change during a run. The spec records the published table version in
`gateway_routing_table_version`, or null when none is published; a null
value is a stated limitation, not a frozen table. There is one live router
arm per mode; objectives compare it against every fixed pool model and the
content-blind control.

Run the offline checks with:

```sh
python3 -m pip install -r repo-study/requirements.txt
(cd repo-study && python3 -m unittest test_text_tariffs)
(cd scripts && python3 -m unittest test_router_ledger test_router_study test_router_proof test_router_replay.ReplayInvariants)
```

Do not authorize paid work without a host-only gateway token, a verified
organization ID, a finite quote for every mandatory pair, and independent
evidence of total billed exposure.
A forecast above the remaining authorization can register for offline checks.
The code checks quoted reservations; it does not certify a provider-invoice
ceiling. Local admission stops before an unaffordable reservation. This protocol
does not authorize a live run by itself. Do not shrink the plan or raise a cap
implicitly.

### Shadow routing policy

To evaluate an efficient-router candidate without routing traffic to it, put its JSON
table in the shared `AUTO_ROUTING_CONFIG` namespace under `shadow_routing_table_v1`.
It must validate against the same `RoutingTableSchema` as `routing_table_v1`.
Delete the shadow key to disable evaluation; the live routing table is never changed.
The shadow reader caches both present and absent values in the isolate for 60 seconds,
in addition to KV's propagation delay. Invalid tables and read/computation failures
are ignored.

Classified efficient `/decide` requests evaluate the candidate with the same classifier
result, incumbent, denied models, routing mode, constraints, and capability map as the
live decision. Only the live decision is returned, stored, or billed. There are no extra
classifier, capability, or benchmark calls and no shadow cache writes.
Classifier failures have no classification to shadow-evaluate. Frontier requests do
not evaluate the efficient shadow table.
Existing sampled `auto_routing_decision` logs include `shadowModel`, `shadowVariant`,
and `shadowDiffers`; a valid table with no eligible route records a null shadow model.

Collect with `pnpm --filter auto-routing-benchmark scoreboard:prod --since 24 --out prod.json`,
then pass that snapshot to `scoreboard build`. Both JSON reports include a `shadow`
section with observed evaluation count, sampling-weighted divergence, and
`outcomesByDecidedModel`: actual production request counts, error and abort rates,
mean input/output/cache-read tokens, and mean cost in USD per request.
The read-only Postgres join matches distinct observed session/model pairs to
`microdollar_usage_metadata.session_id` and the actual `microdollar_usage.model`,
within the collection window, for efficient and balanced auto requests.
Repeated decision logs do not multiply usage rows. Raw session ids are used only
in memory for the join and are never written to the reports.

Outcome proxies describe the observed live-model session cohort, not the unserved
shadow model's counterfactual quality or an exact per-decision request attribution.
Missing status codes and cancellation flags are excluded from their respective rate
denominators. Missing sources yield null metrics; no observed/joinable sessions yield
an empty outcome map. Divergence weighting assumes the supplied/current
`decision_log_sample_rate` stayed constant over the window; use `--sample-rate` when
collecting a window with a known rate. This is observation only, not production A/B
allocation; production ids are not silently bucketed.
Divergence is unavailable when success sampling is disabled because always-logged
switches alone cannot estimate population divergence.
## Candidate screening

Screen inexpensive catalog models before an admin adds them to the platform pool:

```bash
pnpm --filter auto-routing-benchmark screen:candidates --catalog live --pairs current-pairs.json --suite efficient --max-prompt-usd-per-mtok 3 --cases-per-route 4 --max-usd 5 --table table.json --cost-profile profile.json --out screen.json
pnpm --filter auto-routing-benchmark screen:candidates --catalog file --catalog-file catalog.json --pairs current-pairs.json --suite frontier --max-prompt-usd-per-mtok 3 --cases-per-route 4 --max-usd 5 --table frontier-table.json --out screen.json
```

These caps are example screening settings, not production measurements.
`--catalog` also accepts a saved catalog path directly. `--pairs` is an array
of `{model, variant}` entries; every model already represented in it is excluded,
regardless of effort. Eligible models must support text output and tools, have
fixed nonnegative prompt and completion prices, and have a prompt price strictly
below the USD-per-million-token cap. Virtual auto-routing entries are excluded.
`--max-models <n>` optionally keeps only the n cheapest eligible models by prompt
price, breaking equal-price ties by model ID. Without it, all eligible models run.
Each model runs once without variant overrides (the provider default), and once
with its highest catalog-supported reasoning effort, when available. Full catalog
variant fragments are retained, including controls beyond reasoning.

The screen hashes case IDs with SHA-256 and takes the first N hashes per direct
route from the selected suite. Every candidate sees the same cases; selection is
stable when dataset order changes. Agentic routes require CLI execution and are
explicitly listed in `excludedRoutes`, never simulated by direct completions.
A shared worker pool pulls requests in round-robin order, alternating each model's
variants within its case sequence. `--concurrency <n>` defaults to 24. Dispatch
order spreads partial-run coverage across models; completions may arrive out of order.
Direct requests, streaming TTFT, long-context materialization, and grading reuse
the offline sweep path. Direct model requests are not automatically retried.
Set `OPENROUTER_API_KEY`; no container is required.

The report contains model-wide and per-variant accuracy, Wilson lower bounds,
benchmark and estimated production request cost, p50 TTFT and total latency, raw
results, and route comparisons against the supplied table's current first pick.
`--cost-profile` takes the same token-profile JSON as the scoreboard, or defaults
to the table's profile. Candidate and incumbent prices use the catalog snapshot;
an incumbent absent from it can use its saved table pricing. A route beats its
current pick only with complete graded, priced samples and a strictly better
finite value under the shared ranking policy and accuracy eligibility rule.
Missing incumbent latency or required pricing prevents a recommendation.
`recommend` is true when either screened variant beats the current pick on at
least two distinct routes. It is an admin-review suggestion, not a pool change.
The command never writes configuration, registry rows, or routing tables.

`--max-usd` includes model and grader spend. Every HTTP attempt reserves its
estimated prompt-plus-maximum-output cost before sending, then settles that
reservation against observed or estimated cost. Reservations are shared atomically
across workers; a worker waits for in-flight settlement when funds are reserved.
Requests explicitly send the variant's `max_tokens`, defaulting to 8192.
Input-token estimates are approximate, so unexpectedly higher actual costs can still
exceed a reservation; no new requests start after the settled budget is exhausted.
Grading also reserves before sending and settles to the actual reported `usage.cost`.
When the System One grader is absent from the Kilo catalog, each call reserves
`GRADER_RESERVE_USD` ($0.002); catalog-priced graders retain token-based reservations.
Missing model cost marks only that model `costUnknown: true`, excludes it from
recommendations, and stops sampling all its variants; other models continue.
Its reported prompt and completion token counts are charged at catalog prices
without cache discounts. `costUsd` includes these conservative estimates;
`estimatedCostUsd` identifies their contribution globally and per model.
If token counts are unavailable, input tokens are estimated as the combined
system/user prompt characters divided by four, rounded up; output is bounded by
the request variant's `max_tokens`, or 8192 when unset. Only that request's
catalog-priced estimate is charged, never the entire remaining budget.
A failed judge call still stops further spending and sets `spendIncomplete`.
Atomic checkpoints serialize concurrent writes before replacing the report.
Reservations are checkpointed before requests leave; completed case results are
checkpointed after grading.

Resume an interrupted screen with the original inputs and `--resume screen.json`
(which may also be the `--out` path). Completed exact model/variant/case requests
are skipped, accumulated spend and `costUnknown` exclusions are retained, and
concurrency or the total `--max-usd` cap can change. Suite, sample size, sampled
cases, candidate pairs, table version, and production cost profile must match.
Reports from the earlier sequential runner remain readable.
Persisted in-flight reservations become conservative `unsettledCostUsd` charges
on resume because their actual spend may be unknown; they are not discarded.
A report with indeterminate grader spend cannot resume safely.
## Admin endpoints

All under `/admin`, gated by `Authorization: Bearer <INTERNAL_API_SECRET_PROD>`
(the gateway's admin panel proxies these with the internal secret):

GET endpoints accept `?router=efficient|frontier`; mutations accept `router` in their body
or query. Omission selects efficient. Owner profile and custom router endpoints accept both
routers. The classifier-winner endpoint returns the shared winner.
The client eval routes (`/v1/eval/*`, below) use the same bearer secret.


| Endpoint | Purpose |
|---|---|
| `GET/PUT /admin/config` | Read / save benchmark config (model lists, thresholds, `benchmarkUserId`, optional `benchmarkOrgId`). The response also carries the seven fixed policy settings, projected from the resolved policy, because the web release promoted after a worker deploy parses them (ADR 0003, invariant 7); the saved config and the accepted request body do not carry them. `PUT` saves, then syncs the platform registry and republishes the routing table before responding. A failed step does not undo the save: the response is 200 with `warnings` (`registry_sync_failed`, which skips the publish, or `routing_table_publish_failed`), each naming the retry (the daily `0 5 * * *` platform sync, or saving again) |
| `GET/PUT /admin/scheduler-config` | Read effective scheduler limits with their source / replace admin overrides of `slots` and `modelConcurrency` (the retired provider limits are accepted and ignored for one web release) |
| `GET /admin/runs` | List runs without their summaries. Read-only; the per-minute cron sweeps stale `running` runs. `runningRunIds` lists every running run of the router, whatever the `kind`/`purpose` filter; the admin panel polls while it is non-empty and refreshes the routing table, config and registry whenever a run leaves it. Each run carries an empty `summaries` array because the web release promoted after a worker deploy still requires it (ADR 0003, invariant 7) |
| `GET /admin/runs/:runId/summaries` | One run's model summaries; 404 when the run does not exist or belongs to another router (classifier runs are shared) |
| `POST /admin/runs` | Classifier: start a run (`{kind: 'classifier', force}`). Decider: reconcile + drain the registry queues (`{kind: 'decider', queue: 'platform' \| 'user' \| 'both'}`); `202` once a run row exists, with initialization left to the dispatcher |
| `GET /admin/registry` | Queue counts, exact platform entry statuses and the failed entries of both queues (retryable and permanent, with class, attempts and retry window) under the current engine identity and repetitions |
| `POST /admin/registry/requeue` | Put retryable failed registry rows whose retry window has passed back to `pending` (`{scope}`); permanent rows are skipped; charges no owner quota |
| `POST /admin/registry/refresh` | Re-admit exact pairs (`{router, mode, entries}`), clearing their failure history; the console's per-row Re-admit uses `mode: 'refresh'` |
| `POST /admin/registry/remeasure-prompt-transport` | Dry-run, queue or cancel re-measures of prompt-transport-affected cases (`{router?, action, pairs?}`; `pairs` limits the plan to an explicit `[{model, variant}]` list) |
| `GET /admin/routing-table` | Latest published **platform** routing table. Served from `AUTO_ROUTING_CONFIG` key `benchmark_routing_table_response_v1:<router>` only while its version matches the pointer `benchmark_routing_table_version_v1:<router>`. Every publish writes the pointer after its D1 write; a read that finds the pointer missing or different from D1 rewrites it. Every pointer writer re-reads D1 after its write and corrects it, and a body is cached only at the confirmed version. A publish that cannot write the pointer logs it, deletes the cached body and still flushes the gateway key, so the next read goes to D1 and repairs the pointer. The cached body expires after 10 minutes, so even a failed pointer write plus a failed body delete serves the previous table for at most that long. A location's KV edge cache can keep serving the previous pointer for up to about 60 seconds after a publish |
| `GET /admin/classifier-winner` | Current classifier winner |
| `POST /admin/debug-cli` | Run one ad-hoc prompt through the kilo CLI container (diagnostic) |
| `POST /admin/profiles/register` | Admit missing/stale/retried profiles for every current catalog effort of a custom router's gateway models (quota 20 models per base router per 24h) |
| `POST /admin/custom-router-table` | Custom router table from platform and owner client measurements (`CustomRouterBenchmarkContextSchema`) |
| `POST /admin/custom-router-status` | Per-variant status of every custom router entry (`CustomRouterStatusResponseSchema`) |

## Owner Benchmark profiles

Custom routers (ADR 0005) name gateway models of either base router. When an owner saves a
router whose entries or base router changed, the web app registers the gateway entries the
platform key can serve with `POST /admin/profiles/register`. Each selected model
expands through the live catalog into every supported reasoning effort, or one
default pair when there are no reasoning controls. This worker measures exact
model-effort pairs globally under the current engine identity and repetitions.
Custom router tables rank every measured pair; the router, not the owner, chooses effort.
ADR 0003 owner pools, which constrained efficient itself, were converted to custom routers
with slug `efficient` at the ADR 0005 cutover.

### The two registry queues

A registry row records who wants the measurement: `platform_requested` (the
saved decider list) and `user_requested` (custom router gateway entries). Both can be set — the
row is global, so the pair is benchmarked once and serves both.

| | Platform queue | User queue |
|---|---|---|
| Filled by | `syncPlatformRegistry` expands the saved models from the current catalog on config save, daily sync, and platform drain | `POST /admin/profiles/register` from the web custom routers API (quota-charged) |
| Trigger | Admin `POST /admin/runs`, daily cron, any decider terminal state | Admin `POST /admin/runs`, one-minute cron, any decider terminal state |
| `benchmark_runs.purpose` | `platform` | `user` |
| Execution share | Efficient and frontier each have default weight 2 | Efficient and frontier each have default weight 1 |
| Run lifecycle | Up to 4 active runs per router/queue, one of them starting | Up to 4 active owner runs per router, one of them starting |

All four shares use the same bounded chunk scheduler and borrow unused capacity.
`benchmark_runs.max_concurrency` is retained for storage compatibility but new decider
runs write zero: it is not an execution reservation. Registry admission is still atomic
per exact pair, and the per-router/queue run lifecycle gate remains independent of slots.

A drain of one router/queue starts a new run for the oldest pending entries while earlier
runs of that queue are still measuring, so a newly added model does not wait for the
active run to finish. The drain skips the queue while one of its runs is still starting
(it has no `scheduler_runs` marker yet: reuse copies and chunk creation are still in
progress), logging `benchmark_queue_drain_skipped_run_starting`, and while
`MAX_RUNNING_RUNS_PER_QUEUE` (4) runs are active, logging
`benchmark_queue_drain_skipped_queue_full`. The run row is inserted by one conditional
statement that repeats both checks, so overlapping drains (the timer, a finishing run, an
admin request) cannot start two runs that are both starting or a fifth active run: the
refused drain hands its claimed pairs back to `pending` and logs the same skip event.
Concurrent drains claim disjoint pairs; a drain that finds every pair claimed logs
`benchmark_queue_drain_batch_already_claimed`.
Runs of one router/queue share its execution share. Within the share the scheduler
prefers the model with the fewest live chunks, then the older run, so a small new run
gets its first chunks as soon as its models hold fewer slots than the earlier run's
models. Each dispatch pass finalizes every settled run, up to the 16 that the four queues
can hold. Classifier runs stay one at a time: `POST /admin/runs` answers 409 while one
is active.

After any decider run completes, the worker assembles the platform table from ready, current registry entries for the current catalog pairs.
If a desired pair remains pending or running, the previous table stays live.
Failed pairs do not contribute scores.
If any taxonomy route has no measured candidate, the worker skips publication and keeps the previous table.

Rollback: removing a model from a custom router (or deleting the router) leaves the platform
table untouched — it only ever draws on rows the platform list asks for.

### Request ledger and admission

The platform pays for every owner-requested measurement. Owners are never charged.
Already ready/current or pending/running pairs are reused by every owner.

`POST /admin/profiles/register` admits missing, stale, or retried pairs and records
one quota request event per newly requested model in the same D1 batch. The rolling
quota allows 20 new models per base router per owner in 24 hours; it counts models,
not efforts, and ready or pending models are reused without a charge. Engine-stale
remeasurement is quota-free.
Concurrent requests share one global pair; the first admission wins and the
others report its status.

Admission returns before the web app's router write. If that write fails, the previous
router remains, but admitted measurements still run. Retrying reuses the same global
profiles without charging quota twice.

### Status transitions and drain

```
pending → running → ready
                 ↘ failed (retryable) → pending only by an admin action or the owner's Retry
                 ↘ unavailable (permanent; wire status `failed`) → pending only by a per-row re-admit or the owner's Retry
```

- **running**: set when a decider run of either queue claims the entries at `startRun`.
- **ready**: set when that run completes successfully (`run_id` provenance
  points at the measuring run). Clears the failure history.
- **failed / unavailable**: set when the run fails (enqueue, timeout sweep, etc.), per
  entry whose lane died, or per entry whose cases nearly all failed with one provider
  rejection. Only rows still pointing at that `run_id` transition — a newer pending/ready
  row is never clobbered.

`src/profile-failure.ts` owns the failure state: `parseProfileState` is the one reader of
the row, and `profileFailureAssignments` is the one failed transition. Each failure has a
class; the class decides whether the failure is permanent:

| Tier | Classes | Rule |
|---|---|---|
| Terminal | `catalog_absent`, `context_too_small`, `model_not_found`, `unsupported` | Permanent at once |
| Model | `provider_unavailable`, `model_resolution` | Permanent after 3 failed runs since the last ready measurement |
| Infrastructure | `ambiguous_execution`, `container_capacity`, `catalog_load`, `grader`, `run_timed_out`, `orphaned_claim`, `run_init_failed`, `unknown` | Never counted against the model; any 5 consecutive failed runs are permanent |

`unsupported`: at least 95% of an entry's measured cases failed with the same provider
rejection (numbers ignored). Timeouts, content filters, throttles, empty output and wrong
answers stay measurements.

A retryable failure waits `2^(attempts-1)` hours, capped at a day, before
`POST /admin/registry/requeue` takes it. Nothing re-admits a failed row automatically.

Currency: a profile is current only when `engine_identity`, `repetitions`, and
exact variant match the live decider engine. The platform table never uses a stale row.
Custom router tables serve a stale row, flagged `stale`, until the current one is ready (see
below).

**Per-queue drain** (after any decider terminal state, on the admin's manual
trigger, and on the one-minute cron):

1. Skip the queue when one of its runs is still starting (it has no `scheduler_runs`
   marker yet) or when it already holds `MAX_RUNNING_RUNS_PER_QUEUE` active runs; either
   way its pending registry rows are left alone.
2. Otherwise take up to 100 current-engine entries oldest-`requested_at`-first.
3. `startRun(purpose: queue, entries: snapshot)` writes the run row and wakes the
   dispatcher, which materializes the chunks; the global scheduler then claims only the
   chunks that fit its current caps.

A row wanted by both queues appears in both listings; whichever run claims it
first flips it to `running`, so it is still measured exactly once.

**Scheduled handlers:**

- `* * * * *` — recover expired chunk claims, sweep stale runs, and drain both queues.
- `0 5 * * *` — sweep, reconcile the platform queue with each router's
  admin-configured decider list, drain both queues, republish the
  platform table (so a *removed* model leaves the live table even when nothing
  new needed measuring).

Long waits stay `Benchmarking` in the UI; there is no second timeout state in v1.

### Prompt transport re-measure

Every result row carries `prompt_revision` (`PROMPT_TRANSPORT_REVISION` in
`src/prompt-transport.ts`). Revision 1 passed the prompt as a `kilo run` argument, which
quoted prompts containing a space and escaped their inner `"`, and omitted long-context
snapshots. Revision 2 materializes the snapshot and writes the prompt verbatim to stdin.
`argvAffectedCases(router)` lists the cases revision 1 measured unreliably: every
long-context case, and efficient cases whose prompt has an inner `"` and whose check is
`exact`, `contains_all` or `regex` (frontier inner-quote cases join when
`REMEASURE_FRONTIER_INNER_QUOTE_CASES` is set). The engine identity does not change.

A re-measure claims the pair in `profile_remeasures`, not on the profile: the profile stays
`ready` on its previous run, so the platform table, owner tables and status keep serving.
The re-measure run copies the previous run's results except the affected revision-1 rows,
so only those cases are scheduled, under the normal scheduler caps. When the run completes,
the profile's `run_id` moves to it, the claim is removed, and the platform table republishes
as after any decider run. A failed run, a dead lane or an orphaned claim drops the claim and
keeps the previous measurement; an unwritten run returns the claim to the queue. Prior-case
reuse never copies an affected revision-1 row into a new run. A container result recovered
after its caller died is stamped with the revision the paid call was opened under
(`scheduler_executions.prompt_revision`, defaulting to 1 for calls opened before this
change), so output a previous deploy produced stays re-measurable instead of being trusted.

Runbook, after the whole stack is merged and deployed (the migration applies on deploy):

1. Dry run (writes nothing): `POST /admin/registry/remeasure-prompt-transport` with
   `{"action":"dry-run"}`, or `{"router":"efficient","action":"dry-run"}` for one router.
   Each router reports its affected pairs, affected results, and projected spend: the
   measured cost of each affected result plus, for long-context cases, the snapshot's
   prompt tokens at the catalog prompt price. `unknownCostResults` counts results this
   estimate cannot price.
2. Queue: the same call with `"action":"request"`. The next drain (at most one minute)
   starts the runs.
3. Verify: the dry run reports `pairs: 0` per router, `profile_remeasures` is empty, and
   `GET /admin/routing-table` shows a new version.
4. Stop: `"action":"cancel"` deletes queued claims. A claimed pair finishes or drops with
   its run.

## Adding a model: the flow

Three entry paths put a model into the benchmark, and all three converge on one registry row
per exact `(model, variant)` pair under the live engine identity and repetitions.

| Entry path | Who starts it | Code |
|---|---|---|
| Admin Policy tab → **Save config** | an admin, in the console | `apps/web/src/app/admin/api/auto-routing/benchmark-config/route.ts` → `PUT /admin/config` (`registerAdminRoutes`, `src/admin.ts`), then `syncRegistryAfterConfigSave` → `syncPlatformRegistry` (`src/run.ts`) |
| Owner custom router save (gateway entries) | the router's owner, in their own console | `apps/web/src/lib/auto-routing-custom-routers.ts` → `POST /admin/profiles/register` (`registerAdminRoutes`, `src/admin.ts`) → `registerProfiles` (`src/profiles.ts`) |
| Alias target moves (e.g. `~openai/gpt-sol-latest` → a new concrete id) | nobody — the daily cron | `dailyReconcileSubscriptions` (`src/subscriptions.ts`) at `0 5 * * *`, resumed on the next ticks by `continueDailyReconcile` (`src/index.ts`) |

### Steps, with what is manual and what is a wait

Each step names the code that performs it. **Manual** means a human click or API call;
everything else is automatic. **Wait** is the delay the flow itself imposes.

| # | Step | Manual / automatic | Wait | Code |
|---|---|---|---|---|
| 1 | Pick the model and save the router config | **manual** (console Policy tab → Save config) | none; the save returns the saved config, its `warnings`, and the `drain` outcome | `registerAdminRoutes` (PUT /admin/config), `syncRegistryAfterConfigSave` (`src/admin.ts`) |
| 2 | Registry sync: expand the model through the live catalog into every supported effort, insert `pending` rows | automatic, inside the save request | none — runs before the response | `syncPlatformRegistry` (`src/run.ts`), `syncPlatformRegistryRows` (`src/db.ts`) |
| 3 | Routing table republish (the save also flushes an unchanged table) | automatic, inside the save request | none | `syncRegistryAfterConfigSave` → `publishPlatformRoutingTable` (`src/run.ts`) |
| 4 | Queue drain: claim the pending rows into a run | automatic. The save drains the **platform** queue itself right after the publish; the per-minute cron still drains both queues for owner registrations, and a decider run reaching a terminal state drains immediately | **none for the platform queue** on a save (bounded at 5 s, then deferred to the cron). Owner registrations still wait **up to 60 s**; the queue must be able to start a run, i.e. none of its runs is still starting and it holds fewer than `MAX_RUNNING_RUNS_PER_QUEUE` active runs (see "The two registry queues") | `drainPlatformAfterConfigSave` (`src/admin.ts`); the scheduled handler (`src/index.ts`) → `sweepStaleRunsAndDrain` → `drainQueues` (`src/run.ts`) |
| 5 | Run start: claim registry rows, insert the run row, copy reusable prior results | automatic, same drain pass | none | `startRun` (`src/run.ts`), `markProfilesRunningForRun` (`src/db.ts`), `reuseDeciderCaseResults` (`src/db.ts`, in the dispatcher's initialization) |
| 6 | Initialization: materialize one scheduler chunk per case per lane | automatic, on the next dispatch pass | **bounded 20 s per pass**; a large run needs several passes (one pass writes 50 chunks per batch) | `scheduleRunChunks` (`src/scheduler.ts`), `initializeScheduledRun` (`src/run.ts`) |
| 7 | Dispatch: claim chunks that fit the scheduler caps and enqueue them | automatic | none once initialized | `claimScheduledChunks` (`src/scheduler.ts`), `dispatchScheduler` (`src/run.ts`) |
| 8 | Cases execute in the runner container; each result posts to `/container/case-result` | automatic | **the measurement itself** — this dominates: minutes to hours depending on the entry count and model latency | `beginPaidCase` (`src/scheduler.ts`), `acceptContainerCaseResult` (`src/run.ts`) |
| 9 | Finalization: aggregate summaries, flip entries ready/failed, mark the run completed | automatic, on the dispatch pass that sees the run settled | none | `finalizeRunIfComplete` (`src/run.ts`) |
| 10 | Profile ready: the registry row carries `run_id` provenance | automatic, same pass | none | `markProfilesReadyForRun` (`src/db.ts`), `src/profile-failure.ts` |
| 11 | Routing table publish with the new pair | automatic, same pass (and any save) | refuses while a serving pair's measurement is in flight (or it has no current-engine registry row yet); a settled failure leaves the table and is named in the publish log | `publishPlatformRoutingTable`, `finalizeRunIfComplete` (`src/run.ts`) |
| 12 | Console: runs list, per-model cost table and routing table show the result | automatic on page load / refetch | none | `apps/web/src/app/admin/auto-routing/BenchmarksSection.tsx` |

### Expected time per step

Measured on the local stack with synthetic case results standing in for inference
(`/tmp/ar-bench/flow/`, 1440 px captures) and on production since the 2026-11-20 fixes.

| Step | Local stack | Production |
|---|---|---|
| 1–3 save (console click → 200 with `warnings: []`) | 0.4–1.1 s | same code path |
| 1–3 save when the catalog mint fails | 0.3–0.4 s, `warnings: ["registry_sync_failed"]`, config still saved | — |
| 4 drain | in the save response (0.6 s) for the platform queue; an owner registration still waits for the cron | 3–62 s measured, and no click |
| 5 run row written | within the drain response | same |
| 6 initialization | 22 s for 294 chunks / one lane; a 4426-chunk run took about 4 min of passes | 30–40 s before the first case on small platform runs; minutes on a 100-entry batch |
| 7 → 8 first case started | 3 s after the run row | 13–40 s |
| 8 first case result | 1–12 s (seeded) | 13–37 s |
| 8 whole run | seeded instantly; not representative | p50 ≈ 38 min for 10 frontier pairs × 294 cases; ≈ 94 min for one efficient model × 576 cases × 3 reps |
| 9–11 ready + published | 0.1 s (seeded → one dispatch tick) | 0.2–5 s after the run completes |

End to end for one model through the admin path with a real measurement: allow **15 min to
2 h** for an efficient model (576 cases × 3 reps at the current caps) and **10–50 min** for a
frontier model, plus at most a minute of drain and a minute of initialization. Production
before the 2026-11-20 fixes took hours longer: p50 admit→ready was 2.9 h (platform) and
5.8 h (owner), and admit→published 46 h; after them the same measurements are 38 min
(platform) and 56–94 min (owner), and publish lands within seconds of run completion.

### What the console shows at each step

- **Policy tab, right after the save**: the model row is in the decider list, and its effort
  coverage line reads `N of M measured · <effort>: pending` for the sync's new rows. A save
  that could not sync shows a destructive banner naming why (`registry_sync_failed`,
  `routing_table_publish_failed`) plus "save again to retry now". A save whose platform drain
  did not start a run is not an error: its `drain.skipped` says `active_run` (one of the
  queue's runs is still starting, or it already holds `MAX_RUNNING_RUNS_PER_QUEUE` active
  runs), `nothing_pending` (every pair is already measured or in flight), `timeout`
  or `failed`, and the Benchmarks tab shows the new `Platform queue` run as soon as the cron
  picks it up (within a minute).
- **Benchmarks tab, Decider Registry**: pending / running / ready / failed counts per queue,
  and the per-entry status list under the current engine identity.
- **Benchmarks tab, runs list**: a `Platform queue` or `User queue` run row with its status
  (`running` with a progress bar, then `completed` or `failed`), its total cost, cases and
  errored count. Expand a run for a per-model table of **Accuracy, Cost / case, Total cost,
  Cases, Errors**, and the model-id filter above it.
- **Benchmarks tab, Failed models**: every failed pair with a `Permanent` / `Retryable` badge,
  its class, reason, first/last failure and attempts, the next retry time, and a per-row
  **Re-admit**.
- **Routing table tab**: the published version, its generation time, and per route each
  ranked pair with accuracy and average cost. A pair appears only once it is measured.

### Failure states

A failed entry is `failed` (retryable) or `unavailable` (permanent), classified in
`src/profile-failure.ts`:

- **Permanent (terminal)**: `catalog_absent`, `context_too_small`, `model_not_found`,
  `unsupported`. The row goes `unavailable` at once with no retry time. It stays out of the
  routing table but does not hold the table back — a live pair that has no ready row and no
  measurement in flight leaves the table and is named in the publish log instead.
- **Retryable — model tier**: `provider_unavailable`, `model_resolution`. Counts against the
  model's budget (`PROFILE_MODEL_FAILURE_BUDGET = 3` consecutive failed runs).
- **Retryable — infrastructure tier**: `ambiguous_execution`, `container_capacity`,
  `catalog_load`, `grader`, `run_timed_out`, `orphaned_claim`, `run_init_failed`, `unknown`.
  Only the overall budget (`PROFILE_FAILURE_BUDGET = 5`) applies, so an outage that never
  clears still ends.
- Exhausting either budget makes the failure permanent. The next retry waits
  `2^(attempts-1)` hours, capped at 24.

Recovery: **Requeue retryable** (admin, `POST /admin/registry/requeue`) puts every retryable
row of a queue back to `pending` once its retry window has passed, charging no owner quota.
A permanent row moves only through its own **Re-admit**: the console posts
`POST /admin/registry/refresh` for that one pair with `mode: 'refresh'`, which clears its
failure history and puts it back to `pending` as soon as the catalog can run it. That covers
both a model whose budget ran out and one whose provider has since been fixed. The narrower
`mode: 'repair_unavailable'` (see "Unavailable models and targeted refresh") selects only
pairs with a recorded exact model-lookup failure, so it would leave a budget-exhausted row
in `skipped`.

### The remaining waits, and why they stay

- **No wait on the admin path.** A save that adds a model drains the platform queue in the
  same request, so the run exists by the time the save answers — no **Run platform queue**
  click and no cron wait. The drain is bounded at 5 s; if it is slow, or the queue is
  already starting a run or holds `MAX_RUNNING_RUNS_PER_QUEUE` active runs, the save still
  answers 200 with the saved config and reports why in `drain`:
  `skipped: 'timeout' | 'failed' | 'active_run' | 'nothing_pending'`. A drain that outlives
  the deadline is not abandoned: the save hands its promise to the request's
  `ctx.waitUntil`, so a claim that already started a run still records it, and the
  per-minute cron starts anything it did not reach within a minute. Nothing is lost.
- **Up to 60 s for an owner registration.** A custom router save admits its rows through
  `POST /admin/profiles/register`, which is not a benchmark config save and does not drain;
  the cron tick starts it. It stays because owner registrations arrive at arbitrary times
  and a drain is the only thing that can start their run.
- **The queue's earlier runs.** A queue holds up to 4 active runs and starts one at a
  time, so a new model gets its own run on the next drain instead of waiting behind the
  pair batch already in flight; see "The two registry queues". Runs of one
  `(router, queue)` share its execution share, and inside it the scheduler prefers the
  model with the fewest live chunks, so the new run's first cases start as soon as its
  models hold fewer slots than the earlier runs' models.
- **Initialization at 20 s per pass.** A D1 write budget, not a policy choice: one pass
  writes 50 chunks per batch so a big run never holds a single transaction open. A run
  needing more passes just takes longer before its first case.
- **The measurement itself.** Nothing removes it: it is the paid inference the benchmark
  exists to perform.
- **Publish waits for every serving pair.** The table is republished from the registry only
  when every pair it serves is current or a settled failure. This is what keeps a
  half-measured alias move from degrading the live table; it is also why one stuck pair used
  to hold the whole table (fixed 2026-11-20: a settled failure now leaves the table instead
  of blocking it).

### Measurement revision 3: agentic probes (active)

Every run records the revision it started under (`benchmark_runs.measurement_revision`),
and every result stores the revision that measured it in `prompt_revision`, with the CLI's
tool evidence (`tool_calls`, `tool_names`, `step_count`, `final_finish_reason`). Tool
evidence is recorded at every revision. `src/measurement-revision.ts` separates two
constants: `MEASUREMENT_REVISION` (3) is the newest defined revision, and
`ACTIVE_MEASUREMENT_REVISION` (3) is the revision every new run starts under. `startRun`,
`insertRun`'s default, case reuse and the `remeasure-prompt-transport` planner all use
the active revision. Revision 3 was activated with migration `0035_probe_activation`, which
also decides which pairs measure it now (below); nothing else in the deploy schedules
revision-3 work.

The CLI benchmark cannot see the production problem this revision measures: a CLI case is
one prompt to a fresh session, so a model that ends a tool-offering turn with narration
looks like any other wrong answer, and the revision-2 tool-required cases only check that
the final answer is right. Revision 3 asks production's question: given a session that is
mid-task and whose last message is a tool result, does the model continue with a tool call,
state the correct final answer, or stop?

**Probe cases.** `src/datasets/probe-cases.ts` replays the recorded sessions in
`src/datasets/probe-transcripts.ts` — the nine agentic transcripts the continuation pilot
captured, kept as data with their verification test — and cuts each after a completed step,
so every request's history ends on a tool result with no further user message. `PROBE_CUTS`
is the cut set: `{transcriptId, cutAfterStep}` pairs (21 today, one per tool-result step
end, 1-3 per transcript), so a cut can be dropped or added as a data change. Each cut
becomes a case with the transcript's agentic route (`taskType`/`subtaskType`), the
transcript's answer check and a `probe` field carrying the cut and the transcript; a probe
case has no CLI prompt. Ids are `probe-<transcript-id>-step-<n>`.

**Grading.** A probe reply scores 1 when it carries a tool call (the model continued the
task) or when its text is the case's correct final answer; narration, a wrong answer or an
empty reply scores 0. The check is exact or `json_equal`, so no judge is involved;
`gradeProbeOutput` (src/grading.ts) implements it.

**Templates.** `src/probe/family.ts` picks the family the way the pinned CLI does: the
catalog's `opencode.prompt`, else the model id, picks the system prompt, and
`opencode.ai_sdk_provider` picks the SDK and so the endpoint.
`src/datasets/probe-templates.json` holds one minimal template per family captured from CLI
7.8.27 against a local fake gateway that logs the request: `default/chat`
(`deepseek/deepseek-v4.1-flash-1017`), `ling/chat` (`inclusionai/ling-3.1-flash`, thinking),
`kimi/chat` (`moonshotai/kimi-k3`), `gpt/responses` (`openai/gpt-6-luna`),
`default/responses` (`x-ai/grok-4.7`), `meta/responses` (`meta/muse-ember`) and
`anthropic/anthropic` (`anthropic/claude-haiku-5.5`, the Messages API at
`POST /api/gateway/v1/messages`). A template pins the endpoint, the system prompt with its
cache breakpoints, the tool schemas, the fixed params, the static header values, how a
reasoning variant maps to the wire, and how history is encoded; `src/datasets/probe-captures`
keeps the captured requests and `src/probe/request.test.ts` rebuilds each of them from its
template, minus per-call ids and timestamps. On a CLI bump, regenerate both from this
package with Docker running and the workspace installed (needs `pnpm install` at the repo
root):

```
pnpm exec tsx scripts/capture-probe-templates.ts --pool /tmp/efficient-pool.json
```

It starts `scripts/probe-gateway.mjs`, builds the pinned CLI into `probe-capture:7.8.27`,
drives it through every family in the pool file and writes the fixtures, with no paid calls.
The pool file is the live Router pool as a JSON array of
`{ "model": string, "variant": string | null }`; `--only <family>` recaptures one family and
merges it into `probe-templates.json`, keeping every other family and the rest of the
bookkeeping. A model whose family has no template fails its probe lane with
`BenchmarkProbeFamilyError` (a permanent entry failure), never with a score of 0.

**Executor.** `src/probe/executor.ts` builds the request — template, the history up to the
cut, the pair's variant and catalog entry — and POSTs it with streaming to
`${KILO_CLI_API_URL}/api/gateway/v1/{responses|chat/completions|messages}` with the
short-lived bot token the worker mints once per queue message and the run's org. It parses
the SSE stream with zod into the CLI result shape (text, cost, tokens including reasoning,
tool calls, `finalFinishReason`, exit 0) inside the same paid ledger: `beginPaidCase`,
pending output, `recordDeciderOutput`. Cost comes from `usage.cost`; when the gateway omits
it the executor prices the reported tokens at the run's catalog rates
(`catalogUsageCostUsd`, src/platform-models.ts). A probe never touches the container, and
`latency_ms` is the whole reply, from the request to the end of its stream. The error policy
matches the CLI path: 429 and unbilled 5xx defer (throttle, no result), 400/404/422 marks the
exact model unavailable, a request or stream that runs into `DECIDER_CLI_TIMEOUT_MS` is a
timed-out result, a stream cut after the gateway billed for output is an ambiguous execution,
a terminal provider error that reported usage is a billed failure with its cost and tokens,
and a catalog read that fails after `beginPaidCase` clears the case and defers the chunk.

**Route-scoped eligibility.** After activation (`ACTIVE_MEASUREMENT_REVISION >= 3`) a ready
pair whose provenance run lacks complete probe results is ineligible on the three agentic
routes only: the platform table drops its results for those routes and keeps every other
route's measurement (`src/probe/eligibility.ts`). An agentic route with no eligible pair
keeps the candidates the live table already serves instead of emptying. Measuring a pair's
probes later, through the normal queue or an admin re-measure, makes it eligible again.
`supp-agent-term-pwd-base` is the one revision-2 case that changes: revision 3 keeps it
tool-required and accepts only `other`, the answer its isolated workspace produces.

Revision 3 is active from the deploy that raises `ACTIVE_MEASUREMENT_REVISION` to 3.
Migration `0035_probe_activation` is the whole activation scope, and it is what keeps the
spend bounded:

- The migration only *stages* the scope: it writes `probe_activations` rows, one per pair,
  with the action to take. It cannot write `profile_remeasures` rows or `pending` profiles
  directly, because a migration applies while the previous image is still serving and that
  worker claims both without knowing the revision: the queued pairs would run at revision 2,
  measure nothing they lack and lose their queue row, and the re-admitted rows would be
  measured without the probes. The old worker never reads `probe_activations`; the drain of
  the deploy that raises the revision consumes it once
  (`applyProbeActivations`, `src/probe-activation.ts`), and it waits while the deploy holds
  the dispatch lock so no instance of the previous image can be serving when the rows land.
  Each staged row also names the revision its action needs (`required_revision`), and the
  apply leaves every row staged whose revision the worker does not run.
- The 24 pairs that are `ready` at `efficient:v1:6649fed2`, repetitions 3 and need the
  probes become `profile_remeasures` rows (23 platform pairs plus
  `meta/muse-spark-1.2-contributor` `high`, a user-owned pair) — the rows the
  `remeasure-prompt-transport` `request` action writes. Each run claims one row, reuses every
  result that is still reusable and measures the 21 probe cuts plus
  `supp-agent-term-pwd-base` per repetition, so 22 cases × 3 repetitions per pair and
  nothing else. A pair whose provenance run already holds a revision-3 result for all 22 is
  skipped instead, so a pair is never re-measured by this activation.
- `meta/muse-ember` ×6 is re-admitted by the same activation: its 2026-11-11 rep-3 run lost
  a lane and left all six rows `failed` (class `unknown`), so they had no probe measurement
  and would stay ineligible on the agentic routes. The activation moves exactly those six
  rows back to `pending` with the per-row Re-admit's fields (`src/profile-refresh.ts`),
  `invalidated_at` included, and the next platform drain measures a full revision-3 run for
  them. The re-admit's invalidation is deliberate and is what the forecast prices: results
  measured before it are not reused (`reuseDeciderCaseResults` in `src/db.ts`), exactly as
  for an admin Re-admit. Ember is the model this grading exists for, so it is re-admitted on
  purpose now that narration stops are graded.
- Every other efficient decider run the system starts on its own also runs at revision 3:
  the per-minute cron drain and the 05:00Z platform sync drain every `pending` profile, and
  each run completion drains again. For a pair with all of its case results stored that is
  the same 22 cases × repetitions.
- The pair list lives in `src/probe-activation.ts` and is mirrored in the migration; the
  case list is the code's own `PROBE_ACTIVATION_CASE_IDS`, so the two cannot drift.
  `src/probe-activation-sql.test.ts` fails if the migration's pairs drift from it, if
  anything the live worker claims is visible before the activation is applied, if a
  re-admitted row that is not a retryable failure (or that has a live chunk) moves, or if a
  queued pair schedules a single case outside the probe set.
- At 3 repetitions and catalog prices the 23 platform pairs cost $19.63 / $19.81 / $20.45
  without cache (low/mid/high, $11.09 / $11.28 / $11.92 with half the input read from
  cache), and `meta/muse-spark-1.2-contributor` `high` — the 24th queued pair — adds
  $0.14 / $0.14 / $0.15 ($0.14 with half the input cached). The Ember re-admit adds
  $10.22 / $10.25 / $10.32: 3 × 90 agentic cases at the measured rep-1 cost, the 1,021
  missing non-agentic case-reps at $5.25, and its probes — a full run, because the re-admit
  invalidates the failed run's results. Activation total $29.99 / $30.20 / $30.92,
  $20.79 / $21.00 / $21.72 at 50 % cache.
- Rolling back is lowering `ACTIVE_MEASUREMENT_REVISION` to 2 and deploying: every staged
  row carries its `required_revision` (3), and `applyProbeActivations` skips — and leaves
  staged — every row the worker's revision does not reach. A deploy at revision 2 therefore
  neither queues the pairs nor re-admits the Ember rows; a later deploy that raises the
  revision back to 3 applies whatever is still staged. An activation already applied is
  cancelled by deleting the queued `profile_remeasures` rows, and the six Ember rows can go
  back to `failed` with their lane failure. The new table is additive and every stored
  result stays.
- The platform table keeps publishing every route; only the agentic routes narrow as
  described above.

`minimumCaseRevisions(router, revision)` maps each case to the oldest result revision a run
may reuse: 2 for the argv-affected cases, 3 for every probe case and
`supp-agent-term-pwd-base`. Prior-case reuse and the re-measure baseline copy skip results
below their case's minimum; the same `remeasure-prompt-transport` endpoint queues them, and
its dry run also reports `unmeasuredResults`, the current cases a provenance run never
measured, which the spend projection leaves out because they have no measured cost.

In the container, a case that requires a tool call runs with `isolated: true`: the CLI's
working directory (`PWD`) is a fresh temp workspace instead of the shared `/app`.

## Custom routers and client measurements

ADR 0005 custom routers rank a pool of gateway and client entries against one base
router. The serving worker and the web app resolve the router from PostgreSQL and send
its context (`CustomRouterBenchmarkContextSchema`: owner, base router, entries, and the
entry keys the owner's CLI measures); this worker has no PostgreSQL access.

- **Client profiles** (`client_profiles`) are keyed by owner, base router, entry kind,
  provider, model, variant, engine identity, and repetitions. They hold a rollup of the
  owner's uploads: accuracy, errors, timeouts, mean cost, p50/p95 latency, and per-route
  summaries. `client_case_results` keeps each uploaded output with its cost, duration,
  exit code, timeout flag, score, and grader cost. Each upload takes the next value of the
  profile's `upload_seq` as its `revision`, so revisions never repeat, even after a case is
  deleted and uploaded again: the rollup is written only if every stored upload still
  carries the revision the view was computed from, so a stale view never overwrites a
  newer one. A failed grader charge deletes only the upload with its own revision. Client rows never
  feed the platform table and are never copied into `benchmark_profiles`.
- A client profile is `ready` once one uploaded case ran without error, `failed` once every
  planned case repetition was uploaded and none did, and `pending` otherwise. Latency comes
  from the uploader's machine.
- **Tables** (`POST /admin/custom-router-table`): each pair serves its current ready
  measurement, otherwise its newest ready measurement from an older engine identity with
  `stale: true`. Gateway entries the platform measures use `benchmark_profiles`; client
  entries become `client:<provider>/<model>` candidates priced from the entry (absent
  pricing is $0). Thresholds and ranking knobs are the base router's effective policy.
  The version includes the base router, engine identity, and each client profile's upload
  count.
- **Status** (`POST /admin/custom-router-status`): `ready`, `stale`, `pending`, `running`,
  `failed`, or `missing` per variant. A platform pair with only older-engine rows is
  re-admitted for free.

### Client eval API

The auto-routing worker forwards the CLI's public calls to these routes with the owner
context; schemas live in `@kilocode/auto-routing-contracts`. Errors use
`CustomRouterErrorResponseSchema` with `CUSTOM_ROUTER_ERROR_HTTP_STATUS`.

| Route | Request | Behavior |
|---|---|---|
| `POST /v1/eval/plan` | `InternalClientEvalPlanRequestSchema` | Every (entry, variant, case, repetition) without a successful current-engine upload, plus `staleEntries` that still serve an older-engine measurement |
| `POST /v1/eval/case` | `InternalClientEvalCaseRequestSchema` | `prompt`: the exact `kilo run` prompt the platform container sends (`deciderCliPrompt`, so client and platform rows share byte-identical prompts), and the 180-second timeout; checks and golden answers stay here |
| `POST /v1/eval/result` | `InternalClientEvalResultRequestSchema` | Grade with the platform graders, store, roll up the profile, return the score |

- An upload for another engine identity returns `stale_engine_identity` (409); the CLI
  requests a new plan. Unknown cases, variants outside the entry, and repetitions beyond
  the base router's fixed decider repetitions return `invalid_request`.
- Grading matches the platform: a nonzero exit, a timeout, or empty output scores 0;
  otherwise the case's mechanical check or the System One judge grades it.
- Judged grading cost is billed to `billing.userId` and `billing.organizationId` as usage
  model `auto-routing/grader` through `/api/internal/usage/record`, before the result is
  stored. The usage id derives from the graded case, so a retried upload records it once.
  If usage cannot be recorded the upload fails with `internal_error` and nothing is stored.
  The serving worker checks the paying owner's balance before forwarding.
- A case repetition reuses its stored score only after exit code 0, no timeout, and nonempty
  output. Nonzero exits, timeouts, and empty output remain in the plan; a new upload replaces
  the failed attempt.
- A judged upload grades under a per-case claim (`client_case_grading_claims`, one row per
  profile, case and repetition). The claim holder runs the judge; a parallel upload of the
  same case returns the stored score once the holder finishes, and otherwise fails with
  `internal_error` instead of starting a second grading. The claim is released when its
  grading ends, and a lease lets the next upload take over one left by a vanished request.

Rollout: apply the additive D1 migration (new tables and the `profile_request_events.router`
column, defaulting existing rows to `efficient`) with the deploy; no queue pause is needed.

## Local development

The worker is part of the dev runner. From the repo root:

```bash
pnpm dev:start auto-routing
```

This brings up the auto-routing worker (:8810), this worker (:8814), and the
Next.js gateway (:3000). Logs land in `dev/logs/*.log`; the tmux session is
`kilo-dev-<worktree>`. The `predev` script applies this worker's D1 migrations to
the local database before `wrangler dev` starts, so a fresh stack has every table.

### Required env / secrets

- **`.dev.vars`** (copy from `.dev.vars.example`): `KILO_WEB_API_BASE_URL`
  (`http://localhost:3000`) and `KILO_CLI_API_URL`
  (`http://host.docker.internal:3000` under OrbStack — containers can't reach
  `localhost`).
- **Secrets store** (seeded via `pnpm dev:env -y auto-routing-benchmark`, not
  `.dev.vars`): `INTERNAL_API_SECRET_PROD` (same value as the gateway's
  `INTERNAL_API_SECRET`), `BOT_TOKEN_MINT_SECRET` (same value as the gateway's
  `BOT_TOKEN_MINT_SECRET`; it authenticates only the decider CLI token mint)
  and `OPENROUTER_API_KEY`.

### Hitting it locally

```bash
SECRET=$(grep '^INTERNAL_API_SECRET=' ../../.env.local | cut -d= -f2- | tr -d '"')
curl -s http://localhost:8814/admin/config -H "Authorization: Bearer $SECRET"
```

A fresh local database has no benchmark configuration, and none is fabricated
(ADR 0002): profile admission, custom routers, and client evals
answer 400 `benchmark config not set` until one is saved. Save one per base router
you use, with models from your local catalog, through the admin panel's Benchmarks
tab or this call (repeat with `?router=frontier` for frontier):

```bash
curl -s -X PUT 'http://localhost:8814/admin/config?router=efficient' \
  -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -H 'x-updated-by: you@kilocode.ai' \
  -d '{"classifierModels":["<system-one-model>"],"deciderModels":[{"id":"<catalog-model>"}],
       "minAccuracy":0.7,"benchmarkUserId":null,
       "updatedAt":null,"updatedBy":null}'
```

Decider runs use the worker's default benchmark user (`bot-internal-benchmark`)
and org unless `benchmarkUserId` / `benchmarkOrgId` overrides are saved in
config. Each queue message mints a one-hour CLI token from
`POST /api/internal/bot-token`, which only issues for internal bot users
(`bot-internal-*`) that belong to the org, so a non-bot override fails the run
start with a clear error. Create the user locally from the admin
**Internal Bot Users** page; it also needs credits.

> Local KV/D1 writes from a *second* `wrangler` process are not seen by the
> running dev process (miniflare holds its own view). After writing state out of
> band, `pnpm dev:restart auto-routing-benchmark` to make it visible.

## D1

Single squashed baseline migration in `migrations/`. Regenerate after a schema
change in `src/db-schema.ts`:

```bash
pnpm db:generate     # drizzle-kit generate
pnpm typecheck && pnpm test
```

Production migrations apply inside the guarded `pnpm run deploy` flow. The local database
uses the `predev` hook (`--local`; `CI=1` skips wrangler's confirmation prompt, which would
otherwise block the dev runner's tmux pane).

Inspect local D1 by copying the sqlite out (direct reads often hit miniflare
locks):

```bash
cp .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite* /tmp/
sqlite3 /tmp/<file>.sqlite 'select id, kind, status from benchmark_runs;'
```

## CLI under test

`container/Dockerfile` pins the base image digest and `KILO_CLI_VERSION` (7.8.27, the version
production ran when it was pinned). Before the pin, every image build installed
`@kilocode/cli@latest`, so the measured CLI could change under an unchanged engine identity
whenever the dist-tag moved.

The CLI version is not part of the engine identity and runs do not record it: the image
pin is the record. A new engine identity makes every stored measurement ineligible, so a full
pool re-measure follows. A `KILO_CLI_VERSION` bump is therefore a measurement change that
needs a planned, budgeted re-measure: bump `BENCHMARK_ENGINE_VERSION` in `src/run.ts` in the
same change once that re-measure is approved.

The pin does not make the image byte-for-byte reproducible: `apt-get` installs the current
Debian packages, and file timestamps differ between uncached builds.

## Debugging container (decider) failures

- Reusable `benchmark-slot:<n>` containers handle dynamically assigned chunks from any run.
  The D1 live-slot uniqueness constraint and claim tokens protect container ownership.
  CLI runs remain serialized because they share SQLite state.
- `/warmup` initializes the local CLI database once per container without making an inference request.
- The case prompt reaches `kilo run` on stdin, never as an argument. Long-context cases are
  materialized with their workspace snapshot (up to about 640 KB for 160k-token targets),
  which exceeds Linux's 128 KiB limit on one argument, and `kilo run` re-quotes argument
  messages that contain spaces. With no positional message the CLI reads stdin to EOF and
  sends it verbatim as the user message.
- The server handles SIGTERM and drains the CLI case it already accepted, then exits.
  A case still queued when SIGTERM arrives is refused with `503` instead of starting a new
  paid call, after its callback records `not_started`.
- Every completed case is posted to the worker's `/container/case-result` route, before the
  HTTP response unless the first post fails. A Durable Object request keeps running after its
  caller is canceled, so `BenchRunnerContainer` relays the caller's `request.signal` (enabled by
  the `enable_request_signal` compatibility flag) to the container request. The route accepts
  only the exact paid-execution generation that opened the case.
- `sleepAfter` is 10 minutes, longer than the CLI timeout plus the whole delivery schedule.
  Outbound posts do not count as container activity, so a shorter idle timeout could send
  SIGTERM while a delivery is pending; the server then drains it but refuses new cases.
- Completed or failed runs reject queued work before starting another CLI case.
- Smaller chunks leave time for an empty-output retry within the queue invocation limit.
- `case_results` rows carry diagnostics: CLI exit code, output prefix, and an
  event tail — start there for a failing case.
- `POST /admin/debug-cli {model, prompt}` runs one prompt through the container
  and returns truncated stdout + the parsed result, without a full run.
- Container → host networking: under OrbStack use `host.docker.internal`; the
  Docker Desktop gateway IP `192.168.65.254` does **not** work there (times out).
- Wrangler pulls the egress proxy image as amd64; on Apple Silicon it crashes
  unless the dev runner pins the arm64 manifest digest
  (`MINIFLARE_CONTAINER_EGRESS_IMAGE`) — already handled by the dev runner.

## Dead-letter handling (lane failure)

Failed queue messages land in the dead-letter queue after transport retries.
A token-bearing decider message is a delivery of one durable chunk claim, not ownership
of a fixed chain. Its DLQ handler atomically releases only a still-queued matching token;
it never revokes active ownership. Expired leases recover abandoned executing claims.
The scheduler records a lane death only when recovery is exhausted or a paid case's output
can no longer arrive.
Classifier dead-letter handling remains fail-fast.

`run_lane_failures` preserves lane-aware finalization: a run settles once each
(model, variant, repetition) lane has all its cases or a recorded failure, and each record
carries the failure class of its cause.

The periodic dispatch sweep ignores pending chunks in failed lanes when checking run completion.
It retries finalization after a canceled completion handler without starting duplicate inference.

- **Decider runs of either queue** complete per-entry: entries whose lanes all
  finished go `ready`; entries with a dead lane fail with the most severe class their
  lanes recorded (terminal over model over infrastructure). The admin requeue, a
  per-row re-admit or the owner's Retry (quota-charged) re-admits them. One failing
  model never discards the results of the others, which matters because each one cost
  real money to produce.
- **Catalog load failures** refund the chunk's attempt and hold every dispatch for the
  backoff, like provider throttles. After 24 catalog deferrals the chunk falls back to
  ordinary attempts, so a catalog that never loads still ends the lane.
- **Classifier runs** still fail fast on a dead lane: their models are not
  registry-tracked and the winner must come from one comparable set.
- **Backstop**: the 6h stale sweep salvages legacy decider runs that never completed
  scheduler initialization. Initialized runs use bounded per-chunk leases instead of
  an absolute run-age timeout, so legitimate backlogs do not discard ongoing measurements.

Retries reuse successful graded cases from compatible terminal runs.
The router, benchmark engine, repetitions, concrete model, variant, case, and repetition index must match.
The newest compatible case wins; existing destination results and source rows remain unchanged.
Failed or timed-out CLI cases run again; a successful zero score remains a valid measurement.
Pending successful CLI outputs also survive terminal transitions so rubric grading can resume without another model call.
Historical alias-keyed results remain stored but cannot be reused because their concrete target was not recorded.

To inspect:

- **Prod**: Cloudflare dashboard (Workers → Queues →
  `auto-routing-benchmark-dlq`); scheduler messages contain `runId`, `model`,
  `claimId`, and `claimToken`. Inspect `scheduler_chunks` for queued/active slots,
  attempts, and lease deadlines; `run_lane_failures` records terminal lane failures.
- **Replay**: failed entries re-admit via the owner's Retry or the admin's
  requeue endpoint, and the next drain of their queue measures them. Entries that
  are already `ready` are never re-measured.

## Commands

```bash
pnpm dev          # wrangler dev (port 8814)
pnpm typecheck    # tsgo --noEmit
pnpm lint
pnpm test         # vitest run
pnpm smoke:scheduler # real SQLite + heterogeneous child-process work; no model endpoint
pnpm db:generate  # regenerate D1 migration from src/db-schema.ts
```
