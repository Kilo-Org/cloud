# Usage ingest

Authenticated `POST /usage` validates the existing usage request contract and
publishes it to `USAGE_INGEST_QUEUE`, preserving the supplied usage ID. A 202 means
queue acceptance after `send` resolves, not consumer completion. The same Worker
always processes queued events through the existing Frankfurt writer. Only a
matching recorded/duplicate writer response permits ACK; invalid events and
missing writer configuration retry and can exhaust into the DLQ.

The gateway's `USAGE_QUEUE_ONLY_ENABLED` launch switch selects queued accounting
for staging or for the production regional cohorts controlled independently by
`USAGE_QUEUE_SFO_EXPOSURE` and `USAGE_QUEUE_FRA_EXPOSURE` (`0`–`1`, default `0`).
The optional `USAGE_QUEUE_SFO_USER_IDS` restricts only SFO. Configure the FRA
exposure on `kilocode-ai-gateway` Production and redeploy the gateway; this changes
accounting transport, not request routing.
Unselected events keep direct accounting or the existing SFO handoff. Background
shadow publication and its flag have been removed. Reconcile and drain historically
accepted shadow events before deploying processing; this change does not remove
old messages. Keep production selection off until the processing consumer is
independently verified. Selection being off does not stop processing of queued
events. Follow the [production merge gates](eu-queues.md#production-merge-gate).


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
| Production (top-level config) | `usage-ingest` | `usage-ingest-processing-eu` | `usage-ingest-processing-dlq-eu` |
| Staging (`env.staging`) | `usage-ingest-staging` | `usage-ingest-processing-staging-eu` | `usage-ingest-processing-dlq-staging-eu` |

Each environment connects only its EU pair. Production uses batch6/parallelism2/cap200 (up to 400 writer calls);
staging keeps one consumer capped at200, batch size2. Old global queues remain intact
for a paused/drained routing rollback. See [EU preparation and cutover](eu-queues.md).

## Processing

Production writes to `https://app.kilo.ai/api/internal/usage/record`; staging uses
`https://staging-app.kilo.ai/api/internal/usage/record`. Both use direct HTTP and
`USAGE_INGEST_PARALLELISM=2`: at most two concurrent writes per invocation. Absent
or unrecognized parallelism uses one slot; there is no receipt fallback.
Every slot settles before the invocation returns or rejects. Only the successful
message is ACKed; an unavailable/invalid message retries individually. Successful
ACKs survive peer failure. Concurrent invocations are bounded by the queue cap.

Processing uses `@kilocode/worker-utils/usage-writer-client` for the existing
Frankfurt `/api/internal/usage/record` endpoint. Only a matching `recorded` or
`duplicate` acknowledgement removes an event. Invalid events, missing writer
configuration and unavailable writes retry under the queue policy,
then reach the DLQ. Processing logs contain the usage ID when valid, queue message
ID, delivery attempt count, and categorical outcome/reason.

Writer HTTP 429 and 503 also reject the queue invocation after all messages in the
batch have been handled. Each successful message keeps its explicit ACK; failed
messages keep their explicit retry using the per-message delay policy below and the shared retry/DLQ budget.
There is no extra writer attempt within an invocation. Other failures retain
per-message retries without being classified as overload. Overload retry logs add
`writer_status` and `invocation_failure: "writer_overloaded"`.
An uncaught queue rejection supplies Cloudflare's invocation failure signal;
`retry()` alone does not. Autoscaling considers that signal alongside backlog and
the concurrency cap; no particular scale-down amount or timing is guaranteed.
See [consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/)
and [explicit ACK/retry behavior](https://developers.cloudflare.com/queues/configuration/batching-retries/).

`usage_ingest_processing` includes an explicit `level` and `queue_action` (`ack`
or `retry`). Recorded/duplicate outcomes use `console.info`; retries use
`console.warn`. The action describes the next queue call, not confirmed DLQ storage.

Processing `writer_duration_ms` is the rounded monotonic elapsed time around the
awaited writer attempt, including HTTP response validation. It is omitted for
invalid events and missing writer configuration, where no write
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
| `USAGE_INGEST_PARALLELISM` | `2` for two processing slots; all other or absent values use one |
| `USAGE_WRITER_URL` | Full Frankfurt writer URL ending in `/api/internal/usage/record` |
| `USAGE_WRITER_SECRET` | Writer's existing `INTERNAL_API_SECRET`, sent as `x-internal-api-key` |
| `USAGE_WRITER_PROTECTION_BYPASS` | Optional Vercel automation bypass secret |

At activation, commit `USAGE_WRITER_URL` in the target environment’s `vars` or store
it as a Worker secret; store the writer credential and bypass as Worker secrets.

The writer secret is separate from `USAGE_INGEST_PUBLISH_SECRET`. Configure writer
secrets with `wrangler secret put <name>` (add `--env staging` for staging), or use
the service's ignored `.dev.vars` locally. Writer credentials are required for
successful processing; missing configuration retries instead of discarding usage.

The shared helper makes one attempt with a 160-second timeout. HTTP 200
`not_recorded`, malformed or mismatched acknowledgements, redirects, and transport
failures are unavailable outcomes. Responses are limited to 4 KiB; helper logs
contain only the usage ID and categorical outcome or HTTP status.

## Observability

`usage_record_completion` is a persistence event for lasting
diagnosis and log-derived counts/latency. `entrypoint` is `gateway`,
`writer_endpoint`, or `unknown`; `writer_caller` is `queue`, `queue_vercel`,
`region_handoff`, or `unknown`. These finite fields separate concurrent paths:

| Persistence path | `entrypoint` | `writer_caller` |
|---|---|---|
| Frankfurt gateway direct write or SFO local fallback | `gateway` | `unknown` |
| Queue consumer through HTTP writer | `writer_endpoint` | `queue` |
| Staging Vercel queue consumer through HTTP writer | `writer_endpoint` | `queue_vercel` |
| SFO gateway handoff through HTTP writer | `writer_endpoint` | `region_handoff` |
| HTTP writer without a classified caller, including classifier/grader writes | `writer_endpoint` | `unknown` |
| Unclassified local caller | `unknown` | `unknown` |

The Queue consumer explicitly opts into `x-usage-write-source: queue`; the SFO
handoff client sets `region_handoff`. Other shared-client users, including the
classifier and benchmark grader, omit the marker. After internal API authentication,
the writer route accepts only `queue`, `queue_vercel`, or `region_handoff`; missing
or other values map to `unknown` without logging the raw header. This is caller-supplied diagnostic
context, not an authorization or accounting input. Older clients remain compatible.
See the [Vercel queue prototype runbook](../../packages/usage-queue/README.md) for
the isolated staging transport and its `queue_vercel` caller label.
`execution_region` identifies the persistence function's region when available:
SFO HTTP handoffs record `fra1`; a local fallback in SFO records `sfo1`.
Missing or unrecognized `VERCEL_REGION` values are reported as `unknown`.
After attempting queue publication, the gateway never falls back to a billing
writer. Existing direct fallbacks for missing publisher configuration or failed
lifetime registration remain safe because no publication was attempted. The Cloudflare HTTP publisher retries transient failures up to four total
attempts, with up to five seconds for each confirmation and a 25-second overall
elapsed retry budget. Before retries it uses exponential full jitter: uniformly
zero up to (excluding) 500 ms, 1,000 ms, then 2,000 ms. Attempt timeouts and sleeps
are clipped to remaining budget; no new attempt starts after exhaustion. Runtime
scheduling can delay observation of these deadlines. Non-retry calls retain one
two-second attempt; the separate Vercel queue transport is unchanged. Every attempt
reuses the same serialized event and usage ID;
ambiguous acceptance can create duplicate messages, which the writer deduplicates.
Configuration failures and HTTP outcomes other than 408/429/5xx are not retried.
Redirects are terminal 3xx failures; their targets are never followed.
`usage enqueue retrying` logs the usage
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
`recorded` and `duplicate` outcomes log at 100% by default. Set the
server-only `USAGE_RECORD_COMPLETION_SAMPLE_RATE` to a probability from `0` to `1`
and redeploy to change production success sampling (`0.01` for 1%, `0.1` for 10%, `1` for 100%,
`0` to disable success completion logs). Unset, blank, malformed or out-of-range
values fall back to `1`. Set it consistently on the gateway and HTTP writer
apps for comparable samples. `not_recorded` and `error` outcomes always log.
Every emitted completion includes its actual `sample_rate`.
`VERCEL_ENV=production` takes precedence over a conflicting
staging target. Otherwise `VERCEL_TARGET_ENV=staging` or a nonproduction
`VERCEL_ENV` keeps full logging, even with `NODE_ENV=production`. Without that
deployment metadata, `NODE_ENV=production` uses production sampling; local/test
defaults keep full logging. Existing consumer outcome/retry logs remain
at 100%, and the existing slow-plus-1% phase diagnostics are unchanged.

With a nonzero sampling rate, estimate completion attempt counts by outcome using
`sum(1 / sample_rate)`; this accounts only for application sampling, so additional platform sampling or
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

Production uses batch size 6 and staging keeps batch size 2. Both allow at most
two writer slots per invocation:

| Consumer setting | Value | Purpose |
|---|---|---|
| `max_batch_size` | `6` in production, `2` in staging | Maximum messages delivered per invocation. |
| `max_batch_timeout` | `0` seconds | No intentional wait to fill a batch. |
| `max_concurrency` | `200` in both environments | Parallelism 2 allows at most `200 × 2 = 400` concurrent queue writer calls per environment. |
| `max_retries` | `20` | Initial delivery plus up to twenty retries, shared across failure classes. |
| `retry_delay` | `60` seconds | Fallback for implicit/unexpected failures; handled failures use per-message jitter below. |
| `dead_letter_queue` | Environment-specific name above | Retain exhausted failures separately from the source queue. |

### Native congestion retries and launch budget

Healthy events still make one HTTP call and ACK only a matching `recorded` or
`duplicate` result, with no added delay. Failed items make no additional HTTP call
inside the delivery: the consumer chooses a native `message.retry({delaySeconds})`
for that item, freeing invocation slots while waiting for redelivery. Successful
siblings retain their ACKs. Existing HTTP 429/503 overload feedback still rejects
the invocation after all sibling processing and dispositions settle; other
unavailable/configuration failures do not newly trigger that feedback.

Fast retry requires a positively recognized admission 429. Under the existing
160-second HTTP timeout, the shared writer client reads at most 4096 bytes and
requires valid UTF-8/JSON with exactly `error: 'Usage writer overloaded'` and reason
`queue_limit`, `pool_waiting`, or `pool_busy`. Unknown fields/reasons, generic 429,
HTML, malformed/oversized/truncated bodies and body timeouts remain generic 429
and use the conservative schedule. Other error bodies are not parsed. A recognized
pre-write rejection describes this HTTP attempt only; an earlier delivery of the
same usage ID may already have committed. Generic errors can include ambiguous
writes, so stable IDs and idempotent persistence remain essential.

For native attempt `a` (initial delivery 1), calculate
`base = min(300, 2 ** min(a - 1, 9))`; for all failures except recognized
admission 429, use `base = max(60, base)`. Choose an integer uniformly from
`base` through `2 * base`, inclusive. Positive safe-integer attempts are capped
at 21 before exponentiation; invalid metadata uses attempt 1. Mixed failure classes
share the same native count; switching classes never resets it.

| Native attempt | Recognized admission 429 | Other handled failure |
|---|---|---|
| 1 | 1–2 s | 60–120 s |
| 2 | 2–4 s | 60–120 s |
| 3 | 4–8 s | 60–120 s |
| 4 | 8–16 s | 60–120 s |
| 5 | 16–32 s | 60–120 s |
| 6 | 32–64 s | 60–120 s |
| 7 | 64–128 s | 64–128 s |
| 8 | 128–256 s | 128–256 s |
| 9 | 256–512 s | 256–512 s |
| 10–20 | 300–600 s | 300–600 s |

Processing logs add bounded `retry_class`, selected `retry_delay_seconds`, and
recognized `admission_reason` to the existing usage ID/native-attempt fields.
Selected delay is computed outside diagnostics, so logging failures cannot change
disposition. Bodies, headers and secrets are never included.

The invocation has an 840-second monotonic launch budget. A new HTTP call starts
only with **at least 180 seconds remaining**, including equality at that boundary,
leaving room for its full unchanged 160-second timeout and margin. Later unstarted
valid items retry conservatively with reason `invocation_budget`; they are neither
ACKed nor labelled writer overload. This covers parallelism 1 fallback and growing
batches without shortening timeouts or abandoning in-flight writes. Current
batch 6/par 2 has three 160-second waves (480 seconds of nominal HTTP allowance),
so normal work stays unchanged. Scheduling/AbortSignal deadlines are cooperative,
not hard guarantees against runtime stalls or the platform's 900-second wall limit.

The budget increase is global to each CF consumer: a continually failing valid
message can nominally make 21 HTTP attempts instead of 4; healthy traffic still
needs one. At-least-once delivery and operator replay can add further attempts.
Under sustained failure, polling eventually slows to **5–10 minutes** between
eligible attempts, so recovery can still wait that long plus scheduling/backlog.
For a new event receiving only recognized admission rejections, the 20 requested
delays sum to 63m 31s–127m 02s; for only other handled failures, 68m 28s–136m 56s.
These are conditional scheduled-delay sums, **not DLQ timing guarantees**, minimum
recovery windows, or retention requirements. Processing, implicit 60-second
retries, mixed histories, consumed attempts, scheduling and retention affect the
actual lifecycle. Increasing the configured count does not reset existing attempts.

Deploy and verify this retry consumer **before merging/deploying default-on
writer admission PR #9241**. Merging both ahead of one deployment is insufficient:
the production workflow promotes web before Workers. Keep pool 10, batch 6/par 2,
consumer cap 200 and exposure unchanged initially; admission is per-runtime and
does not establish aggregate database capacity for larger settings.

Persistent failures still reach the configured DLQ after the finite retry budget;
a DLQ is a recovery queue, not proof the payload is poison. Before guard rollout,
verify actual source/DLQ retention, alerting, replay ownership, and a controlled
stable-ID reconciliation/replay procedure. This change performs no hosted
retention or DLQ readback. A safe rollback must **not lower retries back to 3 while
higher-attempt messages remain outstanding**, because their next failure could
immediately dead-letter them. Preserve stable IDs and reconcile ambiguous writes
before replay; do not republish to reset attempts or discard accepted events.

The isolated staging Vercel queue keeps its own retry settings; it shares only the
bounded writer-response classification. No new environment knob or worker binding
is introduced. This preparation does not claim a healthy-traffic p95 improvement
or authorize a production rollout, capacity increase, or replay.

### Experiment control and verification

Staging uses the single EU queue `usage-ingest-processing-staging-eu`
and its EU DLQ `usage-ingest-processing-dlq-staging-eu`. It allows at most 400 concurrent writer calls with batch 2,
parallelism 2 and invocation cap 200. Production selects processing at cap 200
with batch 6 and two slots, subject to the [production merge gates](eu-queues.md#production-merge-gate).

`USAGE_INGEST_PARALLELISM` is the simple serial/parallel experiment control:

| Staging setting | Processing per invocation | Maximum writer calls at cap 200 |
|---|---|---|
| `2` (committed) | Up to two messages concurrently | `400` |
| `1` (or absent/unrecognized) | One message at a time | `200` |

Set the Worker variable to `1` in staging deployment configuration to compare
serial processing. This **does not restore batch size 1**: each delivered batch
can still contain two messages, now processed serially. Batch size and invocation
cap are separate Wrangler deployment settings. Changes to either the Worker
variable or the batch/cap configuration require a Worker redeploy to apply;
this is not a live per-request switch. No additional experiment framework or
request-controlled switch is introduced.

With timeout zero, actual batches may still contain one message. A full production
batch shares two writer slots among six messages; later messages can wait inside the
invocation. Increasing batch size is a scheduling hypothesis; local tests do not establish
batch fill or delivery-tail improvement. The 400-writer setting is a doubled
upper bound versus the prior batch-1/cap-200 configuration, not a guarantee of
throughput. Compare measured batch sizes, handler entry times, full writer-call
duration, accounting age, backlog/retries/DLQ and writer/DB pressure before
attributing any hosted latency effect.

The first test sequence is diagnostics → EU → batching. Diagnostics and EU are
already on main; staging-host middleware remains deferred. This refresh preserves
the sole selected EU source/DLQ, its preparation and routing rollback behavior,
both diagnostics and parallelism variables, and the writer target. Keep one
consumer per environment at cap 200 / parallelism 2, with production batch 6 and
staging batch 2 (at most 400 writer calls each); do not reconnect a
legacy consumer or split the cap. The queue-budget and direct runtime tests pin
the actual EU queue names and policy. Verify the refreshed source and those
checks before merge. Historical four-PR compatibility results do not validate
this first-test source, which keeps middleware unchanged.

For a full configuration rollback, restore absent parallelism (or `1`), batch 1,
timeout 0 and cap 200 for the same single queue. Preserve diagnostics, the current
writer route, retry delay/budget and per-message dispositions.

## Deploy

The existing `.github/workflows/deploy-workers.yml` discovers this service for
production and staging deployments. Production's scheduled workflow can deploy
merged changes automatically; deployment authorization and all
[production prerequisites](eu-queues.md#production-merge-gate)
must be satisfied before merge. There is no guaranteed manual deployment window.
To deploy it individually when separately authorized, dispatch that
workflow with `worker: services/usage-ingest` and `target_environment: production`
or `staging`.

Normal production and staging CI prepare their selected EU queues before Worker upload.
It reads queue names from `wrangler.jsonc`, creates missing resources with
explicit `jurisdiction: "eu"`, and verifies/reuses existing EU resources.
Unknown jurisdiction or lookup/API errors stop deployment. Both consumer upload
attempts disable Wrangler's global auto-provisioning for EU selections. Staging
continues direct HTTP to its writer; production also uses its direct Frankfurt writer. The preparation step also detaches the obsolete
environment consumer before Wrangler attaches the selected source; it preserves both queue pairs.
See [deployment-driven cutover and routing rollback](eu-queues.md).
Production uses its EU pair with batch6/parallelism2/cap200 and the existing retry policy.
Historical global production revisions retain normal provisioning; see the helper capability notes in [EU setup](eu-queues.md).
`USAGE_INGEST_QUEUE` binds the source and `USAGE_INGEST_DLQ` binds its matching DLQ;
only the source has a consumer. Exhausted failures route to that DLQ.

To deploy directly from the repository root with Wrangler authenticated to the
account in `wrangler.jsonc`:

```bash
# Staging: use the same preparation entrypoint as CI, then existing deploy commands.
pnpm --filter cloudflare-usage-ingest queues:prepare
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --env staging --experimental-provision=false

# Production: same preparation entrypoint with explicit environment.
pnpm --filter cloudflare-usage-ingest exec node scripts/provision-queues.mjs production
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --experimental-provision=false
```

Production and staging enable their public `workers.dev` URLs. After an authorized
deployment, append `/usage` to the hostname shown for `usage-ingest` or
`usage-ingest-staging` and configure that environment's gateway `USAGE_INGEST_URL`.
`POST /usage` requires `Authorization: Bearer <USAGE_INGEST_PUBLISH_SECRET>`; configure
the same dedicated publisher secret in the Worker and gateway. Set the gateway URL
and secret before gateway startup; redeploy the gateway after changing either.
Provision and verify the Worker-side publisher secret before enabling the launch
or SFO cohort controls; a missing Worker secret returns 503.
The HTTP address alone selects no traffic: production selection still requires
the existing `USAGE_QUEUE_ONLY_ENABLED` and SFO cohort controls above. No custom
routes or preview URLs are configured. The consumer is attached to each environment's producer queue.
The Worker has no direct database connection; the authenticated writer owns persistence. See
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
pnpm --filter cloudflare-usage-ingest test:queues
pnpm --filter cloudflare-usage-ingest test
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --dry-run
pnpm --filter cloudflare-usage-ingest exec wrangler deploy --dry-run --env staging --experimental-provision=false
```

The dry runs build and show bindings without creating queues or deploying a Worker.

For local HTTP testing, put a synthetic `USAGE_INGEST_PUBLISH_SECRET` in this
service's ignored `.dev.vars`, then run `pnpm --filter cloudflare-usage-ingest dev`.
The queue is simulated locally and delivered to the shipped `queue()` handler in
the same Worker. Runtime tests cover HTTP publishing, missing-configuration retries, and processing
in both environments.

## Direct usage writer

Processing calls the configured Vercel writer directly. The shared writer client
retains the internal key, optional Vercel protection bypass, stable usage identity,
160-second timeout, redirect/response validation and recorded/duplicate ACK rule.
Direct writer transport and completion diagnostics remain in place; the native retry policy is described above.

The retired Frankfurt relay source, service binding, diagnostics and deployment
step have been removed. The existing private `usage-writer-relay-staging` Worker
may remain deployed and unused. Deleting that live resource is optional later
administrative cleanup, separate from this change.

Both manual and changed-worker deployment paths keep the existing EU queue
preparation before consumer upload. When the current workflow selects an older
staging source that still requires `USAGE_WRITER_RELAY`, it fails before queue
preparation or upload. To deploy such a source, use its historical workflow with
relay support or choose a direct-writer revision; this workflow provides no relay
fallback. Reverting this cleanup restores the optional relay implementation and
workflow support, but does not itself rebind the relay in staging.

Local workerd/Queue/loopback HTTP tests cover direct publishing and consumption,
writer credentials and stable identity, ACK after writer completion, duplicate
ACK, and retry on transport/response failures. No hosted latency or placement
improvement is claimed. EU routing rollback remains a separate operation in the
[EU setup](eu-queues.md).
