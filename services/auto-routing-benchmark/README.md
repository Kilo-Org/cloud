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
`frontierMinAccuracyDelta`, token profile, switch horizon and thresholds are configured
independently. The classifier and its winner remain shared:
classifier runs use the efficient configuration even when requested from the frontier view.
Classifier inference billing is owned by the routing worker. Usage IDs and durable delivery
objects include the router, so an otherwise identical call on another router cannot be
deduplicated as a retry of the first call.
Capability lookups derive candidate IDs from the selected router's table; the capability
cache remains a shared model-ID union because modalities and context limits belong to models.

Both routers are custom-router bases (ADR 0005): owner profile admission, the owner queue,
custom router tables, and client evals accept `efficient` and `frontier`.
Owner work for a base uses that base's configuration, dataset, engine identity, and quota.

## System-optimal policy settings

The daily platform sync recomputes each router's policy settings before publishing, and stores
the result on the router's `benchmark_config` row (`policy_computed`) with its `computedAt`,
`source`, and a short evidence string. The effective value of a setting is
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
  fixed constants: the held-out benchmark scores single requests, so session-economics and
  measurement-effort knobs have no measured basis for a daily recomputation. The Policy tab
  shows their value and the reason they are read-only.

Frontier initially has no saved configuration or published table. No default model pool or
efficient table is fabricated for it. Before enabling frontier serving, administrators must
save a frontier configuration with its own decider models, benchmark those entries, and
publish a complete frontier table.

Decider execution uses a global pool of reusable container slots, not run reservations.
An atomic D1 claim selects an eligible unfinished chunk from any running run whenever a
slot becomes free. Queued and executing claims both count against the limit.
The pool is bounded by `BENCHMARK_CONTAINER_BUDGET`, the queue consumer concurrency,
and container `max_instances`; increasing the platform ceiling requires a Cloudflare limit increase.
Containers are named by slot and run one CLI at a time. There are no fixed shard chains.
One-case chunks leave room for warmup, the existing empty-output retry, and grading within
the queue invocation deadline; prompts, variants, CLI timeouts, repetitions, cost accounting,
and CLI-reported latency remain unchanged.

`BENCHMARK_SCHEDULER_CONFIG` is a JSON object. Defaults are `slots: 250`,
`modelConcurrency: 12`, `providerConcurrency: 16`, and `unknownProviderConcurrency: 2`.
Optional `modelLimits` and `providerLimits` objects override those defaults by exact identity.
`shares` defaults to
`{"efficient/platform":2,"frontier/platform":2,"efficient/user":1,"frontier/user":1}`.
The least-occupied weighted share receives the next eligible claim; unused shares are
borrowed without reservations or preempting active work. Model caps span variants and runs.
Provider identities come from the catalog's optional `inference_provider_ids`, which uses
the existing gateway provider index. Every possible provider is conservatively counted;
missing metadata shares a small unknown-provider bucket. Model-name prefixes are never
treated as serving providers. Each router has an owner queue with its own share.

Admins can override `slots`, `modelConcurrency`, `providerConcurrency`, and
`unknownProviderConcurrency` at runtime, without a deploy, from the Scheduler card on the
admin panel's Benchmarks tab or with `PUT /admin/scheduler-config`. Each limit resolves
admin override, then `BENCHMARK_SCHEDULER_CONFIG`, then the default. Overrides live in the
single-row `scheduler_settings` D1 table; each dispatch pass reads it once by primary key, so
a change applies on the next completion or one-minute tick. The PUT body replaces the whole
override set: a missing or `null` limit clears that override. Values must be integers from 1
to `BENCHMARK_CONTAINER_BUDGET`; anything else, including an unknown key, is a 400.
`modelLimits` and `providerLimits` still come only from the env config and take precedence
over `modelConcurrency` and `providerConcurrency` for their exact identities.
`GET /admin/scheduler-config` returns each limit's `effective` value, its `source`
(`admin`, `env`, or `default`), the `override`, and the `fallback` used without one.

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
and unbilled provider-throttle waits do not create model-failure rows.

A dispatch pass reads current occupancy and the next pending chunk of every lane — one
`(run, model, variant, repetition)` chunk chain — and claims as many of those lanes as fit.
Both reads are index seeks: occupancy is bounded by the slot budget, lane heads by the
number of lanes, so cost does not grow with the pending backlog. Each claim is a
conditional `UPDATE ... WHERE id = ? AND status = 'pending'` that assigns a free slot.
Only one pass runs at a time; a pass holds a short lease row and a dispatcher that finds it
held returns immediately, because the holding pass has already read that wake's
completions. The per-minute tick is the backstop if a lease expires without a release, and
the `(status, run_id, model, variant, repetition, chunk)` index bounds lane reads.

