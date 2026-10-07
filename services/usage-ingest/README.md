# Usage ingest

Authenticated `POST /usage` validates the existing usage request contract and
publishes it to `USAGE_INGEST_QUEUE`, preserving the supplied usage ID. A 202 means
queue acceptance after `send` resolves, not consumer completion. The same Worker
consumes shadow events, logs a safe receipt, then acknowledges each message.
Acknowledged events are removed from the queue: this is not durable recovery
storage or a billing consumer. Current direct usage writes remain authoritative;
this Worker does not record usage, deduct credits, or call Vercel. The consumer has
no mode flag: it always logs and acknowledges messages. The gateway's shadow
setting controls sending only. Before authoritative queue processing, replace
receipt-only handling with successful usage persistence before acknowledgement.

Receipts contain only the validated usage ID, queue message ID, delivery attempt
count, and non-negative event age in milliseconds. Malformed messages log an
`invalid` receipt without body/schema details and are acknowledged and discarded.
Acknowledgement follows a successful console call; it does not prove durable log
storage. If validation or logging throws,
the handler fails; already acknowledged messages stay acknowledged, while failed
and later messages use the queue's default bounded retries (three retries, then
discard without a DLQ). Logs can repeat on redelivery. This stage provides neither
deduplication nor reconciliation.

The wire schema comes from `@kilocode/usage-contracts` through its package export.
That package depends only on Zod at runtime; the Worker does not depend on
web-shared or database packages.

Send `Authorization: Bearer <USAGE_INGEST_PUBLISH_SECRET>`. Authentication runs
before body reads; a missing/empty configured secret returns 503, and missing/wrong
auth returns 401. Invalid JSON/schema returns 400, requests or serialized events
over 120,000 bytes return 413, and enqueue failure returns a generic 503.
Unrelated paths return 404; other methods on `/usage` return 405.

| Environment | Worker | Producer and receipt consumer queue |
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
deployments reuse the existing queue. The same Worker is registered as its consumer
in each environment, using default batch and retry settings.

Deploy and verify receipt consumption before enabling the gateway's default-off
shadow publisher. Deploying this consumer can drain an existing backlog, including
discarding malformed messages. Keep current direct usage writes enabled. Local
synthetic proof does not confirm hosted delivery; no rollout is performed here.

To deploy directly from the repository root with Wrangler authenticated to the
account in `wrangler.jsonc`:

```bash
# Staging
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --env staging

# Production
pnpm --filter cloudflare-usage-ingest exec wrangler deploy
```

Staging enables its public `workers.dev` URL. After deployment, append `/usage`
to the hostname shown for `usage-ingest-staging` and use that as the gateway's
`USAGE_INGEST_URL`. Requests require the dedicated publisher secret above.
Production keeps `workers_dev: false`; no custom routes or preview URLs are
configured. These settings do not prevent deployment. This configuration attaches
the receipt consumer to each environment's producer queue. Publishing and receipt
handling require no database access. See
[Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

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
The queue is simulated locally and delivered to the shipped `queue()` handler in
the same Worker. Runtime tests load the actual configured entry for production
and staging, send synthetic HTTP events, and observe receipts and queue drainage.
Keep tokens and payloads out of logs. Before a future remote rollout,
configure a reachable URL and separate dedicated publisher secrets for production
and staging. The staging `workers.dev` URL is enabled on deployment; production
public URLs and all preview URLs remain disabled.
