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

Production commits `USAGE_INGEST_MODE=receipt`; staging commits `processing` with
`https://staging-app.kilo.ai/api/internal/usage/record` as its Frankfurt writer URL.
An absent mode also uses receipt behavior. Processing validates and writes events
sequentially within each consumer invocation, preserving the supplied usage ID
and validated fields. Concurrent invocations are capped by each environment's
`max_concurrency` setting in the queue policy below.

Processing uses `@kilocode/worker-utils/usage-writer-client` for the existing
Frankfurt `/api/internal/usage/record` endpoint. Only a matching `recorded` or
`duplicate` acknowledgement removes an event. Invalid events, missing writer
configuration, unknown modes, and unavailable writes retry under the queue policy,
then reach the DLQ. Processing logs contain the usage ID when valid, queue message
ID, delivery attempt count, and categorical outcome/reason.

Both `usage_ingest_receipt` and `usage_ingest_processing` include an explicit
`level` and `queue_action` (`ack` or `retry`). Receipts (including discarded invalid
bodies) and recorded/duplicate processing outcomes use `console.info`; retryable
processing outcomes use `console.warn`. The action describes the next queue call,
not confirmed DLQ storage or a billing write for a receipt.

Processing `writer_duration_ms` is the rounded monotonic elapsed time around the
awaited writer attempt, including HTTP response validation. It is omitted for
invalid modes, invalid events, and missing writer configuration, where no write
is attempted. `event_age_ms` is the non-negative age of validated `core.created_at`
at the outcome log, including writer wait in processing mode; it is omitted for
invalid events. Clock skew is clamped to zero. No bodies, prompts, credentials,
writer URLs, or exception details are included in these logs.

Processing also logs `queue_wait_ms` from the queue message timestamp to the start
of handling that message, independently of writer duration. Shared direct and
HTTP-writer persistence attempts emit `usage_record_completion` logs with
outcome, duration, event age, execution region and finite caller context. See the
completion sampling policy below and the
[staging load-test comparison guide](load-test.md) for field definitions, toggle
settings, comparable aggregates and read-only database snapshots.

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

## Observability

`usage_record_completion` is a persistence event for lasting
diagnosis and log-derived counts/latency. `entrypoint` is `gateway`,
`writer_endpoint`, or `unknown`; `writer_caller` is `queue`, `region_handoff`, or
`unknown`. These finite fields separate concurrent paths:

| Persistence path | `entrypoint` | `writer_caller` |
|---|---|---|
| Frankfurt gateway direct write or SFO local fallback | `gateway` | `unknown` |
| Queue consumer through HTTP writer | `writer_endpoint` | `queue` |
| SFO gateway handoff through HTTP writer | `writer_endpoint` | `region_handoff` |
| HTTP writer without a classified caller, including classifier/grader writes | `writer_endpoint` | `unknown` |
| Unclassified local caller | `unknown` | `unknown` |

The Queue consumer explicitly opts into `x-usage-write-source: queue`; the SFO
handoff client sets `region_handoff`. Other shared-client users, including the
classifier and benchmark grader, omit the marker. After internal API authentication,
the writer route accepts only `queue` or `region_handoff`; missing or other values
map to `unknown` without logging the raw header. This is caller-supplied diagnostic
context, not an authorization or accounting input. Older clients remain compatible.
`execution_region` identifies the persistence function's region when available:
SFO HTTP handoffs record `fra1`; a local fallback in SFO records `sfo1`.
Missing or unrecognized `VERCEL_REGION` values are reported as `unknown`.
With queue-only enabled, the gateway never calls a billing writer, including on
publication failure. It retries transient publication failures up to three total
attempts, with a fresh two-second timeout each and jittered 200–400 ms then
400–600 ms backoffs. Every attempt reuses the same serialized event and usage ID;
ambiguous acceptance can create duplicate messages, which the writer deduplicates.
Configuration failures and HTTP outcomes other than 408/429/5xx are not retried.
Redirects are terminal 3xx failures; their targets are never followed.
Shadow publication retains one attempt. `usage enqueue retrying` logs the usage
ID, categorical reason and failed attempt number before each retry. `usage accounting publication failed` logs the finalized
`usageId` and categorical `reason`; accounting returns null and emits no gateway
persistence completion. This is not durable recovery: unaccepted events may be
lost, and ambiguous failures may still be recorded later by the consumer. With
queue-only off, the existing SFO handoff-to-local fallback remains unchanged.

`duration_ms` covers the shared persistence call and its awaited follow-up work,
not pure SQL time. `event_age_ms` retains the original event timestamp across
replay/redrive, while `queue_wait_ms` uses the current queue message's send time
and includes redelivery delay. These fields do not classify replay origin. Use
first-delivery consumer samples for queue latency objectives; even those may carry
historical events, so event age is a freshness signal.

Completion logs use application sampling: staging records 100%; production
`recorded` and `duplicate` outcomes are sampled uniformly at 1%; `not_recorded`
and `error` outcomes always log. Every emitted completion includes `sample_rate`
(`1` or `0.01`). `VERCEL_ENV=production` takes precedence over a conflicting
staging target. Otherwise `VERCEL_TARGET_ENV=staging` or a nonproduction
`VERCEL_ENV` keeps full logging, even with `NODE_ENV=production`. Without that
deployment metadata, `NODE_ENV=production` uses production sampling; local/test
defaults keep full logging. Existing consumer outcome/receipt/retry logs remain
at 100%, and the existing slow-plus-1% phase diagnostics are unchanged.

Estimate completion attempt counts by outcome using `sum(1 / sample_rate)`;
this accounts only for application sampling, so additional platform sampling or
log loss must be handled separately. Production sampled IDs cannot establish
exact distinct-event completeness. Success latency samples are uniform within
each outcome/path/region; keep them separate from the slow-biased phase series.

Worker logs are available in Cloudflare through `observability.enabled`. This
service's configuration does not opt in to Workers Logpush or configure an
OpenTelemetry export destination; external export can be configured separately.
Each selected persistence attempt adds one completion line; IDs remain log
fields, not metric labels. Logs can be dropped, and are not durable accounting:
reconcile against persisted usage rows when exact completeness matters.

## Queue policy

Both environments use the following consumer settings:

| Consumer setting | Value | Purpose |
|---|---|---|
| `max_batch_size` | `1` | One message per invocation. |
| `max_batch_timeout` | `0` seconds | No intentional wait to fill a batch. |
| `max_concurrency` | Production: `1`; staging: `10` | Cap active consumer invocations per source queue; staging uses a larger cap for load testing. |
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