A provider or model throttle records a cooldown deadline rather than stamping every
pending row, so one throttle event costs a bounded write instead of rewriting the backlog.

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

Run completion accounting reads every case result of the run, so it does not run per
completed chunk. A completion first asks whether the run still has scheduled work — an
index probe for a chunk that is pending, queued or active in a lane that has not
dead-lettered — and only settled runs are accounted. Chunks of a dead-lettered lane never
count as unsettled, so a run with a dead lane still settles once its live lanes finish, and
runs with no scheduler chunks (legacy whole-run work) are always accounted. The dispatch
sweep and the dead-letter path remain responsible for runs that settle without a train of
completions. Chunk recovery and the 24-hour prune batches are likewise bounded: recovery
completes only the runs that still hold unsettled chunks, and pruning is driven from the
per-run scheduler markers instead of scanning the chunk, execution or run tables.

Completed cases are skipped, and all final CLI outputs are persisted before grading.
A separate paid-execution ledger records when each paid case started and prevents automatic
repetition if a worker disappears after inference may have started but before an output was
saved. The container finishes a case whose caller is gone, posts the output back to the
worker, and refuses the cases it had not started, so an interrupted lane resumes from
recoverable output or repeats a case that provably made no paid call.

A chunk that finds a ledgered case without output waits for it instead of failing its lane.
It keeps its slot and provider lease, so the wait cannot oversubscribe providers, and its
claim is redelivered every 30 seconds to recheck. The wait ends when the output arrives,
which the chunk then grades, or once the decider case timeout (180 seconds) plus the
container's delivery window (90 seconds) has passed since the case's latest paid call started
(an empty-output retry restarts it in the ledger). Only then does the case count as genuinely
ambiguous (a container hard-killed mid-flight, or a lost delivery): it fails its measurement
lane as infrastructure uncertainty instead of inventing a score or issuing another paid call.
A recheck mints no user token and warms no container.
Manual requeue creates a new run and may repeat that unknown case; compatible completed cases
and pending successful outputs are still reused.
Terminal scheduler rows are pruned in bounded batches after 24 hours. Benchmark history,
completed case results, and pending outputs remain available for compatible reuse.

Rollout first exposes catalog provider metadata, then applies the additive D1 migration while
the queue is paused. Wait for old consumers to quiesce and stop old run-scoped containers
before enabling the new worker. Legacy queued chunk bodies are wakeups only: it materializes the run's
entire remaining workload from its snapshot and schedules it under the same global caps.
Old chunk/shard metadata cannot grant ownership. Do not run old and new consumers together
or roll back while scheduler claims are active. Pause and quiesce first; complete or requeue
affected runs before returning to an older worker. This change does not deploy or resume work.


Efficient publications invalidate `routing_table_v1`; frontier publications invalidate
`routing_table_frontier_v1`. Router, engine/dataset identity, ranking settings, and contributing
measurements are included in routing-table version hashes.


## Platform model selection

- Select a model, not one effort, in the platform configuration.
- The worker resolves `~` model aliases through the catalog's `alias_target` when the concrete target is present, then expands every reasoning variant from that target's current `/api/openrouter/models` entry. An alias whose target is absent stays alias-keyed.
- Exact resolved `(model, variant)` pairs are deduplicated: an alias and its target, or multiple aliases for one target, share a measurement. Retargeting an alias requests the new concrete pair instead of reusing the old target's result.
- Variants must contain explicit `reasoning.enabled` or `reasoning.effort` controls. Unrelated presets do not create benchmark entries.
- A model without reasoning controls creates one `(model, null)` entry.
- If the catalog fails or omits a selected model, reconciliation fails. It does not infer a default effort.
- Catalog requests have a 10-second deadline, including body reads, so a stalled response cannot block both queues indefinitely.
- Manual and automatic selections use the same expansion. Existing saved effort selections no longer restrict platform measurements.
- Custom router gateway entries use the same alias resolution and all-efforts expansion, sharing concrete measurements with the platform. Status responses preserve the requested model ids; custom router tables use concrete ids.
- Before the owner queue claims a batch, each pending owner-requested alias row whose target resolves hands its owner request to the concrete pair (creating it pending when absent) and drops its own. This converts owner rows registered before alias resolution, and stops an alias and its target from being measured twice. A variant the target no longer offers only loses the request; the next status lookup re-admits the target's current pairs. Running, failed, and ready alias rows are untouched.

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
- Frontier's effective threshold is `min(1, minAccuracy + frontierMinAccuracyDelta)`. The delta is fixed at 0, so the frontier router uses its own system-computed `minAccuracy`.
- Both routers use the same best-value formula, selecting models and efforts from their own measured pools.
- Daily re-evaluation: `minAccuracy`/`accuracyNoiseBand` come from a held-out grid over the
  registry's measurements, `productionTokenProfile`/`switchHorizonTurns` from production auto
  usage (mean uncached/cached input tokens per request, median requests per session), and the
  rest are fixed constants. Admin overrides win over the computed values.
