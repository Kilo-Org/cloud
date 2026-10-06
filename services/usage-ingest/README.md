# Usage ingest

Queue-definition scaffold for future asynchronous usage processing. The Worker
returns HTTP 404 for every request. It does not publish messages or consume the
queue.

| Environment | Worker | `USAGE_INGEST_QUEUE` queue |
|---|---|---|
| Production (top-level config) | `usage-ingest` | `usage-ingest-processing` |
| Staging (`env.staging`) | `usage-ingest-staging` | `usage-ingest-processing-staging` |

## Deploy

The existing `.github/workflows/deploy-workers.yml` discovers this service for
production and staging deployments. To deploy it individually, dispatch that
workflow with `worker: services/usage-ingest` and `target_environment: production`
or `staging`.

Wrangler 4.135.0 automatically provisions the configured producer queue if it
does not already exist, then deploys the Worker with its `USAGE_INGEST_QUEUE` binding.
No dashboard setup or separate queue-create command is required. Subsequent
deployments reuse the existing queue.

To deploy directly from the repository root with Wrangler authenticated to the
account in `wrangler.jsonc`:

```bash
# Staging
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --env staging

# Production
pnpm --filter cloudflare-usage-ingest exec wrangler deploy
```

`workers_dev: false` disables the public Workers subdomain; it does not prevent
deployment. There are no routes or preview URLs configured. The queue can exist
without a consumer; this scaffold requires no application secrets or database
access. See [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

## Verify locally

From the repository root, use Node 24 and the pinned pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm --filter cloudflare-usage-ingest types
pnpm --filter cloudflare-usage-ingest typecheck
pnpm --filter cloudflare-usage-ingest lint
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --dry-run
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --dry-run --env staging
```

The dry runs build and show bindings without creating queues or deploying a
Worker. The compatibility date matches the repository's pinned workerd runtime.
