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
- Owner pools use the same model-level selection and all-efforts expansion.

Each pair uses its own CLI variant, results, cost, latency, and registry provenance.
The worker drains expanded entries in batches that fit the configured container budget.
New routing tables rank exact pairs and emit `variant`, not `reasoningEffort`.
Legacy nullable variant columns remain. Owner billing adds D1 admission/claim
tables and a Postgres hold ledger; apply both database migrations before
deploying the corresponding Workers and web bridge.

The admin panel shows measured coverage and pending, running, or failed efforts per model.
Each route starts collapsed with its first-ranked pair, accuracy, and cost.
Expand a route to inspect every ranked model/effort pair.

## Ranking

- `rankCandidates` (`@kilocode/auto-routing-contracts`) orders every route's candidates.
- A candidate competes when its accuracy is at most 0.05 below `minAccuracy`, the benchmark noise band.
- Competing candidates are ordered by `avgCostUsd × p50LatencyMs^1.5 / accuracy^15`, lowest first.
- The other candidates follow by accuracy, then cost.
- `meetsThreshold` stays strict (`accuracy >= minAccuracy`) for sticky routing.
- The ranking policy version is part of every registry table version, so a policy change republishes.


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
| `POST /admin/profiles/estimate` | Quote uncached measurements for all current catalog efforts of the selected pool models |
| `POST /admin/profiles/register` | Hold owner credits, then admit missing/stale/retried profiles (quota 10 models/24h) |
| `POST /admin/profiles/status` | Read current per-effort coverage and owner-scoped charges without admitting work |
| `POST /admin/custom-routing-table` | Rank ready/current exact pairs for the selected models (`table: null` → balanced fallback) |

## Owner pools and Benchmark profiles

Owners (personal users or organizations) can constrain `kilo-auto/efficient` to
1–10 **pool models**. The pool lives in the auto-routing Durable Object, whose
read path collapses and deduplicates legacy exact-pair pools. Each selected model
expands through the live catalog into every supported reasoning effort, or one
default pair when there are no reasoning controls. This worker measures exact
model-effort pairs globally under the current engine identity and repetitions.
Custom tables rank every measured pair; the router, not the owner, chooses effort.

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

Before saving, the owner UI requests a quote and displays model effort coverage
and charges. The quote is advisory: admission recomputes which pairs need work.
Already ready/current or pending/running pairs cost nothing to another owner.

For each pair needing measurement, the estimate is case count × repetitions ×
historical average case cost for that model. Without history, catalog token prices
use a conservative per-case allowance of 100,000 input tokens, 50,000 output
tokens, and 32 requests. Missing usable prices and measurements reject admission.

`POST /admin/profiles/register` claims each pair durably before reserving credits
through the authenticated web billing bridge. Organization pools use organization
credits; personal pools use user credits. Insufficient balance returns 402 before
any claimed pair becomes runnable. The rolling quota counts models, not efforts;
engine-stale remeasurement remains quota-free but still requires owner credits.
Concurrent requests share one global pair: the first successful claim pays, while
other owners reuse the paid profile for free. An allocating claim returns 409
rather than exposing unpaid work as a cached measurement.

Postgres holds debit the existing acquired-credit ledger atomically with the
payer lock. Settlement reverses the hold and records actual benchmark usage in
the payer's used-credit counter; settled holds supply that usage to balance
recomputation so expiring credits cannot double-charge it. Settlement is
idempotent per admission, owner and exact pair, bound to the measuring run.
Successful pairs charge the sum of their measured case costs and release the
held remainder; failed pairs release their entire hold,
including partial failed-lane measurements. Actual cost exceeding the estimate
is charged in full. D1 admission and settlement records retain retryable work;
scheduled recovery reconciles interrupted credit calls and terminal runs.

Admission returns before the caller's Durable Object settings write. If that
write fails, the previous pool remains, but authorized measurements still run.
Retrying uses the same global profiles without charging credits or quota twice.

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