- Competing candidates are ordered by `estimatedRequestCostUsd × effectiveLatency^1.5 / wilson^15`, lowest first. With known TTFT, `effectiveLatency = p50TtftMs + LATENCY_TOTAL_WEIGHT × p50LatencyMs`, where the exported `LATENCY_TOTAL_WEIGHT` is 0.15 (tuned on a fully streamed offline sweep); without TTFT, total `p50LatencyMs` alone preserves legacy ordering.
- `estimatedRequestCostUsd` adds the configured `productionTokenProfile` prompt cost at catalog prices to `avgCostUsd`. Without a profile or pricing, it equals `avgCostUsd`.
- `wilson` is the Wilson lower bound (z = 1) of accuracy over the candidate's measured `cases`. A well-measured candidate beats a thinly measured one at equal accuracy. Without `cases`, raw accuracy is used.
- A candidate whose `estimatedRequestCostUsd` is exactly 0 outranks every paid candidate inside the accuracy band and takes no cost term (ADR 0005): $0 candidates are ordered by `effectiveLatency^1.5 / wilson^15` alone, so a free-but-slow or thinly measured one still loses to a free candidate with latency and coverage. Paid ordering is unchanged. Client models in a custom router are the usual source of $0.
- The other candidates follow by accuracy, then cost.
- When `lowConfidenceThreshold` is set and the classifier's route confidence is below it, the worker picks the most accurate eligible candidate of the route instead of the first-ranked one.
- `meetsThreshold` stays strict (`accuracy >= minAccuracy`) for sticky routing.
- The ranking policy version is part of every registry table version, so a policy change republishes.

Production CLI benchmarks currently record total latency only, so published D1
tables use the total-latency fallback. Offline sweep and candidate-screen
summaries carry measured TTFT and use the TTFT-aware formula; missing TTFT is
never fabricated.

The optional `effortByComplexity` table mapping selects a variant after the model
has been picked, using the production classifier's `low`, `medium`, or `high`
reasoning-complexity bucket. It never changes models or restores a candidate
excluded by the decision filters. Same-model effort changes retain the prompt
cache and do not trigger cost-switch logic; sticky-immediate turns retain the
incumbent variant until a classification is available.

Platform and custom-table builds read `case_results` for each ready pair's exact
provenance run and join the committed `src/datasets/case-complexity.json` labels.
Missing labels are ignored. Each route/model/bucket ranks its measured variants
with the same value policy, falling back to the route-level variant when fewer
than six distinct graded cases are available. Mappings are persisted with the
table and included in its version identity.

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
Direct TTFT is time to the first nonempty content or reasoning delta; final streaming
usage supplies cost. Container TTFT uses the first text event timestamp (or text
`time.start`) relative to request start, and is null when timestamps are unavailable.
Legacy sweeps without TTFT remain readable and do not substitute total latency.
Missing picks are excluded; `quality.heldOut.routes` reports coverage.
`--max-usd` includes model and grader spend (in-flight requests can overshoot).
Atomic checkpoints every 200 cases retain each pair's raw `results`;
`--resume sweep.json` requires the same suite and pairs, skips completed
pair/case/repetitions, and retains accumulated spend.
Infrastructure/grader failures are excluded from graded `cases` and counted in summary
`errors`; empty answers score zero. Missing usage still permits grading but makes
`costUsd` null and excludes that row only from the cost mean. Graded training candidates
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
Direct requests, streaming TTFT, retries, long-context materialization, and grading
reuse the offline sweep path. Set `OPENROUTER_API_KEY`; no container is required.

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
| `GET/PUT /admin/config` | Read / save benchmark config (model lists, thresholds, `benchmarkUserId`, optional `benchmarkOrgId`) |
| `GET/PUT /admin/scheduler-config` | Read effective scheduler limits with their source / replace admin overrides of `slots`, `modelConcurrency`, `providerConcurrency`, `unknownProviderConcurrency` |
| `GET /admin/runs` | List runs (sweeps stale `running` runs to `failed` first) |
| `POST /admin/runs` | Classifier: start a run (`{kind: 'classifier', force}`). Decider: reconcile + drain the registry queues (`{kind: 'decider', queue: 'platform' \| 'user' \| 'both'}`) |
| `GET /admin/registry` | Queue counts and exact platform entry statuses under the current engine identity and repetitions |
| `POST /admin/registry/requeue` | Put failed registry rows back to `pending` (`{scope}`); charges no owner quota |
| `GET /admin/routing-table` | Latest published **platform** routing table |
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
| Run lifecycle | One active run per router/queue | One active owner run per router |

