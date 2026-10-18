# Usage ingest

Authenticated `POST /usage` validates the existing usage request contract and
publishes it to `USAGE_INGEST_QUEUE`, preserving the supplied usage ID. A 202 means
queue acceptance after `send` resolves, not consumer completion. The same Worker
consumes shadow events as receipts by default, or writes them through the existing
Frankfurt writer in opt-in processing mode.
Acknowledged events are removed from the queue. Current direct usage writes remain
authoritative. The gateway's shadow setting controls sending only;
`USAGE_INGEST_MODE` selects consumer behavior.

In receipt mode, receipts contain only the validated usage ID, queue message ID, delivery attempt
count, and non-negative event age in milliseconds. Malformed messages log an
`invalid` receipt without body/schema details and are acknowledged and discarded.
Acknowledgement follows a successful console call. If validation or logging throws,
unacknowledged messages use three retries with a 60-second retry delay, then move
to the environment's dead-letter queue (DLQ). Logs can repeat on redelivery. The DLQ only
receives exhausted failures: malformed events that were acknowledged do not reach
it.

The wire schema comes from `@kilocode/usage-contracts` through its package export.
That package depends only on Zod at runtime; the Worker does not depend on
web-shared or database modules in its bundle.

Send `Authorization: Bearer <USAGE_INGEST_PUBLISH_SECRET>`. Authentication runs
before body reads; a missing/empty configured secret returns 503, and missing/wrong
auth returns 401. Invalid JSON/schema returns 400, requests or serialized events
over 120,000 bytes return 413, and enqueue failure returns a generic 503.
Unrelated paths return 404; other methods on `/usage` return 405.

| Environment | Worker | Producer and consumer queue | DLQ (no consumer) |
|---|---|---|---|
| Production (top-level config) | `usage-ingest` | `usage-ingest-processing` | `usage-ingest-processing-dlq` |
| Staging (`env.staging`) | `usage-ingest-staging` | `usage-ingest-processing-staging` | `usage-ingest-processing-dlq-staging` |

## Processing mode

`USAGE_INGEST_MODE` is `receipt` in both committed environments. An absent mode also
uses receipt behavior. Set it to `processing` to validate and write events
sequentially, preserving the supplied usage ID and validated fields.

Processing uses `@kilocode/worker-utils/usage-writer-client` for the existing
Frankfurt `/api/internal/usage/record` endpoint. Only a matching `recorded` or
`duplicate` acknowledgement removes an event. Invalid events, missing writer
configuration, unknown modes, and unavailable writes retry under the queue policy,
then reach the DLQ. Processing logs contain the usage ID when valid, queue message
ID, delivery attempt count, and categorical outcome/reason.

| Processing configuration | Value |
|---|---|
| `USAGE_WRITER_URL` | Full Frankfurt writer URL ending in `/api/internal/usage/record` |
| `USAGE_WRITER_SECRET` | Writer's existing `INTERNAL_API_SECRET`, sent as `x-internal-api-key` |
| `USAGE_WRITER_PROTECTION_BYPASS` | Optional Vercel automation bypass secret |

At activation, commit `USAGE_WRITER_URL` in the target environment’s `vars` or store
it as a Worker secret; store the writer credential and bypass as Worker secrets.

The writer secret is separate from `USAGE_INGEST_PUBLISH_SECRET`. Configure writer
secrets with `wrangler secret put <name>` (add `--env staging` for staging), or use
the service's ignored `.dev.vars` locally. Writer settings are optional in receipt
mode.

The shared helper makes one attempt with a 160-second timeout. HTTP 200
`not_recorded`, malformed or mismatched acknowledgements, redirects, and transport
failures are unavailable outcomes. Responses are limited to 4 KiB; helper logs
contain only the usage ID and categorical outcome or HTTP status.

## Queue policy

Both environments use the same consumer settings:

| Consumer setting | Value | Purpose |
|---|---|---|
| `max_batch_size` | `1` | One message per invocation. |
| `max_batch_timeout` | `0` seconds | No intentional wait to fill a batch. |
| `max_concurrency` | `1` | One active consumer invocation per environment's source queue. |
| `max_retries` | `3` | Initial delivery plus up to three retries. |
| `retry_delay` | `60` seconds | Space failed deliveries by one minute rather than retrying immediately. |
| `dead_letter_queue` | Environment-specific name above | Retain exhausted failures separately from the source queue. |

## Deploy

The existing `.github/workflows/deploy-workers.yml` discovers this service for
production and staging deployments. To deploy it individually, dispatch that
workflow with `worker: services/usage-ingest` and `target_environment: production`
or `staging`.

Wrangler automatically provisions missing configured producer queues and reuses
existing queues. `USAGE_INGEST_QUEUE` binds the source queue; `USAGE_INGEST_DLQ` is
an unused producer binding so Wrangler also provisions the DLQ. The consumer's
`dead_letter_queue` routes exhausted failures to it. No consumer is attached to
either DLQ.

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
configured. The consumer is attached to each environment's producer queue.
Publishing and receipt handling require no database access. See
[Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

## Retention

The retention target is **four days (345600 seconds)** for each source queue and
DLQ. Retention is managed separately from `wrangler.jsonc`; the pinned Wrangler
schema does not expose it. Update a queue using its name from the table above:

```bash
pnpm --filter cloudflare-usage-ingest exec wrangler queues update <queue-name> --message-retention-period-secs 345600
```

See [queue settings](https://developers.cloudflare.com/queues/configuration/configure-queues/).

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

The dry runs build and show bindings without creating queues or deploying a Worker.

For local HTTP testing, put a synthetic `USAGE_INGEST_PUBLISH_SECRET` in this
service's ignored `.dev.vars`, then run `pnpm --filter cloudflare-usage-ingest dev`.
The queue is simulated locally and delivered to the shipped `queue()` handler in
the same Worker. Runtime tests cover HTTP publishing, receipt consumption, and opt-in processing
in both environments.
