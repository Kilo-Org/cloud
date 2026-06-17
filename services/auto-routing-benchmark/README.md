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
| `GET/PUT /admin/config` | Read / save benchmark config (model lists, thresholds, `benchmarkUserId`) |
| `GET /admin/runs` | List runs (sweeps stale `running` runs to `failed` first) |
| `POST /admin/runs` | Start a run (`{kind, force}`); returns 409 if one of that kind is already running |
| `GET /admin/routing-table` | Latest published routing table |
| `GET /admin/classifier-winner` | Current classifier winner |
| `POST /admin/debug-cli` | Run one ad-hoc prompt through the kilo CLI container (diagnostic) |

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

Decider runs need a `benchmarkUserId` that exists locally with credits — the dev
seed provides `auto-routing-cli-local`.

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
