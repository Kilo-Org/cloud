# auto-routing-benchmark

Cloudflare Worker that benchmarks candidate models and publishes the artifacts
that drive `kilo-auto/efficient` routing. It is the **sole writer** of the
routing table and classifier winner; `services/auto-routing` and the `apps/web`
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
- **Decider benchmark** — runs 180 golden tasks per candidate through the real
  `kilo` CLI inside a Cloudflare Container and grades mechanically. Every result
  lands in the **global decider registry** (`benchmark_profiles`), keyed by exact
  `(model, variant)` under the live engine identity and repetitions. Both the
  platform routing table and each owner's custom table are assembled from that
  one registry, so a model wanted by the platform list and by an owner pool is
  measured once.
- Normalized results live in D1 (`BENCH_DB`); published artifacts are cached in
  the shared `AUTO_ROUTING_CONFIG` KV namespace (publish = delete the keys so the
  next read repopulates from D1).

## Platform model selection

- Select a model, not one effort, in the platform configuration.
- The worker expands each selected model into every reasoning variant from the current `/api/openrouter/models` catalog.
- Variants must contain explicit `reasoning.enabled` or `reasoning.effort` controls. Unrelated presets do not create benchmark entries.
- A model without reasoning controls creates one `(model, null)` entry.
- If the catalog fails or omits a selected model, reconciliation fails. It does not infer a default effort.
- Catalog requests have a 10-second deadline, including body reads, so a stalled response cannot block both queues indefinitely.
- Manual and automatic selections use the same expansion. Existing saved effort selections no longer restrict platform measurements.
- Owner pools still select exact pairs. Platform expansion does not change their entries.

Each pair uses its own CLI variant, results, cost, latency, and registry provenance.
The worker drains expanded entries in batches that fit the configured container budget.
New routing tables rank exact pairs and emit `variant`, not `reasoningEffort`.
Legacy nullable storage columns remain; this change requires no migration.

The admin panel shows measured coverage and pending, running, or failed efforts per model.
Each route starts collapsed with its first-ranked pair, accuracy, and cost.
Expand a route to inspect every ranked model/effort pair.

## Ranking

- `rankCandidates` (`@kilocode/auto-routing-contracts`) orders every route's candidates.
- A candidate competes when its accuracy is at most 0.05 below `minAccuracy`, the benchmark noise band.
- Competing candidates are ordered by `estimatedRequestCostUsd × effectiveLatency^1.5 / wilson^15`, lowest first. With known TTFT, `effectiveLatency = p50TtftMs + LATENCY_TOTAL_WEIGHT × p50LatencyMs`, where the exported `LATENCY_TOTAL_WEIGHT` is 0.15 (tuned on a fully streamed offline sweep); without TTFT, total `p50LatencyMs` alone preserves legacy ordering.
- `estimatedRequestCostUsd` adds the configured `productionTokenProfile` prompt cost at catalog prices to `avgCostUsd`. Without a profile or pricing, it equals `avgCostUsd`.
- `wilson` is the Wilson lower bound (z = 1) of accuracy over the candidate's measured `cases`. A well-measured candidate beats a thinly measured one at equal accuracy. Without `cases`, raw accuracy is used.
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
Each model runs once without variant overrides (the provider default), and once
with its highest catalog-supported reasoning effort, when available. Full catalog
variant fragments are retained, including controls beyond reasoning.

The screen hashes case IDs with SHA-256 and takes the first N hashes per direct
route from the selected suite. Every candidate sees the same cases; selection is
stable when dataset order changes. Agentic routes require CLI execution and are
explicitly listed in `excludedRoutes`, never simulated by direct completions.
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

`--max-usd` includes both model and grader spend. Requests run sequentially and
budget is checked before each request and judge call, but one request can exceed
the remaining budget because its actual cost is only known after completion.
Missing model cost marks only that model `costUnknown: true`, excludes it from
recommendations, and stops sampling all its variants; other models continue.
Its reported prompt and completion token counts are charged at catalog prices
without cache discounts. `costUsd` includes these conservative estimates;
`estimatedCostUsd` identifies their contribution globally and per model.
If token counts are also unavailable, the remaining budget is reserved rather
than treating the request as free. A failed judge call still stops further
spending and sets `spendIncomplete`. Atomic checkpoints after each case retain
partial results if the screen is interrupted.

## Admin endpoints

