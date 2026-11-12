# Usage ingest

Authenticated `POST /usage` validates the existing usage request contract and
publishes it to `USAGE_INGEST_QUEUE`, preserving the supplied usage ID. With the
[direct lane](#direct-lane) `off` (the production setting), a 202 means queue
acceptance after `send` resolves, not consumer completion. In `first` or `on_stall`,
a 202 means either queue acceptance or a matching `recorded`/`duplicate` answer from
the Frankfurt writer. The same Worker
always processes queued events through the existing Frankfurt writer. Only a
matching recorded/duplicate writer response permits ACK; invalid events and
missing writer configuration retry and can exhaust into the DLQ.

The gateway selects queued accounting for staging (`VERCEL_TARGET_ENV=staging`
and `VERCEL_ENV` not `production`) or for production (`VERCEL_ENV=production` and
`VERCEL_TARGET_ENV=production`).
There is no per-region or exposure selector; every production function region
that runs the gateway queues. Deployments whose labels match neither branch keep
direct accounting or the existing primary-region handoff. Background shadow
publication and its flag have been removed. Reconcile and drain historically
accepted shadow events before deploying processing; this change does not remove
old messages. Do not deploy this gateway source to production until the
processing consumer is independently verified. Selection being off does not stop
processing of queued events. Follow the
[production merge gates](eu-queues.md#production-merge-gate).


The wire schema comes from `@kilocode/usage-contracts` through its package export.
That package depends only on Zod at runtime; the Worker does not depend on
web-shared or database modules in its bundle.

Send `Authorization: Bearer <USAGE_INGEST_PUBLISH_SECRET>`. Authentication runs
before body reads; a missing/empty configured secret returns 503, and missing/wrong
auth returns 401. Invalid JSON/schema returns 400, requests or serialized events
over 120,000 bytes return 413, and enqueue failure returns a generic 503.
Unrelated paths return 404; other methods on `/usage` return 405.

Authenticated `POST /enkrypt-usage` accepts one bare Enkrypt usage record that
parses under `EnkryptUsageWriteSchema` and sends exactly one
`{kind: 'enkrypt_usage', v: 1, record}` message to the same `USAGE_INGEST_QUEUE`.
The path names the kind, so this ingress is the only place that builds the
envelope; an envelope-shaped body, an LLM usage body, or any other unknown key
returns 400, and an Enkrypt record on `/usage` returns 400. It uses the same
`USAGE_INGEST_PUBLISH_SECRET`, checked before the body is read, because the
gateway is the only Enkrypt producer and already holds it. Bodies over 8,192
bytes return 413; other statuses and the `usage_ingest_rejected`,
`usage_ingest_enqueue_start` and `usage_ingest_enqueue` events match `/usage`,
with an added `usage_kind: "enkrypt_usage"`. Body read and send failures also
log `error_name`, never the error message. Enkrypt schema rejections log only
issue codes and top-level schema field names. Deploy the consumer that routes tagged Enkrypt
messages before this ingress, and this ingress before any gateway publishes to it.

| Environment | Worker | Producer and consumer queue | DLQ (no consumer) |
|---|---|---|---|
| Production (top-level config) | `usage-ingest` | `usage-ingest-processing-eu` | `usage-ingest-processing-dlq-eu` |
| Staging (`env.staging`) | `usage-ingest-staging` | `usage-ingest-processing-staging-eu` | `usage-ingest-processing-dlq-staging-eu` |

Each environment connects only its EU pair. Production uses batch6/parallelism2/cap225 (up to 450 writer calls);
staging keeps one consumer capped at200, batch size2. Old global queues remain intact
for a paused/drained routing rollback. See [EU preparation and cutover](eu-queues.md).

## Direct lane

On `usage-ingest-processing-eu` we have observed paired pauses several times an
hour: `Queue.send` blocks for 10–20 seconds and consumer delivery pauses at the
same time. We found no correlation with our deploys or with writer load. Other
queues in the account did not show the same pauses in the windows we checked, but
they do not carry comparable traffic, so this does not isolate the cause. The
platform cause is unknown and outside our direct control.

These pauses contribute materially to the accounting-freshness tail. In the worst
75-minute window, 88.8% of usage was recorded within 5 seconds, against 99.7% in
quiet hours. The direct lane lets the ingress Worker write straight to the
Frankfurt writer and keeps the queue for overflow and durability. It is a
hypothesis to test in staging (see [rollout](#rollout-and-measurement)); no
production benefit has been measured yet.

| Variable | Values | Default | Production | Staging |
|---|---|---|---|---|
| `USAGE_INGEST_DIRECT_MODE` | `off`, `on_stall`, `first`; any other or missing value is `off` | `off` | `off` | `on_stall` |
| `USAGE_INGEST_DIRECT_TIMEOUT_MS` | Positive integer milliseconds for the one direct attempt, rate-limiter call and writer call together | `2000` | `2000` | `2000` |
| `USAGE_INGEST_STALL_HEDGE_MS` | Positive integer milliseconds `on_stall` waits for `Queue.send` before hedging | `2000` | `2000` | `2000` |
| `USAGE_DIRECT_LIMITER` | Workers Rate Limiting binding, constant key `ingress_direct` | — | 12,600 per 10 s (namespace `1040`) | 12,600 per 10 s (namespace `1041`) |

Every mode runs authentication, the body read, schema validation and the size check
exactly as before any lane is chosen. A failed or throwing `Queue.send` still
returns `503 Queue unavailable` in `off` and `first`. In `on_stall` it does so only
when the direct lane does not accept either; a send that fails after the hedge
while the direct write succeeds returns 202 (see the table below).

- **`off`.** Today's queue path: the same send, statuses and events, with no
  limiter call, no writer call and no `usage_ingest_publish` event. The only
  difference is that a failed send's `usage_ingest_enqueue` event carries
  `error_name`.
- **`first`.** One direct attempt. A matching `recorded` or `duplicate` returns 202
  and the queue is never touched. Any other outcome makes the same `Queue.send` call
  as `off`, with its existing diagnostics and statuses.
- **`on_stall`.** `Queue.send` starts at once and races a
  `USAGE_INGEST_STALL_HEDGE_MS` timer. If the send settles first, the response is the
  same as `off`. If the timer fires first, the Worker starts one direct attempt and
  races it against the pending send. Whichever produces an acceptance first answers:

  | Settles first | Then | Response |
  |---|---|---|
  | Send accepted | Direct still in flight | 202 at once. The direct attempt is not awaited; it is kept alive with `ctx.waitUntil`, and `usage_ingest_direct_observed` reports its outcome. |
  | Send failed | Direct accepted later | 202 from the direct write |
  | Send failed | Direct failed later | `503 Queue unavailable` |
  | Direct accepted | Send still pending | 202 at once. The send's completion handler is kept alive with `ctx.waitUntil`. |
  | Direct failed | — | The Worker awaits the send as `off` does |

  The queue lane's `usage_ingest_enqueue` fires exactly once per started send, when
  that send settles, including after a direct 202. `usage_ingest_enqueue_observed`
  fires once too, as before.

Only a strict `recorded` or `duplicate` acknowledgement for the same usage ID, as
checked by the shared writer client, counts as direct success. Everything else falls
through to the queue: HTTP 429 (including the writer's admission rejection), 5xx,
timeout, `not_recorded`, `invalid_response`, `request_failed`, `missing_config`, a
refusal from the rate limiter, a missing limiter binding, and a limiter error. The
direct lane never retries, never fails a request on its own, and sends
`x-usage-write-source: ingress_direct` with `USAGE_INGEST_DIRECT_TIMEOUT_MS` as the
client timeout.

### Duplicate writes are intended

`on_stall` deliberately makes a direct write after a queue send that may already
have succeeded, so the same event can reach the writer twice. `first` can do the
same after an ambiguous direct failure, such as a client timeout while the writer is
still committing. Both deliveries carry the same usage ID. The writer's insert has
no `ON CONFLICT` clause, so the second transaction fails on the `microdollar_usage`
primary key. It rolls back, including the balance update, the organization
consumption, the daily rollup repair and the Bouncer outbox row, and the writer
answers `duplicate`. Post-commit work (Bouncer delivery, organization alerts,
auto-top-up and the Kilo Pass bonus) and PostHog first-usage events run only for
the delivery that committed. The queue consumer ACKs a `duplicate`. Expect almost
every hedged event in `on_stall` to appear later as a queue `duplicate`.

A 202 in `on_stall` does not wait for the other lane. Work after the response is
registered with `ctx.waitUntil` when a context exists. If registration throws,
`usage_ingest_background_unregistered` is logged, and the pending promises still
have handlers, so nothing is left as an unhandled rejection. One deadline,
`USAGE_INGEST_DIRECT_TIMEOUT_MS`, covers the rate-limiter call and the writer call,
so a limiter that never answers counts as `limiter_unavailable` once the deadline
passes and cannot hold a request open. Cloudflare's
`waitUntil` allowance (30 seconds after the response), a hard termination or a
missing context can end that work before it settles. Then the parked queue result,
the direct observation, or the queued duplicate itself may never be logged or
delivered. The response is already backed by a confirmed acceptance in each case.

### Attack and overload bound

- **Writer admission.** `ingress_direct` may hold at most 5 of the 8 admission slots
  in each writer runtime instance. Over that ceiling the writer returns the existing
  `queue_limit` 429 and the event goes to the queue. A direct call never waits in
  the writer's 250 ms admission FIFO, so it cannot take a place ahead of a queue
  write. The Enkrypt `non_llm` class keeps its own ceiling of 2 in the same shared
  limit; see [writer admission protection](#writer-admission-protection). These
  are per-instance counters inside the existing limit. They reserve no database
  connections and do not guarantee queue capacity across the fleet.
- **Rate limiter.** `USAGE_DIRECT_LIMITER` caps direct attempts at roughly 3× the
  observed 420/s peak release rate over the shortest period Cloudflare allows
  (10 seconds). The key is a constant, so the limit is shared by all payers. Per
  Cloudflare's documentation the limit applies separately in each Cloudflare
  location and is approximate, not one fleet-wide cap, and requests can exceed it
  while counts synchronize. A refusal, a missing binding or a limiter error skips the
  direct attempt.
- **Queue overflow.** Every refused or failed direct attempt makes the same
  `Queue.send` call as today, so the queue remains the durable path.

The limiter and the ceiling bound how hard the direct lane can push on the writer.
They are not authentication: only callers that hold `USAGE_INGEST_PUBLISH_SECRET`
reach any lane.

### Diagnostics

`first` and `on_stall` emit exactly one `usage_ingest_publish` event per request
that passes validation, when the response is decided:

| Field | Meaning |
|---|---|
| `mode` | `first` or `on_stall` |
| `lane` | `direct` when the direct write produced the 202; otherwise `queue` |
| `status` | HTTP status returned |
| `rate_limited` | `true` when the limiter refused, was missing or threw; `false` while the direct attempt is still pending |
| `direct_outcome` | `recorded`, `duplicate`, a writer-client reason, `rate_limited` or `limiter_unavailable`; absent when no direct attempt was due or it was still pending |
| `direct_pending` | `true` when the queue answered while the direct attempt was still in flight |
| `direct_duration_ms` | Monotonic duration of the writer call |
| `direct_status`, `direct_admission_reason` | Writer HTTP status and recognized admission reason, when present |
| `send_duration_ms` | Monotonic duration of the awaited send; absent when the send was not awaited |
| `usage_id` | Validated usage ID |

`usage_ingest_direct_observed` (usage ID, `rate_limited` and the direct fields
above) reports a direct attempt that finished after the queue had already answered.
The queue lane keeps `usage_ingest_enqueue_start`, `usage_ingest_enqueue` and
`usage_ingest_enqueue_observed`, each once per started send, so existing queries
keep working. The shared writer
client also logs `usage writer acknowledged` or `usage writer unavailable` for each
direct attempt.

Every failure handler names what failed with a bounded `error_name`, never the
error message, body, headers or URL: `usage_ingest_direct_limiter_failed` (limiter
error, or `TimeoutError` at the deadline), `usage_ingest_direct_failed` (the writer
client threw instead of returning an outcome), `usage_ingest_background_failed`,
`usage_ingest_background_unregistered`, `usage_ingest_serialization_failed`, and
`usage_ingest_enqueue` with `outcome: unavailable`. That last field is the one
change `off` mode can show: a failed send's event gains `error_name`, as the
Enkrypt ingress already logs. Successful `off` traffic logs exactly as before.

### Deployment prerequisite

The Frankfurt writer in the target environment must accept
`x-usage-write-source: ingress_direct` before that environment's Worker runs a
direct mode. An older writer does not reject the header: it maps it to `unknown`
and skips writer admission, so direct writes would still succeed but without the
5-slot direct ceiling.

Neither scheduled workflow orders the Worker after the writer. In both
`deploy-staging.yml` and `deploy-production.yml`, `deploy-workers` needs only
`check-changes`, `db-gate` and `detect-workers`, so it runs beside the web app
deploy, and a pending or failed app deploy does not hold it back. A manual
`deploy-workers.yml` dispatch, a Worker redeploy or a Worker rollback does not check
the writer either. The ordering is therefore a merge and deploy gate, not something
CI enforces:

- Merge the writer change first, and merge the Worker change only after the writer
  that recognizes `ingress_direct` is confirmed live in staging. Staging commits
  `on_stall`, so the next staging Worker deploy turns the lane on. Production is
  `off` and needs no gate until a production mode change.
- Before a manual Worker deploy or rollback, confirm that the environment's
  deployed writer includes the change.
- Before rolling the writer back to a version without it, deploy that environment's
  Worker with `USAGE_INGEST_DIRECT_MODE` set to `off` first.

Source on a branch or on `main` is not evidence of deployed state. Once direct
traffic exists, `usage_writer_admission` or `usage_record_completion` lines with
`writer_caller: ingress_direct` from that writer show that it recognizes the source.

### Rollout and measurement

This change ships with production `off` and staging `on_stall`.

- **Staging.** Deploying this configuration activates `on_stall` in staging; no
  further flag change is needed. Validate it with the controlled procedure in
  [validate the `on_stall` direct lane](load-test.md#validate-the-on_stall-direct-lane).
  A normal load run can pass without ever making a direct write.
- **Production.** Stays `off`. Enabling `on_stall` or `first` in production is a
  separate decision by the service owner, made after staging evidence and a
  capacity assessment of the shared writer and database. This change does not
  approve either mode or a sequence between them. `on_stall` is not inherently
  safe under attack or surges, and it is not a required step before `first`. The
  bounds above are per writer instance and per Cloudflare location, not
  fleet-wide.

Each mode change is a committed variable and a normal Worker deploy. This change
flips no production variable.

Measure:

- **Stall-release share of records over 5 s.** Measure the minute before, the
  minute of, and the minute after each stall release. Today the values are about
  4.0% / 11.4% / 2.4% across 89 releases with high rejection rates.
- **Direct attempts and overflow.** Writer-side `ingress_direct` attempts
  (`usage_record_completion` and `usage_writer_admission` with
  `writer_caller: ingress_direct`), kept separate from hedge candidates and from
  skips that never reached the writer (`rate_limited`, `limiter_unavailable`,
  `missing_config`). Report the share of `lane: queue` among hedged requests by
  `direct_outcome`. See
  [validate the `on_stall` direct lane](load-test.md#validate-the-on_stall-direct-lane).
- **Duplicate rate.** `usage_ingest_processing` with outcome `duplicate`, and
  `usage_record_completion` with `writer_caller: queue` and outcome `duplicate`.

Non-goals: no retries in the direct lane, no change to the consumer, no change to
the gateway publisher, and no production variable change.

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

Publisher and consumer delivery diagnostics (`usage_ingest_enqueue_start`,
`usage_ingest_enqueue`, `usage_ingest_handler_entry`, and the batch identity on
`usage_ingest_processing`) are always emitted; see
[queue delivery diagnostics](diagnostics.md). The best-effort completion observation
(`usage_ingest_enqueue_observed`) is described next.

`usage_ingest_enqueue_observed` is registered on `ExecutionContext.waitUntil` before the
single send is awaited, so it is intended to report the completion of that same send even
when the caller has already disconnected. It records only the validated usage ID, the
outcome and the monotonic send duration; it adds no send, retry, response or authentication
change. This extends only the post-response observation lifetime: the HTTP status still
comes from the awaited send (except a direct-lane 202 in `on_stall`, described under
[direct lane](#direct-lane)), and no log proves the consumer committed a database row. A
stall longer than Cloudflare's `waitUntil` allowance after the response or disconnect (30 s)
can still end before the send settles, and a hard kill can lose the observation entirely; a
missing observation is therefore not evidence that the send failed.

Processing also logs `queue_wait_ms` from the queue message timestamp to the start
of handling that message, independently of writer duration. Selected existing processing
outcomes also include `handler_entry_queue_age_ms`, the non-negative wall-clock
age of the queue message at invocation entry, and `slot_wait_ms`, the rounded
monotonic time from invocation entry until that message starts processing in a
slot. Queue age crosses clocks and may include skew; it is not an exact transport
duration. Slot wait includes local scheduling as well as time behind other messages.
The fields appear when entry age, queue wait, slot wait, or writer duration reaches
1,000 ms, or when a stable hash of queue message ID and attempt falls in a nominal
1% bucket. Actual coverage depends on the message ID distribution.
This enriches existing outcomes without adding a log stream; the baseline is
repeatable and is not a uniform random sample of distinct usage IDs.

For an individual delivery, find `usage_ingest_processing` by exact `usage_id`
and retain `queue_message_id` and `delivery_attempts` to distinguish redeliveries.
Read its entry age, slot wait, and `writer_duration_ms` together; correlate the
same usage ID with `usage_record_completion` for the writer's persistence time.
Multiple attempts may exist; usage ID alone cannot uniquely match a writer attempt.
Do not subtract subgroup percentiles to infer a
phase duration, or treat timestamps from different hosts as exact.

Shared direct and
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
contain only the usage ID, the usage kind for tagged writes, categorical outcome or
HTTP status, and for a caught transport, parse or stream failure its error name
(never its message). An unread error body is released; if that release fails, the
helper logs `usage writer response release failed` with the usage ID, usage kind
and error name only, and the write outcome is unchanged. A body that was already
read is not released again.

### Tagged Enkrypt usage

The same queue can also carry Enkrypt guardrail usage. Such a message is a tagged
envelope, `{"kind":"enkrypt_usage","v":1,"record":<EnkryptUsageWrite>}`
(`EnkryptUsageQueueMessageSchema` in `@kilocode/usage-contracts`). LLM usage stays
untagged and unchanged; its ingress schema strips unknown keys, so a body with its
own `kind` key is always a tagged message. The gateway produces Enkrypt messages
only through `/enkrypt-usage`, behind a default-off flag; see
[Enkrypt usage rollout](#enkrypt-usage-rollout).

The consumer reads the tag before anything else:

| Body | Writer call | ACK on | Retry on |
|---|---|---|---|
| Untagged | Existing LLM writer at `USAGE_WRITER_URL` | Unchanged | Unchanged |
| `enkrypt_usage`, `v: 1`, valid record | `/api/internal/enkrypt-usage/record` with `x-usage-write-source: queue` | `recorded` or `duplicate` whose `usageId` equals `record.id` | Any other response, including a wrong or missing id echo, HTTP 429 and 503 |
| `enkrypt_usage`, `v: 1`, invalid record or extra key | None | Never | Conservative retry (`invalid_event`) |
| Any other `kind`, or another `v` | None | Never | Conservative retry (`unsupported_kind`) |

A message that never ACKs exhausts the shared 20-retry budget and goes to the DLQ,
so the DLQ can hold both kinds. A recognized admission 429 takes the admission
retry schedule, and HTTP 429/503 rejects the invocation, exactly as for LLM usage.
The invocation launch budget is shared. Consumer settings are unchanged. On the
writer, these queue writes take the `non_llm` admission class described under
[writer admission protection](#writer-admission-protection); its ceiling rejection
is a recognized `queue_limit` 429.

The Enkrypt writer URL is `USAGE_WRITER_URL` with its documented
`/api/internal/usage/record` suffix replaced by the Enkrypt path, so no new
variable is needed. If `USAGE_WRITER_URL` is missing or does not end with that
suffix, Enkrypt messages retry as `missing_config` without network I/O. The writer
credential, bypass and 160-second timeout are shared.

Tagged messages add `usage_kind` to `usage_ingest_handler_entry`,
`usage_ingest_processing` and the writer helper logs (`usageKind` there):
`enkrypt_usage`, or `unknown` for an unrecognized tag (the raw tag is not logged).
Untagged LLM logs keep exactly their existing fields, so filter LLM-only counts
with a missing `usage_kind`. Enkrypt logs carry only the usage id and kind: no
payer, user, session, cost or `occurredAt`-derived age.

Deploy order: this consumer first, then the ingress, then the producer with its
flag off. Never roll the consumer back to an LLM-only version while tagged
messages may be in flight or retrying: an LLM-only consumer fails them as invalid
events and they reach the DLQ after 20 retries. To stop tagged traffic, turn the
producer flag off and let the consumer drain.

## Observability

`usage_record_completion` is a persistence event for lasting
diagnosis and log-derived counts/latency. `entrypoint` is `gateway`,
`writer_endpoint`, or `unknown`; `writer_caller` is `queue`, `queue_vercel`,
`ingress_direct`, `region_handoff`, or `unknown`. These finite fields separate concurrent paths:

| Persistence path | `entrypoint` | `writer_caller` |
|---|---|---|
| Frankfurt gateway direct write or SFO local fallback | `gateway` | `unknown` |
| Queue consumer through HTTP writer | `writer_endpoint` | `queue` |
| Staging Vercel queue consumer through HTTP writer | `writer_endpoint` | `queue_vercel` |
| Ingress Worker direct write ahead of its queue | `writer_endpoint` | `ingress_direct` |
| SFO gateway handoff through HTTP writer | `writer_endpoint` | `region_handoff` |
| HTTP writer without a classified caller, including classifier/grader writes | `writer_endpoint` | `unknown` |
| Unclassified local caller | `unknown` | `unknown` |

The Queue consumer explicitly opts into `x-usage-write-source: queue`; the SFO
handoff client sets `region_handoff`. Other shared-client users, including the
classifier and benchmark grader, omit the marker. After internal API authentication,
the writer route accepts only `queue`, `queue_vercel`, `ingress_direct`, or
`region_handoff`; missing or other values map to `unknown` without logging the raw
header. This is caller-supplied diagnostic
context, not an authorization or accounting input. Older clients remain compatible.
See the [Vercel queue prototype runbook](../../packages/usage-queue/README.md) for
the isolated staging transport and its `queue_vercel` caller label.
`execution_region` identifies the persistence function's region when available:
SFO HTTP handoffs record `fra1`; a local fallback in SFO records `sfo1`.
Missing or unrecognized `VERCEL_REGION` values are reported as `unknown`.
After attempting queue publication, the gateway never falls back to a billing
writer. Existing direct fallbacks for missing publisher configuration or failed
lifetime registration remain safe because no publication was attempted. The
Cloudflare HTTP publisher retries transient failures up to four total attempts,
with up to twenty seconds for the first confirmation and five seconds for each later
one, inside a 40-second overall elapsed retry budget. Before retries it uses
exponential full jitter: uniformly zero up to (excluding) 500 ms, 1,000 ms, then
2,000 ms. Attempt timeouts and sleeps are clipped to remaining budget; no new
attempt starts after exhaustion. Runtime scheduling can delay observation of
these deadlines. Non-retry calls retain one two-second attempt; the separate
Vercel queue transport is unchanged. Every attempt reuses the same serialized
event and usage ID;
ambiguous acceptance can create duplicate messages, which the writer deduplicates.
Configuration failures and HTTP outcomes other than 408/429/5xx are not retried.
Redirects are terminal 3xx failures; their targets are never followed.
`usage enqueue retrying` logs the usage
ID, categorical reason and failed attempt number before each retry. `usage accounting publication failed` logs the finalized
`usageId` and categorical `reason`; accounting returns null and emits no gateway
persistence completion. This is not durable recovery: unaccepted events may be
lost, and ambiguous failures may still be recorded later by the consumer. For
unselected events, the existing SFO handoff-to-local fallback remains unchanged.

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

Both environments also persist [Workers traces](https://developers.cloudflare.com/workers/observability/traces/)
for a 5% head sample of invocations (`observability.traces`, inherited by
`env.staging`). Trace sampling is independent of Workers Logs, which keep their unsampled default.
Sampled traces show the fetch and queue handler spans, `queue_send`, and the
outbound writer `fetch` with timing and status. In the dashboard, filter by
`$metadata.service` (`usage-ingest` or `usage-ingest-staging`) rather than
`service.name`. Trace IDs are not propagated to the Vercel writer, spans do not
show time a message waits in the queue before the consumer handler starts, and a
5% sample cannot count rare events; use the logs above for those. No custom spans
are added. See the [span attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)
and [known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

## Queue policy

Production uses batch size 6 and staging keeps batch size 2. Both allow at most
two writer slots per invocation:

| Consumer setting | Value | Purpose |
|---|---|---|
| `max_batch_size` | `6` in production, `2` in staging | Maximum messages delivered per invocation. |
| `max_batch_timeout` | `0` seconds | No intentional wait to fill a batch. |
| `max_concurrency` | `225` in production, `200` in staging | Parallelism 2 allows at most `225 × 2 = 450` concurrent queue writer calls in production and `200 × 2 = 400` in staging. |
| `max_retries` | `20` | Initial delivery plus up to twenty retries, shared across failure classes. |
| `retry_delay` | `60` seconds | Fallback for implicit/unexpected failures; handled failures use per-message jitter below. |
| `dead_letter_queue` | Environment-specific name above | Retain exhausted failures separately from the source queue. |

The production cap `225` is an intentional single-knob trial from the previous
`200`. Batch size 6, fill timeout 0, parallelism 2, retries, staging settings and
the writer pool/admission limits are unchanged. `225 × 2 = 450` is a theoretical
maximum writer HTTP call ceiling versus `400`; it is not 450 database
connections, guaranteed active consumers or measured throughput. The trial
window, measurement and rollback are operator decisions. Merging this source
enables the existing scheduled production deployment but does not itself start a
hosted trial or support a latency claim.

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
writer admission PR #9241**. Merging both ahead of one deployment is insufficient
while the consumer is not yet live: production deploys Workers beside the Vercel
stage-and-promote chain, so the graph does not order this service's deploy ahead
of the promotion. Confirm the deploy of this service finished before relying on
the promoted release. That rollout kept pool 10, batch 6/par 2, consumer cap 200
and exposure unchanged; admission is per-runtime and does not establish aggregate
database capacity for larger settings.

Persistent failures still reach the configured DLQ after the finite retry budget;
a DLQ is a recovery queue, not proof the payload is poison. DLQ retention is
enforced at Cloudflare's maximum of 14 days (1209600 seconds); see
[Retention](#retention). Before guard rollout, verify alerting, replay ownership,
and a controlled stable-ID reconciliation/replay procedure. A safe rollback must
**not lower retries back to 3 while higher-attempt messages remain outstanding**,
because their next failure could immediately dead-letter them. Preserve stable IDs
and reconcile ambiguous writes before replay; do not republish to reset attempts
or discard accepted events.

The isolated staging Vercel queue keeps its own retry settings; it shares only the
bounded writer-response classification. No new environment knob or worker binding
is introduced. This preparation does not claim a healthy-traffic p95 improvement
or authorize a production rollout, capacity increase, or replay.

### Writer admission protection

The Frankfurt HTTP writer authenticates and validates the request before applying
one admission guard to `queue` and `queue_vercel` callers. Both transports share a
per-runtime active-call limit of `max(1, pool.options.max - 2)`, currently **8**
with the unchanged pool maximum of 10. The writer returns HTTP **429** before usage
database work as follows:

- While the active-call limit has room, the request is rejected immediately when
  the primary pool has waiting clients (`pool_waiting`) or when checked-out
  connections (`totalCount - idleCount`) reach the same limit (`pool_busy`).
- When the active-call limit is occupied, the request is still rejected
  immediately with `pool_waiting` if the pool has waiting clients. Otherwise it
  waits up to **250 ms** in a per-runtime FIFO capped at the same limit (8
  waiters). `pool_busy` is not checked on arrival in this case: this runtime's
  own active writers can occupy the pool, so checked-out connections are not
  independent evidence of additional pressure. A slot is held through awaited
  post-commit work and can outlive its connection, so 8 active calls do not imply
  8 checked-out connections either way.
- A finished call hands its slot to the oldest waiter, which is rechecked against
  both `pool_waiting` and `pool_busy` before it is admitted; a waiter that fails
  the recheck is rejected with that pool reason, and the slot passes to the next
  waiter or is freed.
- A caller beyond the FIFO cap is rejected immediately, and a waiter not granted
  within 250 ms is rejected, both with `queue_limit`.

The response reason is bounded to `queue_limit`, `pool_waiting`, or `pool_busy`.
The `usage_writer_admission` log reports `slot_wait_ms` (0 for immediate
decisions) and `waited: true` on a rejection after waiting. The 250 ms bounds only
the admission wait; the rest of the request, including the write and awaited
post-commit work, is not bounded by it.

A slot remains held until the awaited persistence call completes, including
awaited post-commit work, and is released on success, duplicate, `not_recorded`,
or an exception. Rejection never acknowledges the usage or triggers direct
accounting fallback: the existing Cloudflare consumer individually retries failed
messages using the native policy above, ACKs successful siblings, and rejects
the invocation after all siblings settle. The staging Vercel consumer throws rather than returning an ACKable
success. Direct gateway writes, region handoff, and missing/unknown source callers
retain their existing behavior.

The two connections of nominal headroom are a starting local policy, **not
reserved connections** or a measured global capacity bound. Other traffic can
compete after the snapshot, a writer may perform several database operations,
background work can outlive the awaited call, and each runtime instance has its
own counter/pool. An admitted call can still wait. The pool maximum stays at 10,
consumer concurrency at 225 in production (200 in staging), parallelism at 2, and
batch size at 6 in production and 2 in staging; retry settings also stay unchanged.
There is no new environment knob; merging this change activates queue rejection
when the normal automatic deployment reaches the writer.

Queue writes to the Enkrypt writer (`/api/internal/enkrypt-usage/record`) use the
same guard and the same shared limit, as writer class `non_llm`. That class has
its own ceiling inside the shared limit: `max(1, min(2, limit - 1))`, currently
**2 of 8**. A `non_llm` call over the ceiling gets the same HTTP 429 body with
reason `queue_limit` and is not written. Its active plus queued calls never exceed
the ceiling, so it cannot fill the FIFO either. LLM queue writes can still use all
8 slots; the ceiling only stops non-LLM writes from taking more than 2. When the
shared limit is 1 (pool maximum 3 or less), the ceiling is 1 and a non-LLM call
can take the only slot. The total limit is unchanged. Like the shared limit, this
is a per-runtime counter, not a connection reservation, and it makes no
fleet-wide fairness claim.

The same guard also admits `ingress_direct`, the ingress Worker's direct write ahead
of its queue, as writer class `direct`. A direct
call never waits and never joins the FIFO. It is decided immediately against the
shared limit, the pool checks, and its own ceiling of `max(1, limit - 3)` direct
calls, currently **5 of 8** per runtime instance. When any of those refuses it, the
call gets the same HTTP 429 body with reason `queue_limit` (or the pool reason),
so the shared writer client's strict rejection schema is unchanged, and the Worker
sends the event to its queue instead. Because it never queues, a direct call cannot
overtake or displace a waiting queue caller.

The `direct` and `non_llm` ceilings are caps inside the one shared limit, not
reservations in either direction. Neither class is guaranteed a slot, and LLM queue
writes can still use all 8. With today's pool of 10, direct calls cannot occupy the
last three slots of an instance and `non_llm` calls cannot occupy more than two.
If both classes are at their ceilings at the same time (5 + 2), LLM queue writes
still have at least one of the instance's eight. With smaller pools the
`max(1, …)` floors can remove that headroom: a pool maximum of 3 gives a shared
limit of 1 and a ceiling of 1 for each class, so either can take the only slot.
These are per-instance counters. They do not reserve connections, and they do not
guarantee queue slots across the fleet, because each instance counts only its own
calls and other traffic can still fill the pool.

`usage_writer_admission` diagnostics sample admitted decisions at 1% and warn on
all rejected decisions. Fields contain only the bounded caller/outcome/reason,
`writer_class` (`queue`, `non_llm` or `direct`), active count/limit,
`active_non_llm`, `non_llm_limit`, `active_direct` and `direct_limit`, pool
gauges/max, and sample rate; diagnostic failures cannot
change admission or persistence results.

The source policy remains finite: initial delivery plus up to **20 retries**
under the native congestion schedule above. Sustained overload can exhaust that
budget and move events into the **DLQ**; this guard does not keep arbitrary bursts
in the source queue indefinitely. PR #9248 must be confirmed deployed before this
guard is merged/deployed; its merge alone does not verify deployment. Local tests
do not establish hosted throughput, spare capacity, or latency improvements.

### Experiment control and verification

Staging uses the single EU queue `usage-ingest-processing-staging-eu`
and its EU DLQ `usage-ingest-processing-dlq-staging-eu`. It allows at most 400 concurrent writer calls with batch 2,
parallelism 2 and invocation cap 200. Production selects processing at cap 225
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
the parallelism variable, and the writer target. Keep one
consumer per environment at parallelism 2, with production cap 225 and staging cap
200; production batch 6 and staging batch 2 give at most 450 and 400 writer calls
respectively. Do not reconnect a
legacy consumer or split the cap. The queue-budget and direct runtime tests pin
the actual EU queue names and policy. Verify the refreshed source and those
checks before merge. Historical four-PR compatibility results do not validate
this first-test source, which keeps middleware unchanged.

For a full configuration rollback, restore absent parallelism (or `1`), batch 1,
timeout 0 and the pre-trial cap 200 for the same single queue. Preserve the current writer
route, retry delay/budget and per-message dispositions.

## Deploy

The `detect-changes` job of `.github/workflows/deploy-workers.yml` discovers
this service for production and staging deployments. Each deploy workflow calls
that workflow once for detection, as soon as it holds the baseline, and a second
time to deploy the matrix the detection call returns. Production's scheduled
workflow can deploy merged changes automatically; deployment authorization and all
[production prerequisites](eu-queues.md#production-merge-gate)
must be satisfied before merge. There is no guaranteed manual deployment window.
To deploy it individually when separately authorized, dispatch that
workflow with `worker: services/usage-ingest` and `target_environment: production`
or `staging`.

Normal production and staging CI prepare their selected EU queues before Worker upload.
It reads queue names from `wrangler.jsonc`, creates missing resources with
explicit `jurisdiction: "eu"`, and verifies/reuses existing EU resources. It keeps
the selected DLQ at maximum message retention ([Retention](#retention)).
Unknown jurisdiction or lookup/API errors stop deployment. Both consumer upload
attempts disable Wrangler's global auto-provisioning for EU selections. Staging
continues direct HTTP to its writer; production also uses its direct Frankfurt writer. The preparation step also detaches the obsolete
environment consumer before Wrangler attaches the selected source; it preserves both queue pairs.
See [deployment-driven cutover and routing rollback](eu-queues.md).
Production uses its EU pair with batch6/parallelism2/cap225 and the existing retry policy.
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
Provision and verify the Worker-side publisher secret before enabling staging
or production traffic; a missing Worker secret returns 503.
The HTTP address alone selects no traffic: production selection requires both
production environment labels, in any function region the
gateway runs. There is no per-region, per-payer or exposure control.
Verify the deployed gateway version and effective settings before drawing conclusions
about live selection; source defaults alone do not establish deployed state. No custom
routes or preview URLs are configured. The consumer is attached to each environment's producer queue.
The Worker has no direct database connection; the authenticated writer owns persistence. See
[Wrangler automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning).

## Enkrypt usage rollout

The gateway sends Enkrypt guardrail usage through this queue only when the
`kilocode-ai-gateway` variable `ENKRYPT_USAGE_QUEUE_ENABLED` is exactly `true`; see
`ENVIRONMENT.md`. It posts the bare Enkrypt usage record to `/enkrypt-usage` on the
same Worker as `/usage`, and the ingress wraps it in the tagged queue envelope.

Deploy in this order. Each step must be deployed and verified before the next:

1. The gateway accepts an optional `usageId` in Enkrypt handoff replies.
2. The web app's Enkrypt usage route echoes `usageId` and takes queue writer admission.
3. The writer's small non-LLM admission class, the consumer that routes tagged Enkrypt
   messages, and the `/enkrypt-usage` ingress. Nothing posts to the ingress before step 4.
4. The gateway producer, with the flag off.
5. The flag on. Frankfurt and SFO pick it up with the same gateway deployment; that is not
   an atomic cutover, because a rolling deployment can briefly overlap old and new settings.

Rollback: set the flag to anything other than `true` and redeploy the gateway. New Enkrypt
usage then takes the direct path again, and the consumer drains what the queue already
accepted. Never roll the consumer back to an LLM-only version while tagged Enkrypt messages
may still be in the source queue or in flight: they would fail every retry and reach the DLQ.

Human-only steps, before the flag is turned on:

- name a replay owner for the now-mixed DLQ, with a replay that handles both LLM and Enkrypt
  messages;
- confirm the existing DLQ alerting covers it;
- set the flag on `kilocode-ai-gateway` and redeploy.

## Retention

Each selected DLQ keeps messages for **14 days (1209600 seconds)**, Cloudflare's
maximum. Retention is a property of the queue resource, and `wrangler.jsonc`
cannot set it, so the queue preparation helper enforces it as
`DLQ_MESSAGE_RETENTION_SECONDS`. It creates a missing DLQ with that retention. For
an existing DLQ, it raises lower retention with a PATCH that resends the other
queue settings unchanged, then reads the queue back and stops deployment on any
mismatch. Retention at or above the value is left alone, so it is never lowered.
Jurisdiction, consumers and messages are not touched.

The value is applied by CI's preparation step on the next usage-ingest deployment
of each environment, and every later deployment keeps it at the maximum. Merging
does not change a live queue. To read it back, open **Queues** in the Cloudflare
dashboard, select the DLQ from the table above, and check the message retention
period on its **Settings** tab. The read-only API equivalent is
`result.settings.message_retention_period` from
`GET /accounts/{account_id}/queues/{queue_id}`.

Source queues keep Cloudflare's default of four days (345600 seconds), which the
helper does not change. That is far longer than the source retry window: 20
retries at the 60-second `retry_delay`, and under nine hours even if all 21
deliveries ran for the 15-minute invocation limit with the 600-second maximum
handled retry delay.

See [queue settings](https://developers.cloudflare.com/queues/configuration/configure-queues/#queue-configuration)
and [limits](https://developers.cloudflare.com/queues/platform/limits/).

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

### Authenticated HTTP 400 diagnostics

`usage_ingest_rejected` emits one best-effort warning for each authenticated
HTTP 400: `missing_body`, `body_read_failure`, `invalid_utf8`, `malformed_json`,
or `schema_failure`. Statuses, response bodies, validation and queue behavior
are unchanged. Failed authentication never reads the body or emits this event.

Schema diagnostics contain at most eight issues and an omitted count. Each issue
has an allowlisted code, a schema-owned path (at most four segments; unknown
segments stop at `[redacted]`), and allowlisted expected/received type labels.
Labels are at most 17 characters and path segments at most 26 characters.
`unknown` covers unsupported expected types, including enum contents; values,
validator messages, unrecognized-key lists and exception text are never logged.
Received types use bounded own data-property traversal of parsed JSON only.
A usage ID is included only after independent validation by the contract's UUID
schema; body/JSON failures have no usage ID. Log sink/formatting failure is isolated.

In Cloudflare Workers Logs, open the warning's invocation (or join using the
platform request ID). Read the executing revision from the same invocation's
`$workers.scriptVersion.id` metadata. This is the deployed Worker version,
not a Git source SHA; no version binding or configuration change is required.
The log's own fields intentionally contain no raw request/headers or request ID.
After a separately authorized rollout, an operator still needs to capture an
actual rejection and its invocation/version to establish a production cause.
This diagnostic does not recover missing usage or explain HTTP 409 responses.