All four shares use the same bounded chunk scheduler and borrow unused capacity.
`benchmark_runs.max_concurrency` is retained for storage compatibility but new decider
runs write zero: it is not an execution reservation. Registry admission is still atomic
per exact pair, and the per-router/queue run lifecycle gate remains independent of slots.

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
                 ↘ failed (bounded failure_reason; Retry re-admits)
```

- **running**: set when a decider run of either queue claims the entries at `startRun`.
- **ready**: set when that run completes successfully (`run_id` provenance
  points at the measuring run).
- **failed**: set when the run fails (enqueue, timeout sweep, etc.) — or, at
  profile-run completion, per entry whose lane dead-lettered while the run's
  other entries become `ready`. Only rows still pointing at that `run_id`
  transition — a newer pending/ready row is never clobbered.

Currency: a profile is current only when `engine_identity`, `repetitions`, and
exact variant match the live decider engine. The platform table never uses a stale row.
Custom router tables serve a stale row, flagged `stale`, until the current one is ready (see
below).

**Per-queue drain** (after any decider terminal state, on the admin's manual
trigger, and on the one-minute cron):

1. If that queue's run is active, leave its pending registry rows alone.
2. Otherwise take up to 100 current-engine entries oldest-`requested_at`-first.
3. `startRun(purpose: queue, entries: snapshot)` persists the workload, then the
   global scheduler claims only the chunks that fit its current caps.

A row wanted by both queues appears in both listings; whichever run claims it
first flips it to `running`, so it is still measured exactly once.

**Scheduled handlers:**

- `* * * * *` — recover expired chunk claims, sweep stale runs, and drain both queues.
- `0 5 * * *` — sweep, reconcile the platform queue with each router's
  admin-configured decider list, drain both queues, republish the
  platform table (so a *removed* model leaves the live table even when nothing
  new needed measuring).

Long waits stay `Benchmarking` in the UI; there is no second timeout state in v1.

## Custom routers and client measurements

ADR 0005 custom routers rank a pool of gateway and client entries against one base
router. The serving worker and the web app resolve the router from PostgreSQL and send
its context (`CustomRouterBenchmarkContextSchema`: owner, base router, entries, and the
entry keys the owner's CLI measures); this worker has no PostgreSQL access.

- **Client profiles** (`client_profiles`) are keyed by owner, base router, entry kind,
  provider, model, variant, engine identity, and repetitions. They hold a rollup of the
  owner's uploads: accuracy, errors, timeouts, mean cost, p50/p95 latency, and per-route
  summaries. `client_case_results` keeps each uploaded output with its cost, duration,
  exit code, timeout flag, score, and grader cost. Client rows never feed the platform
  table and are never copied into `benchmark_profiles`.
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
| `POST /v1/eval/plan` | `InternalClientEvalPlanRequestSchema` | Every (entry, variant, case, repetition) without a current-engine upload, plus `staleEntries` that still serve an older-engine measurement |
| `POST /v1/eval/case` | `InternalClientEvalCaseRequestSchema` | `prompt`: the exact `kilo run` prompt the platform container sends (`deciderCliPrompt`, so client and platform rows share byte-identical prompts), and the 180-second timeout; checks and golden answers stay here |
| `POST /v1/eval/result` | `InternalClientEvalResultRequestSchema` | Grade with the platform graders, store, roll up the profile, return the score |

- An upload for another engine identity returns `stale_engine_identity` (409); the CLI
  requests a new plan. Unknown cases, variants outside the entry, and repetitions beyond
  the base router's `deciderRepetitions` return `invalid_request`.
- Grading matches the platform: a nonzero exit, a timeout, or empty output scores 0;
  otherwise the case's mechanical check or the System One judge grades it.
- Judged grading cost is billed to `billing.userId` and `billing.organizationId` as usage
  model `auto-routing/grader` through `/api/internal/usage/record`, before the result is
  stored. The usage id derives from the graded case, so a retried upload records it once.
  If usage cannot be recorded the upload fails with `internal_error` and nothing is stored.
  The serving worker checks the paying owner's balance before forwarding.
- A case repetition that is already stored returns its stored score without grading again.

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
  `INTERNAL_API_SECRET`) and `OPENROUTER_API_KEY`.

### Hitting it locally

```bash
SECRET=$(grep '^INTERNAL_API_SECRET=' ../../.env.local | cut -d= -f2- | tr -d '"')
curl -s http://localhost:8814/admin/config -H "Authorization: Bearer $SECRET"
```

A fresh local database has no benchmark configuration, and none is fabricated
(ADR 0002): profile admission, owner-pool tables, custom routers, and client evals
answer 400 `benchmark config not set` until one is saved. Save one per base router
you use, with models from your local catalog, through the admin panel's Benchmarks
tab or this call (repeat with `?router=frontier` for frontier):

```bash
curl -s -X PUT 'http://localhost:8814/admin/config?router=efficient' \
  -H "Authorization: Bearer $SECRET" -H 'content-type: application/json' \
  -H 'x-updated-by: you@kilocode.ai' \
  -d '{"classifierModels":["<system-one-model>"],"deciderModels":[{"id":"<catalog-model>"}],
       "minAccuracy":0.7,"switchCostFactor":3,"benchmarkUserId":null,
       "updatedAt":null,"updatedBy":null}'
