# Model Eval Ingest Worker

Cloudflare Worker that pulls promoted eval aggregates from the kilo-bench dashboard WorkerEntrypoint, stores append-only cloud audit rows, and recomputes public `model_stats.benchmarks.kiloBench` caches.

## Architecture

- Scheduled Worker syncs promotions from the kilo-bench dashboard Service Binding.
- Admin-triggered syncs call `POST /internal/sync` over HTTP from `apps/web`.
- The HTTP admin path uses the shared `INTERNAL_API_SECRET`; the Worker-to-bench hop uses only the Service Binding.
- Promotion rows are idempotent by `bench_eval_name`.

## Local Development

### 1. Sync local env files

From the cloud repo root, run:

```bash
pnpm dev:env
```

This repo-standard env sync reads `.env.local` plus the `.example` templates and writes:

- `services/model-eval-ingest/.dev.vars`, including `INTERNAL_API_SECRET` copied from `.env.local`
- `apps/web/.env.development.local`, including `MODEL_EVAL_INGEST_URL` generated from the local Worker port

The manual sync secret must match on both sides because `apps/web` calls the Worker's HTTP `/internal/sync` route. The Worker-to-bench hop remains a Service Binding and does not use this secret.

If `pnpm dev:env` is unavailable for some reason, the equivalent manual setup is:

```bash
cd services/model-eval-ingest
cp .dev.vars.example .dev.vars
```

```env
# services/model-eval-ingest/.dev.vars
INTERNAL_API_SECRET=<same value as repo-root .env.local INTERNAL_API_SECRET>
```

```env
# apps/web/.env.development.local
MODEL_EVAL_INGEST_URL=http://localhost:8798
```

Relevant templates are kept in:

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

If `pnpm dev:env` updated `apps/web/.env.development.local` after Next.js was already running, restart it so the admin sync client sees `MODEL_EVAL_INGEST_URL`:

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
