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
  `kilo` CLI inside a Cloudflare Container, grades mechanically, and publishes a
  per-taxonomy-route routing table.
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
| `POST /admin/runs` | Start a **platform** run (`{kind, force}`); returns 409 if one of that kind is already running |
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

### Profile purpose runs vs platform runs

| | Platform run | Profile run |
|---|---|---|
| Trigger | Admin `POST /admin/runs`, scheduled auto-decider sync | Single-slot drain of pending registry rows |
| `benchmark_runs.purpose` | `platform` (default) | `profile` |
| Model set | Saved admin config | Explicit entry snapshot from pending profiles |
| On completion | Publishes platform routing table / classifier winner; clears platform KV keys | Marks claimed profiles `ready` (or `failed`); **never** replaces the platform artifact |
| Slot | Shares the one-active-decider constraint | Same single slot; never preempts a platform run |

Rollback: turning off owner pools (or clearing a pool) leaves the platform
default table untouched — profile runs never wrote it.

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

- **running**: set when a profile run claims the entries at `startRun`.
- **ready**: set when that profile run completes successfully (`run_id`
  provenance points at the measuring run).
- **failed**: set when the run fails (enqueue, timeout sweep, etc.). Only rows
  still pointing at that `run_id` transition — a newer pending/ready row is
  never clobbered.

Currency: a profile is current only when `engine_identity`, `repetitions`, and
exact variant match the live decider engine. Stale rows are never returned as
Ready or assembled into custom tables.

**Single-slot drain** (after any decider terminal state — completion *or*
failure — and when the scheduled handler has no platform start to claim):

1. If a decider run is already active → log and leave pending rows alone.
2. Else take pending current-engine rows oldest-`requested_at`-first, capped by
   the existing container budget (`entries × repetitions ≤ maxConcurrency`).
3. `startRun(purpose: 'profile', entries: snapshot)`.

**Scheduled auto-decider sync ordering** (platform priority on a free slot):

1. Sweep stale runs (cleanup only — not a slot claim).
2. Sync auto-decider candidates from the web API.
3. If models changed **and** a config exists → platform `startRun` claims the
   free slot; **no** pending-profile drain this cycle (terminal transition
   drains later). Profile work never preempts platform start.
4. If no platform start (no change, or no config) → drain pending profiles now
   so stranded work recovers.
5. If the slot is already occupied → log/skip; leave pending rows untouched.

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

## Debugging the DLQ

Failed queue messages land in `auto-routing-benchmark-dlq` after `max_retries`
(6) on `auto-routing-benchmark-jobs`. A decider message is one
(model, repetition, shard, chunk) job, so a DLQ'd message means that chunk never
produced results; its model's summaries for the affected route(s) will be
missing or incomplete and `finalizeRunIfComplete` will mark the run accordingly.

To inspect / handle:

- **Prod**: read the DLQ from the Cloudflare dashboard (Workers → Queues →
  `auto-routing-benchmark-dlq`) or `wrangler queues` tooling; the message body is
  the JSON job (`runId`, `model`, `rep`, `shard`, `shardCount`, `chunk`, case ids).
- **Replay**: re-run the affected model with the admin `force` toggle once the
  underlying cause (OpenRouter outage, container image, bad case) is fixed —
  carried summaries mean only the re-triggered model is re-benchmarked.
- **Declare failed**: a run with a wedged/dead `running` row is swept to `failed`
  on the next `GET /admin/runs`, freeing the one-active-run-per-kind slot.

## Commands

```bash
pnpm dev          # wrangler dev (port 8814)
pnpm typecheck    # tsgo --noEmit
pnpm lint
pnpm test         # vitest run
pnpm db:generate  # regenerate D1 migration from src/db-schema.ts
```