All under `/admin`, gated by `Authorization: Bearer <INTERNAL_API_SECRET_PROD>`
(the gateway's admin panel proxies these with the internal secret):

| Endpoint | Purpose |
|---|---|
| `GET/PUT /admin/config` | Read / save benchmark config (model lists, thresholds, `benchmarkUserId`, optional `benchmarkOrgId`) |
| `GET /admin/runs` | List runs (sweeps stale `running` runs to `failed` first) |
| `POST /admin/runs` | Classifier: start a run (`{kind: 'classifier', force}`). Decider: reconcile + drain the registry queues (`{kind: 'decider', queue: 'platform' \| 'user' \| 'both'}`) |
| `GET /admin/registry` | Queue counts and exact platform entry statuses under the current engine identity and repetitions |
| `POST /admin/registry/requeue` | Put failed registry rows back to `pending` (`{scope}`); charges no owner quota |
| `GET /admin/routing-table` | Latest published **platform** routing table |
| `GET /admin/classifier-winner` | Current classifier winner |
| `POST /admin/debug-cli` | Run one ad-hoc prompt through the kilo CLI container (diagnostic) |
| `POST /admin/profiles/register` | Atomically admit missing/stale/retried global Benchmark profiles for an owner (quota 10/24h) |
| `POST /admin/profiles/status` | Current statuses for up to 10 exact Pool entries (may free-admit engine-drifted rows) |
| `POST /admin/custom-routing-table` | Assemble a **sparse** custom table for ready/current entries only (`table: null` → balanced fallback) |

## Owner pools and Benchmark profiles

Owners (personal users or organizations) can constrain `kilo-auto/efficient` to
1–10 exact `(model, canonical variant)` **Pool entries**. The pool itself lives
in the auto-routing Durable Object; this worker owns **global Benchmark
profiles** — per-route measurements for each exact pair under the current
benchmark engine identity and decider repetitions.

### The two registry queues

A registry row records who wants the measurement: `platform_requested` (the
saved decider list) and `user_requested` (owner pools). Both can be set — the
row is global, so the pair is benchmarked once and serves both.

| | Platform queue | User queue |
|---|---|---|
| Filled by | `syncPlatformRegistry` expands the saved models from the current catalog on config save, daily sync, and platform drain | `POST /admin/profiles/register` from owner pools (quota-charged) |
| Trigger | Admin `POST /admin/runs`, daily cron, any decider terminal state | Admin `POST /admin/runs`, 15-minute cron, any decider terminal state |
| `benchmark_runs.purpose` | `platform` | `user` |
| Container budget | `maxConcurrency` | `userMaxConcurrency` |
| Slot | Its own; a running user-queue run never blocks it | Its own; a running platform-queue run never blocks it |

The two budgets must sum to at most `BENCHMARK_CONTAINER_BUDGET` (200, the
wrangler `max_instances`); the config contract rejects a larger pair.

After any decider run completes, the worker assembles the platform table from ready, current registry entries for the current catalog pairs.
If a desired pair remains pending or running, the previous table stays live.
Failed pairs do not contribute scores.
If any taxonomy route has no measured candidate, the worker skips publication and keeps the previous table.

Rollback: turning off owner pools (or clearing a pool) leaves the platform table
untouched — it only ever draws on rows the platform list asks for.

### Request ledger and admission

`POST /admin/profiles/register` evaluates every submitted entry in one D1 batch:

- Ready/current or already pending/running global profiles are reported without
  charging quota.
- Globally new, engine-stale, or explicitly retried-failed profiles are admitted
  as `pending` while the owner has fewer than **10** charged admissions in the
  rolling 24h window (`profile_request_events`). Over-limit → 429, nothing written.
- Concurrent owners requesting the same exact pair + engine identity dedupe to
  one global row.

Admission is all-or-nothing and returns before the caller's Durable Object
settings write. If that later write fails, the owner's previous pool is kept,
admitted profiles stay pending globally, the single-slot drain still runs them,
and a later retry reports them without re-charging quota.

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
exact variant match the live decider engine. Stale rows are never returned as
Ready or assembled into custom tables.

**Per-queue drain** (after any decider terminal state, on the admin's manual
trigger, and on the 15-minute cron):

1. If that queue's run is already active → log and leave its pending rows alone.
   The other queue is unaffected.
2. Else take that queue's pending current-engine rows oldest-`requested_at`-first,
   capped by its own container budget (`entries × repetitions ≤ budget`).
3. `startRun(purpose: queue, entries: snapshot)`.

A row wanted by both queues appears in both listings; whichever run claims it
first flips it to `running`, so it is still measured exactly once.

**Scheduled handlers:**

- `*/15 * * * *` — sweep stale runs, then drain both queues.
- `0 5 * * *` — sweep, refresh auto-decider candidates, reconcile the platform
  queue with the resulting decider list, drain both queues, republish the
  platform table (so a *removed* model leaves the live table even when nothing
  new needed measuring).

Long waits stay `Benchmarking` in the UI; there is no second timeout state in v1.

### Sparse custom routing tables

`POST /admin/custom-routing-table` with 1–10 entries returns
`CustomRoutingTableResponse`:

- Candidates come only from **ready + current** profiles' provenance
  `model_summaries` for that entry's exact pair **and** measuring `run_id`
  (no cross-run leakage), ranked with the saved policy knobs via
  `rankCandidates`.
- Candidates carry exact `variant` (never `reasoningEffort`).
- Route keys with no graded candidates are **omitted** (not empty arrays).
- If no requested entry is ready/current → `{ table: null }` so the gateway
  falls back to balanced. Never fabricate candidates.

## Local development

The worker is part of the dev runner. From the repo root:

```bash
pnpm dev:start auto-routing
```

This brings up the auto-routing worker (:8810), this worker (:8814), and the
Next.js gateway (:3000). Logs land in `dev/logs/*.log`; the tmux session is
`kilo-dev-<worktree>`.

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
(`wrangler d1 migrations apply auto-routing-benchmark --remote`).

Inspect local D1 by copying the sqlite out (direct reads often hit miniflare
locks):

```bash
cp .wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite* /tmp/
sqlite3 /tmp/<file>.sqlite 'select id, kind, status from benchmark_runs;'
```

## Debugging container (decider) failures

- Each decider run seeds bounded shard lanes across the configured models and
  repetitions. A lane uses one stable container instance
  (`runId:model:rep:shard`) and processes chunk `N`, then `N+shardCount`, and
  so on. CLI runs are serialized per instance because its sqlite state is not
  safe under concurrent first runs. A `/warmup` call absorbs the one-time sqlite
  migration before the case loop.
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

Failed queue messages land in `auto-routing-benchmark-dlq` after `max_retries`
(6) on `auto-routing-benchmark-jobs`. A decider message is one
(model, repetition, shard, chunk) job, and later chunks are chained from it —
so a DLQ'd message kills its lane's remaining cases.

The worker consumes the DLQ itself: each dead message is recorded in
`run_lane_failures`, and run finalization is lane-aware. A run completes once
every (model, variant, rep) lane has either all its case rows or a recorded
lane death — a single dead model can no longer wedge the whole run.

- **Decider runs of either queue** complete per-entry: entries whose lanes all
  finished go `ready`; entries with a dead lane go `failed` ("Benchmark lane did
  not finish…"). A requeue re-admits them — the owner's Retry (quota-charged) or
  the admin's `POST /admin/registry/requeue` (free). One failing model never
  discards the results of the others, which matters because each one cost real
  money to produce.
- **Classifier runs** still fail fast on a dead lane: their models are not
  registry-tracked and the winner must come from one comparable set.
- **Backstop**: the 6h stale sweep *salvages* a wedged decider run rather than
  failing it wholesale — lanes with a full set of case rows are settled `ready`,
  and only the unfinished lanes' entries go `failed`.

To inspect:

- **Prod**: Cloudflare dashboard (Workers → Queues →
  `auto-routing-benchmark-dlq`); the message body is the JSON job (`runId`,
  `model`, `rep`, `shard`, `chunk`, case ids). Recorded lane deaths are
  queryable: `SELECT * FROM run_lane_failures WHERE run_id = '…'`.
- **Replay**: failed entries re-admit via the owner's Retry or the admin's
  requeue endpoint, and the next drain of their queue measures them. Entries that
  are already `ready` are never re-measured.

## Commands

```bash
pnpm dev          # wrangler dev (port 8814)
pnpm typecheck    # tsgo --noEmit
pnpm lint
pnpm test         # vitest run
pnpm db:generate  # regenerate D1 migration from src/db-schema.ts
```
