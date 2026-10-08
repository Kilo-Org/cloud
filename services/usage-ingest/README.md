# Usage ingest

Authenticated `POST /usage` validates the existing usage request contract and
publishes it to `USAGE_INGEST_QUEUE`, preserving the supplied usage ID. A 202 means
queue acceptance after `send` resolves. Processing queued events requires a future
consumer; this publisher does not record usage or deduct credits. No consumer or
gateway integration is included.

The wire schema comes from `@kilocode/usage-contracts` through its package export.
That package depends only on Zod at runtime; the Worker does not depend on
web-shared or database packages.

Send `Authorization: Bearer <USAGE_INGEST_PUBLISH_SECRET>`. Authentication runs
before body reads; a missing/empty configured secret returns 503, and missing/wrong
auth returns 401. Invalid JSON/schema returns 400, requests or serialized events
over 120,000 bytes return 413, and enqueue failure returns a generic 503.
Unrelated paths return 404; other methods on `/usage` return 405.

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
without a consumer; publishing requires the dedicated secret above, with no database
access. See [Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

## Verify locally

From the repository root, use Node 24 and the pinned pnpm version:

```bash
pnpm install --frozen-lockfile
pnpm --filter cloudflare-usage-ingest types
pnpm --filter cloudflare-usage-ingest typecheck
pnpm --filter cloudflare-usage-ingest lint
pnpm --filter cloudflare-usage-ingest test
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --dry-run
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --dry-run --env staging
```

The dry runs build and show bindings without creating queues or deploying a
Worker. The compatibility date matches the repository's pinned workerd runtime.

For local HTTP testing, put a synthetic `USAGE_INGEST_PUBLISH_SECRET` in this
service's ignored `.dev.vars`, then run `pnpm --filter cloudflare-usage-ingest dev`.
The queue is simulated locally; receipt verification needs a temporary local
consumer. Keep tokens and payloads out of logs. Before a future remote rollout,
configure a reachable URL and separate dedicated publisher secrets for production
and staging. Public Workers and preview URLs remain disabled.
