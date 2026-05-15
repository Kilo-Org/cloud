# Model Eval Ingest Worker

Cloudflare Worker that pulls promoted eval aggregates from the kilo-bench dashboard WorkerEntrypoint, stores append-only cloud audit rows, and recomputes public `model_stats.benchmarks.kiloBench` caches.

## Architecture

- Scheduled Worker syncs promotions from the kilo-bench dashboard Service Binding.
- Admin-triggered syncs call `POST /internal/sync` over HTTP from `apps/web`.
- The HTTP admin path uses the shared `INTERNAL_API_SECRET`; the Worker-to-bench hop uses only the Service Binding.
- Promotion rows are idempotent by `bench_eval_name`.

## Local Development

### 1. Configure the shared manual-sync secret

The local Worker uses Wrangler `.dev.vars`, matching the pattern used by other Workers in this repo.

```bash
cd services/model-eval-ingest
cp .dev.vars.example .dev.vars
```

Set `INTERNAL_API_SECRET` in `.dev.vars` to the same value as repo-root `.env.local`:

```env
# services/model-eval-ingest/.dev.vars
INTERNAL_API_SECRET=<same value as .env.local INTERNAL_API_SECRET>
```

The web app also needs the local Worker URL in repo-root `.env.local`:

```env
MODEL_EVAL_INGEST_URL=http://localhost:8798
```

Example templates are kept in:

- `.env.local.example`
- `apps/web/.env.development.local.example`
- `services/model-eval-ingest/.dev.vars.example`

### 2. Start kilo-bench dashboard locally

The Service Binding target must be running from the sibling `../kilo-bench` checkout with its `dev` Wrangler environment name.

```bash
cd ../kilo-bench/dashboard
pnpm build
pnpm db:migrate:local
pnpm dev
```

The dashboard Worker serves `http://localhost:8811` and exposes the `Dashboard` WorkerEntrypoint used by this service.

### 3. Start model-eval-ingest locally

```bash
cd services/model-eval-ingest
pnpm dev
```

Wrangler serves the Worker at `http://localhost:8798` by default.

### 4. Restart Next.js after env changes

If `.env.local` was updated after Next.js was already running, restart it so the admin sync client sees `MODEL_EVAL_INGEST_URL`:

```bash
pnpm dev:restart nextjs
```

## Manual Verification

### Health check

```bash
curl http://localhost:8798/health
```

### Trigger a direct sync

```bash
curl -X POST http://localhost:8798/internal/sync \
  -H "content-type: application/json" \
  -H "x-internal-api-key: $INTERNAL_API_SECRET" \
  -d '{}'
```

### Admin UI

Open:

```text
http://localhost:3000/admin/model-eval-ingest
```

Use `Sync now` for a full pull or `Repull` for a single named promotion already visible in the ingest history.

## Deployment Configuration

Production/dev deployments need:

- Worker Secrets Store binding for `INTERNAL_API_SECRET`.
- Web/Vercel `INTERNAL_API_SECRET` with the same value.
- Web/Vercel `MODEL_EVAL_INGEST_URL` pointing at the deployed Worker URL.
- Cloudflare Service Binding `BENCH_DASHBOARD` targeting the kilo-bench dashboard WorkerEntrypoint.