```

Decider runs use the worker's default benchmark user and org unless
`benchmarkUserId` / `benchmarkOrgId` overrides are saved in config. Any
effective benchmark user must exist locally with credits and belong to the
effective org. The dev seed provides `auto-routing-cli-local`.

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

Migrations apply on deploy via the `predeploy` hook
(`wrangler d1 migrations apply auto-routing-benchmark --remote`), and to the local
database via the `predev` hook (`--local`; `CI=1` skips wrangler's confirmation prompt,
which would otherwise block the dev runner's tmux pane).

Inspect local D1 by copying the sqlite out (direct reads often hit miniflare
locks):

```bash
cp .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite* /tmp/
sqlite3 /tmp/<file>.sqlite 'select id, kind, status from benchmark_runs;'
```

## Debugging container (decider) failures

- Reusable `benchmark-slot:<n>` containers handle dynamically assigned chunks from any run.
  The D1 live-slot uniqueness constraint and claim tokens protect container ownership.
  CLI runs remain serialized because they share SQLite state.
- `/warmup` initializes the local CLI database once per container without making an inference request.
- The server handles SIGTERM and drains the CLI case it already accepted, then exits.
  A case still queued when SIGTERM arrives is refused with `503` instead of starting a new
  paid call, so a rollout is never charged for work it interrupts. Idle containers therefore
  release capacity instead of ignoring the inactivity stop.
- A drained case whose caller disappeared is posted to the worker's `/container/case-result`
  route, which stores it as pending output. A Durable Object request keeps running after its
  caller is canceled, so `BenchRunnerContainer` relays the caller's `request.signal` (enabled
  by the `enable_request_signal` compatibility flag) to the container request; without that,
  the container would answer the Durable Object and never post. The route is authenticated
  by the paid-execution claim token instead of the backend secret, which a container never
  holds, and it only records outcomes for a claim token that actually opened the execution.
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
(model, variant, repetition) lane has all its cases or a recorded infrastructure failure.

- **Decider runs of either queue** complete per-entry: entries whose lanes all
  finished go `ready`; entries with a dead lane go `failed` ("Benchmark lane did
  not finish…"). A requeue re-admits them — the owner's Retry (quota-charged) or
  the admin's `POST /admin/registry/requeue` (free). One failing model never
  discards the results of the others, which matters because each one cost real
  money to produce.
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
