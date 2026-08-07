# auto-routing-benchmark

Cloudflare Worker that benchmarks candidate models and publishes the artifacts
that drive `kilo-auto/efficient` routing. It is the **sole writer** of the
routing table and classifier winner; `services/auto-routing` and the `apps/web`
gateway only read them. See `docs/adr/0002-auto-routing-efficient.md` for the
design, invariants, and rollout/rollback.

## What it does

- **Classifier benchmark** — replays 72 normalized classifier inputs through
  OpenRouter using the exact production classifier code
  (`@kilocode/auto-routing-contracts/classifier`), grades per-field, and derives
  the cheapest above-threshold model as the classifier winner.
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

## Admin endpoints

All under `/admin`, gated by `Authorization: Bearer <INTERNAL_API_SECRET_PROD>`
(the gateway's admin panel proxies these with the internal secret):

| Endpoint | Purpose |
|---|---|
| `GET/PUT /admin/config` | Read / save benchmark config (model lists, thresholds, `benchmarkUserId`, optional `benchmarkOrgId`) |
| `GET /admin/runs` | List runs (sweeps stale `running` runs to `failed` first) |
| `POST /admin/runs` | Classifier: start a run (`{kind: 'classifier', force}`). Decider: reconcile + drain the registry queues (`{kind: 'decider', queue: 'platform' \| 'user' \| 'both'}`) |
| `GET /admin/registry` | Registry row counts per queue under the live engine identity |
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
| Filled by | `syncPlatformRegistry` from the saved decider list (config save + daily cron) | `POST /admin/profiles/register` from owner pools (quota-charged) |
| Trigger | Admin `POST /admin/runs`, daily cron, any decider terminal state | Admin `POST /admin/runs`, 15-minute cron, any decider terminal state |
| `benchmark_runs.purpose` | `platform` | `user` |
| Container budget | `maxConcurrency` | `userMaxConcurrency` |
| Slot | Its own; a running user-queue run never blocks it | Its own; a running platform-queue run never blocks it |

The two budgets must sum to at most `BENCHMARK_CONTAINER_BUDGET` (200, the
wrangler `max_instances`); the config contract rejects a larger pair.

Neither queue publishes anything itself. After any decider run completes, the
platform routing table is reassembled from ready+current registry rows for the
configured decider list. Publishing is skipped (previous table stays live) when
the registry cannot yet fill every taxonomy route.

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
