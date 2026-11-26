# Usage ingest

Authenticated `POST /usage` validates the existing usage request contract and
publishes it to `USAGE_INGEST_QUEUE`, preserving the supplied usage ID. A 202 means
queue acceptance after `send` resolves, not consumer completion. The same Worker
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
`{kind: 'enkrypt_usage', v: 1, record}` message: to the dedicated `USAGE_INGEST_ENKRYPT_QUEUE`
when the cutover switch is on, otherwise to `USAGE_INGEST_QUEUE` (see
[Cutover switch](#cutover-switch)).
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

Authenticated `POST /exa-usage` works the same way for Exa: it accepts one bare record that
parses under `ExaUsageRecordSchema` and sends exactly one `{kind: 'exa_usage', v: 1, record}`
message to the same queue `/enkrypt-usage` selects. An envelope-shaped body, an LLM usage body, an Enkrypt record or
any other unknown key returns 400, and an Exa record on `/usage` or `/enkrypt-usage` returns 400.
The organization id stays a strict UUID, as the Exa contract defines. It uses the same
`USAGE_INGEST_PUBLISH_SECRET`, checked before the body is read. The web app, the only Exa
producer, already holds `INTERNAL_API_SECRET`, which writes usage directly to the writer
routes, so also holding the publish secret adds little. The 8,192-byte cap, statuses and logs
match `/enkrypt-usage`, with `usage_kind: "exa_usage"`. Schema rejections name top-level
fields, but Exa log values never include the user, organization, path, cost, feature, type or
`occurredAt`. See [Exa usage rollout](#exa-usage-rollout).

| Environment | Worker | Producer and consumer queue | DLQ (no consumer) |
|---|---|---|---|
| Production (top-level config) | `usage-ingest` | `usage-ingest-processing-eu` | `usage-ingest-processing-dlq-eu` |
| Production stall hedge | `usage-ingest` | `usage-ingest-processing` | `usage-ingest-processing-dlq` |
| Staging (`env.staging`) | `usage-ingest-staging` | `usage-ingest-processing-staging-eu` | `usage-ingest-processing-dlq-staging-eu` |
| Staging stall hedge | `usage-ingest-staging` | `usage-ingest-processing-staging` | `usage-ingest-processing-dlq-staging` |
| Production Enkrypt and Exa fallback | `usage-ingest` | `usage-ingest-enkrypt-eu` | `usage-ingest-enkrypt-dlq-eu` |
| Staging Enkrypt and Exa fallback | `usage-ingest-staging` | `usage-ingest-enkrypt-staging-eu` | `usage-ingest-enkrypt-dlq-staging-eu` |

Each environment publishes to its EU pair. Production uses batch6/parallelism2/cap225 (up to 450 writer calls);
staging keeps its EU consumer capped at200, batch size2. The old global pair of each
environment is now also the [stall hedge](#stall-hedge-to-the-global-queue) target, with
its own consumer capped at 25. See [EU preparation and cutover](eu-queues.md).

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

Writer HTTP 429 and 503 reject the queue invocation after all messages in the
batch have been handled, except for a validated tagged write with a recognized
`queue_limit` 429 and the exact response header `x-usage-class-limit: non_llm`.
That message takes its usual admission retry. A shared overload in any sibling
still fails the invocation. Each successful message keeps its explicit ACK; failed
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
comes from the awaited send, and no log proves the consumer committed a database row. A
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

### Tagged Enkrypt and Exa usage

Enkrypt guardrail usage and Exa fallback usage go to the shared queue until the
[cutover switch](#cutover-switch) is on, and then only to the
[dedicated tagged queue](#enkrypt-usage-queue). The same consumer code processes both queues, so
either keeps draining whatever it already accepted. **Do not merge the change that turns the
switch on** until the dedicated consumer's attachment is verified in both environments and a
separate stall alert on the production dedicated source is deployed and verified; see
[Rollout](#rollout). Such a
message is a tagged envelope: `{"kind":"enkrypt_usage","v":1,"record":<EnkryptUsageWrite>}`
(`EnkryptUsageQueueMessageSchema` in `@kilocode/usage-contracts`) or
`{"kind":"exa_usage","v":1,"record":<ExaUsageRecord>}` (`ExaUsageQueueMessageSchema`).
LLM usage stays untagged and unchanged; its ingress schema strips unknown keys, so a body
with its own `kind` key is always a tagged message. The gateway produces Enkrypt messages
only through `/enkrypt-usage`, in every region; see
[Enkrypt usage queue](#enkrypt-usage-queue). Exa messages come only through
`/exa-usage`, and only as a fallback after a failed direct write; see
[Exa usage rollout](#exa-usage-rollout).

The consumer reads the tag before anything else:

| Body | Writer call | ACK on | Retry on |
|---|---|---|---|
| Untagged | Existing LLM writer at `USAGE_WRITER_URL` | Unchanged | Unchanged |
| `enkrypt_usage`, `v: 1`, valid record | `/api/internal/enkrypt-usage/record` with `x-usage-write-source: queue` | `recorded` or `duplicate` whose `usageId` equals `record.id` | Any other response, including a wrong or missing id echo, HTTP 429 and 503 |
| `exa_usage`, `v: 1`, valid record | `/api/internal/exa-usage/record` with `x-usage-write-source: queue` | `recorded` or `duplicate` whose `usageId` equals `record.id`, or `rejected` for the same id, which means the writer resolved no payer, recorded nothing, and the message is not redelivered | Any other response, including a wrong or missing id echo, HTTP 429 and 503 |
| `enkrypt_usage` or `exa_usage`, `v: 1`, invalid record or extra key | None | Never | Conservative retry (`invalid_event`) |
| Any other `kind`, or another `v` | None | Never | Conservative retry (`unsupported_kind`) |

A message that never ACKs exhausts the shared 20-retry budget and goes to the DLQ,
so the DLQ can hold all three kinds. A recognized admission 429 takes the admission
retry schedule. Only the explicitly marked class-only rejection is exempt from invocation failure.
The invocation launch budget is shared. Consumer settings are unchanged. On the
writer, these queue writes take the `non_llm` admission class described under
[writer admission protection](#writer-admission-protection); its ceiling rejection
is a recognized `queue_limit` 429.

"Consumer settings" above means the existing shared consumer, which keeps its settings and still
drains tagged messages published to it. With the cutover switch on, new tagged traffic has its
own consumer, cap and launch budget on the dedicated queue; with it off, new tagged traffic still
uses this shared consumer (the global source after a routing rollback). See
[Dedicated tagged queue](#dedicated-tagged-queue-enkrypt-and-exa-fallback).

The Enkrypt and Exa writer URLs are `USAGE_WRITER_URL` with its documented
`/api/internal/usage/record` suffix replaced by the kind's path, so no new
variable is needed. If `USAGE_WRITER_URL` is missing or does not end with that
suffix, tagged messages retry as `missing_config` without network I/O. The writer
credential, bypass and 160-second timeout are shared.

Tagged messages add `usage_kind` to `usage_ingest_handler_entry`,
`usage_ingest_processing` and the writer helper logs (`usageKind` there):
`enkrypt_usage`, `exa_usage`, or `unknown` for an unrecognized tag (the raw tag is
not logged). Untagged LLM logs keep exactly their existing fields, so filter LLM-only
counts with a missing `usage_kind`. Tagged logs carry only the usage id and kind: no
payer, user, session, cost or `occurredAt`-derived age.

Deploy order: this consumer first, then the ingress, then the producer (the Exa
producer publishes only with a valid publisher configuration). Never roll the consumer back to a version that does not route a kind
while messages of that kind may be in flight or retrying: such a consumer retries
them as invalid or unsupported events and they reach the DLQ after 20 retries. In
particular, never roll back to a consumer from before Exa routing while Exa
messages may be queued. To stop tagged traffic, roll the producer back — revert the
Enkrypt source, or remove the web app's Exa publisher configuration or revert its producer
source as described in Exa usage rollout — and let the consumer drain.

## Observability

`usage_record_completion` is a persistence event for lasting
diagnosis and log-derived counts/latency. `entrypoint` is `gateway`,
`writer_endpoint`, or `unknown`; `writer_caller` is `queue`, `queue_vercel`,
`region_handoff`, or `unknown`. These finite fields separate concurrent paths:

| Persistence path | `entrypoint` | `writer_caller` |
|---|---|---|
| Frankfurt gateway direct write or SFO local fallback | `gateway` | `unknown` |
| Queue consumer through HTTP writer | `writer_endpoint` | `queue` |
| Retired staging Vercel queue consumer, in older deployments only | `writer_endpoint` | `queue_vercel` |
| SFO gateway handoff through HTTP writer | `writer_endpoint` | `region_handoff` |
| HTTP writer without a classified caller, including classifier/grader writes | `writer_endpoint` | `unknown` |
| Unclassified local caller | `unknown` | `unknown` |

The Queue consumer explicitly opts into `x-usage-write-source: queue`; the SFO
handoff client sets `region_handoff`. Other shared-client users, including the
classifier and benchmark grader, omit the marker. After internal API authentication,
the writer route accepts only `queue`, `queue_vercel`, or `region_handoff`; missing
or other values map to `unknown` without logging the raw header. This is caller-supplied diagnostic
context, not an authorization or accounting input. Older clients remain compatible.
The staging Vercel queue prototype is retired and new gateway builds no longer
publish to it. The writer keeps accepting `queue_vercel` so older staging
deployments that still contain its consumer can finish any retained work.
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
these deadlines. Non-retry calls retain one two-second attempt. Every attempt reuses the same serialized
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

### Publisher attempt timing

The Cloudflare HTTP publisher writes one `usage_publisher_attempt` JSON line at
`info` level for each attempt that completes. It adds no request, retry, timeout,
budget or response change. Fields, with times in milliseconds from
`performance.now()`:

| Field | Meaning |
|---|---|
| `usage_id`, `execution_region` | The published usage ID and Vercel function region, as on the other publisher logs |
| `usage_kind` | `enkrypt_usage` on Enkrypt publications to `/enkrypt-usage`, whose `usage_id` is the Enkrypt record id; omitted for LLM usage, as on the other publisher logs |
| `attempt`, `max_attempts` | 1-based attempt number; `max_attempts` is 4 with retries and 1 for a single-attempt call |
| `accepted` | The attempt received HTTP 202 |
| `attempt_end` | `response_headers`, `timeout` (its abort signal fired) or `network_error` |
| `http_status` | The actual status, only when `attempt_end` is `response_headers` |
| `reason` | The existing categorical reason (`http_<status>`, `timeout`, `request_failed`) when not accepted |
| `duration_ms` | Just before `fetch` to response headers, or to the error or abort reaching the publisher. It includes local scheduling delay and never waits for the body |
| `timeout_ms` | The abort window this attempt used, after clipping to the remaining budget |
| `remaining_budget_ms` | Retries only: what was left of the 40 s budget when the attempt started |
| `start_offset_ms` | Publication start, after serialization when the budget clock starts, to this attempt's start |
| `prior_backoff_planned_ms`, `prior_backoff_elapsed_ms` | Later attempts only: the jittered sleep chosen and the measured sleep. Elapsed above planned is timer or runtime delay |
| `sample_rate` | `0.01` for a sampled fast acceptance, otherwise `1` |

Coverage: an attempt that was not accepted, any attempt after the first, and any
attempt that took at least 1,000 ms are always logged. A first attempt accepted in
under 1,000 ms is logged only when a stable hash of its usage ID falls in a nominal
1% bucket, the same method as the consumer's delivery baseline. That is at most one
line per attempt, four per publication, and about 1% of publications plus every
slow, failed or retried attempt. The rows are not a uniform sample: weight fast
rows by `1 / sample_rate` and do not read either subset as population percentiles.
An attempt cut off by a process kill writes nothing. Configuration failures make no
attempt and log nothing new. If writing the line
throws, the publisher reports a Sentry warning tagged `usage_publisher_attempt_log`
and the publication continues with its existing outcome.

To join a publication to ingress, select these lines by `usage_id` and the
`usage_ingest_enqueue_start`, `usage_ingest_enqueue` and
`usage_ingest_enqueue_observed` events with the same `usage_id`. Each attempt that
reached the Worker has its own ingress start. Order them by time but do not
subtract timestamps across hosts as exact durations. Enkrypt attempts join the
`/enkrypt-usage` start and enqueue events on both `usage_id` and `usage_kind`. An
accepted attempt is queue acceptance only; for LLM usage `usage_record_completion`
is the persistence signal.

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
OpenTelemetry export destination: Logpush would ship every publish and consume
invocation of this billing hot path to Axiom (about 14 million publish invocations
a day at the Nov 12 rate below), so the STS canary's Axiom signal comes from the
web side instead ([STS canary](#sts-canary)).
Each selected persistence attempt adds one completion line; IDs remain log
fields, not metric labels. Logs can be dropped, and are not durable accounting:
reconcile against persisted usage rows when exact completeness matters.

[Workers traces](https://developers.cloudflare.com/workers/observability/traces/)
are off in both environments (`observability.traces`, inherited by `env.staging`).
The Worker used to persist a 5% head sample; the repo rule for Workers that bind
STS (`services/sts/test/repo/worker-configs.test.ts`: a trace records outbound
URLs) keeps them off since the STS canary binding was added, so there are no
fetch, queue or `queue_send` spans and writer timing comes only from the logs above.

## Queue policy

EU consumers use batch size 6 in production and 2 in staging, with at most
two writer slots per invocation. Global hedge and dedicated tagged (Enkrypt and Exa fallback) consumers use
batch size 1 and can use only one slot:

| Consumer setting | Value | Purpose |
|---|---|---|
| `max_batch_size` | EU: `6` in production, `2` in staging; global hedge and Enkrypt: `1` in both | Maximum messages delivered per invocation. |
| `max_batch_timeout` | `0` seconds | No intentional wait to fill a batch. |
| `max_concurrency` | `225` in production, `200` in staging; tagged: `50` in production, `10` in staging | Parallelism 2 allows at most `225 × 2 = 450` concurrent queue writer calls in production and `200 × 2 = 400` in staging. The [stall hedge](#stall-hedge-to-the-global-queue) consumer has cap `25` and adds `25 × 1 = 25`, for bounds of `475` / `425`. The [tagged consumer](#enkrypt-usage-queue) adds `50 × 1 = 50` in production and `10 × 1 = 10` in staging, for combined bounds of `525` / `435`. These are configured ceilings on concurrent writer HTTP calls, not database connections or measured capacity. |
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
siblings retain their ACKs. Shared HTTP 429/503 overload feedback still rejects
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

For recognized admission 429 on native attempt 1, choose an integer uniformly
from 1 through 4, inclusive. Otherwise, for native attempt `a`, calculate
`base = min(300, 2 ** min(a - 1, 9))`; for all failures except recognized
admission 429, use `base = max(60, base)`. Choose an integer uniformly from
`base` through `2 * base`, inclusive. Positive safe-integer attempts are capped
at 21 before exponentiation; invalid metadata uses attempt 1. Mixed failure classes
share the same native count; switching classes never resets it.

| Native attempt | Recognized admission 429 | Other handled failure |
|---|---|---|
| 1 | 1–4 s | 60–120 s |
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
delays sum to 63m 31s–127m 04s; for only other handled failures, 68m 28s–136m 56s.
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
[Retention](#retention). Before guard rollout, confirm the
[dead-letter alert](#dead-letter-alert) is deployed, and confirm replay ownership
and a controlled stable-ID reconciliation/replay procedure. A safe rollback must
**not lower retries back to 3 while higher-attempt messages remain outstanding**,
because their next failure could immediately dead-letter them. Preserve stable IDs
and reconcile ambiguous writes before replay; do not republish to reset attempts
or discard accepted events.

No new environment knob or worker binding
is introduced. This preparation does not claim a healthy-traffic p95 improvement
or authorize a production rollout, capacity increase, or replay.

### Writer admission protection

The Frankfurt LLM HTTP writer (`/api/internal/usage/record`) authenticates and
validates the request before applying one admission guard to `queue` and
`queue_vercel` callers. Both transports share a
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
own counter/pool. An admitted call can still wait. The LLM primary pool maximum
stays at 10. Consumer concurrency, parallelism, batch size, retry settings and
queue selection are unchanged by writer isolation. There is no new environment
knob; the change reaches the writer through its normal deployment.

Queue writes to the Enkrypt writer (`/api/internal/enkrypt-usage/record`) and the Exa
writer (`/api/internal/exa-usage/record`) instead use `taggedWriterAdmission`, an
independent per-runtime gate, as writer class `non_llm`. The two routes share a
**two-write** budget when co-located in one runtime. Their admitted transactions
use `taggedWriterDb` and a dedicated primary pool with maximum **2** connections,
not the LLM pool. All eight LLM admissions remain available while both tagged
slots are held. An excess tagged call immediately receives the compatible HTTP
429 body with reason `queue_limit`, without writing or entering the LLM FIFO.

The tagged pool opens connections on demand, keeps the existing connection
timeout and five-second idle timeout, and participates in Vercel suspension
cleanup. In a co-located runtime the primary connection envelope is **12**
(10 LLM/general plus 2 tagged), with replica pools additional and unchanged.
Across N runtimes using the tagged pool, this can add up to **2N** connections.
Separate function instances each have their own gate and pool: this is not a
fleet-wide two-write limit. Deployed function mapping has not been verified;
the regression proves independence even with co-location. This is not a measured
production capacity increase. PostgreSQL row locks and server/pooler capacity
remain shared. Direct and regional handoff writes retain the general primary
pool; post-commit background work also retains its existing behavior.

At the tagged ceiling, a consistent pool snapshot with zero waiting clients
marks the rejection class-only (`x-usage-class-limit: non_llm`), including when
both tagged connections are checked out. Missing or inconsistent gauges leave
the rejection unmarked. Actual pool waiting/busy rejection remains distinct
from this class ceiling. Older consumers ignore the header and the 429 body
stays compatible. During an authorized rollout, compare backlog slope, native
invocation exception ratio and concurrency with both pools' waiting and LLM
429s. Halt rollout if shared database pressure rises or backlog growth and
exceptions worsen. A lower exception ratio alone does not establish recovery.
The Cloudflare consumer cap is a separate control; it does not reserve these
writer slots or connections.

The executable contract is the [co-location regression](../../apps/web/src/app/api/internal/usage/record/usage-writer-admission.test.ts),
run with `pnpm --filter web test --runInBand usage-writer-admission`. It holds both
tagged transactions, checks their actual connection application names, and
verifies all eight LLM admissions and the tagged class-only rejection.

`usage_writer_admission` diagnostics sample admitted decisions at 1% and warn on
all rejected decisions. Fields contain only the bounded caller/outcome/reason,
`writer_class` (`queue` or `non_llm`), active count/limit, `active_non_llm` and
`non_llm_limit`, pool gauges/max, and sample rate; diagnostic failures cannot
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

## Main queue backlog alert

The o11y Worker's existing every-minute scheduled evaluator independently reads
native backlog metrics for the exact production queue `usage-ingest-processing-eu`,
without relying on consumer logs. It resolves the current queue ID by exact name
on every run with a bounded paginated lookup. Lookup or metrics failures fail the
run rather than reporting an empty queue; other infrastructure checks still run.

The main usage queue raises a ticket at 25,000 pending messages and one page
on the first observation at or above 50,000. The page threshold is always 50,000,
even if the first observation is much higher. While that page is active, no
higher count triggers another page. Three consecutive observed readings below
50,000 re-arm paging; any reading at or above 50,000 resets that recovery streak.
The next crossing can then page again. These metric observations only re-arm
the alert detector; they do not resolve the actual on-call incident. On-call may
fix the underlying issue before queue depth drops. The outgoing Slack webhook
cannot read or follow manual incident state, so manually resolving an incident
while the backlog stays high does not trigger more pages. There is no manual
reset UI or incident-system integration. Tickets retain their existing
25,000 threshold and three-below-threshold re-arm policy. State is isolated by
queue ID, and failed notifications leave state unchanged so the next tick retries.
The generic ingest-queue monitor retains its existing 100,000-message page
escalations; this once-per-episode page policy applies only to the main usage queue.
These are count thresholds, not a backlog growth-rate detector or accounting SLO.
The existing ingest-queue monitor and usage DLQ alert remain separate.

Tickets use `O11Y_SLACK_WEBHOOK_TICKET`; pages use `O11Y_SLACK_WEBHOOK_PAGE`.
Activation occurs on the next normal o11y deployment after merge. The existing
`O11Y_CF_CONTAINERS_API_TOKEN` must already have Queues Read access to this
account, including queue listing and metrics. No new secret or configuration is
needed. Deploying while the backlog exceeds a threshold may alert immediately;
this documentation does not establish that any live alert has been sent.

The alert includes queue name and ID, pending count, bytes, oldest-message
timestamp when available, severity and threshold. When it fires, compare count
and oldest-message age across observations, check consumer delivery/errors and
writer admission/latency, then inspect the [dead-letter alert](#dead-letter-alert).
Coordinate incident ownership before changing controls or replaying messages.
A falling count alone does not establish accounting reconciliation.

## Dead-letter alert

The alert covers every usage kind: LLM, Enkrypt and Exa on the shared queue, and
Enkrypt and Exa fallback on the dedicated tagged queue.

### What it watches

The o11y Worker's every-minute cron (`services/o11y/src/alerting/`) reads the
realtime backlog of each production DLQ: `usage-ingest-processing-dlq-eu` and the
dedicated tagged queue's `usage-ingest-enkrypt-dlq-eu` (Enkrypt and Exa fallback). A DLQ has no consumer, so
its backlog is exactly the dead-lettered messages still retained, and it only grows
when a message dead-letters. That backlog is the authoritative signal.

o11y finds each queue by exact name on each run (`DEAD_LETTER_QUEUE_NAME` and
`ENKRYPT_DEAD_LETTER_QUEUE_NAME` in
`services/o11y/src/alerting/dead-letter-queue.ts`), then calls the Queues metrics
API, using its existing `O11Y_CF_CONTAINERS_API_TOKEN` with Queues Read. Each DLQ
has its own alert state and cooldown, and a failed lookup of one does not skip the
other. Tests in this service fail if either name drifts from its consumer's
`dead_letter_queue` in `wrangler.jsonc`. On an EU/global routing rollback, change the shared
DLQ in both places; the tagged pair stays in EU, so `ENKRYPT_DEAD_LETTER_QUEUE_NAME` stays
unchanged. The hedge
queue's global DLQ, `usage-ingest-processing-dlq`, and staging's DLQs are not
watched while the hedge is an experiment.

It alerts when the backlog rises above the lowest backlog seen since the last
alert: the first dead letter, more dead letters, or new ones after a replay or
expiry. An alert repeats at most once per 4-hour ticket cooldown, and an unchanged
or shrinking backlog never alerts. A lookup or API failure fails that run, which is
reported like other o11y evaluation errors, without blocking the other alerts.

The consumer also logs one `usage_ingest_final_attempt_failed` line at
`console.error` when delivery 21 (above `max_retries` 20) is not acknowledged and
is retried, which dead-letters it. Earlier failed deliveries and acknowledged
deliveries log nothing. It is a triage aid in Workers Logs, not the alert: it
gives the usage IDs to reconcile, but logs can be dropped and a killed invocation
dead-letters without it.

| Field | Value |
|---|---|
| `queue` | Source queue name |
| `usage_kind` | `llm`, `enkrypt_usage`, `exa_usage`, or `unknown` for another `kind` tag |
| `usage_id` | Usage ID, only when the message body validates |
| `queue_message_id`, `delivery_attempts` | Queue message identity |
| `reason` | Categorical processing reason, or `unexpected_error` |

### Where it goes

The alert has severity `ticket` (`DEAD_LETTER_QUEUE_SEVERITY`), so o11y posts it
to the `O11Y_SLACK_WEBHOOK_TICKET` webhook, which `services/o11y/wrangler.jsonc`
requires to deliver to #kilo-o11y-alerts. It does not page. Changing the severity to
`page` would route it to `O11Y_SLACK_WEBHOOK_PAGE`, with o11y's other page alerts,
and shorten the cooldown to 15 minutes.

It goes live with the next o11y deployment; no operator step or new credential is
needed. If a DLQ already holds messages then, the first run alerts once. Until the
tagged DLQ exists, its lookup fails each run and is reported as an o11y evaluation
error without blocking the other alerts. The automatic workflow deploys changed Workers in
parallel, so expect those errors until usage-ingest preparation has created the DLQ; errors
that continue after that mean the DLQ is missing.

### Who receives it

Whoever triages #kilo-o11y-alerts, who hands it to the DLQ replay owner:
**`<replay owner, to be named>`**. On an alert, find the usage IDs from
`usage_ingest_final_attempt_failed` in Workers Logs for `usage-ingest`, reconcile
by stable usage ID, and replay only as described under [Queue policy](#queue-policy),
within the DLQ's retention.

## STS canary

usage-ingest and the web app are the STS pilot pair (decision D6c in the secrets and tokens
design, section 4.4 "When STS is down"): each mints a service token for the other and verifies
the other's token, every 5 minutes, in production and staging. It is a synthetic check on real
deployments; no usage publish or consume code, queue or credential takes part in it.

One run (`scheduled`, cron `*/5 * * * *` at the top level and in `env.staging`):

1. Skipped entirely unless `STS_CANARY_ENABLED` is exactly `"true"` (on in both environments;
   set any other value to stop it).
2. Gets a `web:sts.canary` token from `@kilocode/service-token-client` over the `STS` service
   binding (`SecretsBroker`, `props.caller: "usage-ingest"`; `sts` in production, `sts-staging` in
   staging). The token lives 300 s and renews at 240 s, so a warm isolate mints at most about once
   per run.
3. Posts to `WEB_STS_CANARY_URL` with `Authorization: Bearer <token>` and `x-sts-canary-run:
   <run id>`; it adds `x-vercel-protection-bypass` whenever the optional
   `USAGE_WRITER_PROTECTION_BYPASS` secret is set, which only staging needs (production must leave
   it unset). The web route verifies the token (`web:sts.canary`),
   mints `usage-ingest:sts.canary` with its Vercel identity, calls `POST /sts-canary/verify` here
   (expect 204), presents the `web` token it received (expect 403 `insufficient_scope`), the same
   claims signed by a key STS never held (expect 401) and, when the instance holds one, an earlier
   token past `exp` plus 60 s (expect 401, else `skipped`), and answers a report
   (`StsCanaryReportSchema` in `@kilocode/sts-contracts`; each `detail` at most 200 characters).
   Every call that carries a token or the bypass secret uses `redirect: 'manual'`: a 3xx fails
   the check (web side) or the run (`StsCanaryWebRefused` here), and is never followed.
   usage-ingest waits 80 s for the answer: the route's slowest run is a 5 s key-set fetch, a
   30 s mint attempt (both tries after an identity refusal end within it) and four 10 s calls
   here, 75 s, and its `maxDuration` is 90 s.
4. Writes one `scheduled_job.completed` line (job `usage_ingest.sts_canary`): `outcome`
   `succeeded` only when every check passed, with `mint_result`, `web_status`, and
   `<check>_result`/`_status` for `outbound`, `negative_wrong_audience`, `negative_forged` and
   `negative_expired`. The report's `detail` text is never copied: it comes from another service,
   and the web route's own line carries it. A failure carries `exception_name`:
   `ServiceTokenError` (STS refused or failed the mint; `mint_detail` names the reason),
   `StsCanaryWebRefused` (the web route answered other than 200), `StsCanaryReportInvalid`,
   `StsCanaryCheckFailed` or `StsCanaryNotConfigured`. No token appears in any log line.

`POST /sts-canary/verify` is matched before the publish routes and their 404 guard. It verifies
the bearer token with `@kilocode/verify` (issuer `STS_URL`, environment `STS_ENVIRONMENT`,
audience `usage-ingest`, scope `usage-ingest:sts.canary`, key set from `STS_URL` over HTTPS) and
answers 204 or the section 7 refusal (401 `invalid_token`, 403 `insufficient_scope`, 503
`temporarily_unavailable`). It answers 503 while `STS_URL` or `STS_ENVIRONMENT` is not configured
or the two disagree: `STS_ENVIRONMENT` must be the environment `STS_ISSUERS` names `STS_URL` under,
and an issuer outside `STS_ISSUERS` is accepted only on loopback for `development` (the runtime
test's stand-in). Each
outcome logs `sts_canary_verify_accepted` or `sts_canary_verify_refused` (status, error, reason,
the run id), never the token. The route works whether or not the flag is on.

| Var | Production | Staging |
|---|---|---|
| `STS_CANARY_ENABLED` | `"true"` | `"true"` |
| `STS_URL` | `https://sts.kiloapps.io` | `https://sts-staging.kiloapps.io` |
| `STS_ENVIRONMENT` | `"production"` | `"staging"` |
| `WEB_STS_CANARY_URL` | `https://app.kilo.ai/api/internal/sts-canary` | `https://staging-app.kilo.ai/api/internal/sts-canary` |

Binding STS turns `observability.traces` off in every block (see [Observability](#observability));
Workers Logs stay on and carry the `scheduled_job.completed` and `sts_canary_verify_*` lines.
There is no Logpush: it is a setting of the whole Worker and would send every billing publish
and consume invocation to Axiom.

The Axiom signal is the web route's line instead. Every run the route answers logs one JSON line
(`event` `sts_canary`, `step` `report`, `outcome` `succeeded` or `failed`, `run`, `caller`,
`inbound`, `outbound` and `negatives` with each check's `result`, `status` and `detail`; never a
token). The route writes it only after it verified the caller's `web:sts.canary` token, so other
traffic never produces it. A request the route refuses logs `event` `sts_canary_refused` (`run`,
`status`, `error`, `reason`) instead, for diagnosis only: anyone can call the route, so no monitor
reads it. The Vercel log drain carries both to the Axiom dataset `vercel` (`vercel.projectName`
`kilocode-app`, `request.path` `/api/internal/sts-canary`, `request.host` `app.kilo.ai` or
`staging-app.kilo.ai`; the line is in `message`). Page with two Axiom threshold monitors per
environment on `sts_canary` lines, notifying the existing alert route:

- no line with `outcome` `succeeded` in 15 minutes;
- any line with `outcome` `failed` in 15 minutes.

A run whose call never reaches the web route (usage-ingest down, usage-ingest's own mint denied
or failed, a network failure, a redirect) writes no web line, and a run the route refuses writes
only `sts_canary_refused`; both show as a missing success.

The expired-token check runs only when a run reaches a web instance that still holds a token
from at least two runs earlier (past `exp` plus 60 s); a run on a fresh instance reports it
`skipped` and still succeeds. A third monitor per environment tracks that the check still runs,
and alerts the same route without paging: no `sts_canary` line whose `negatives.expired.result`
is `ok` in 24 hours.

### Cost

A token lives 300 s and renews at 240 s, and a held token stops being served 30 s before `exp`,
so with a run every 300 s each side mints once per run, warm or cold. Per run and environment:

| Item | Per run | Per day (288 runs) |
|---|---|---|
| usage-ingest invocations | 1 scheduled + 3 verify-route calls (4 once the web instance holds a token past `exp` + 60 s) | 288 + 864 to 1,152 |
| Web function invocations | 1 | 288 |
| STS mint calls | 2: one RPC over the binding (usage-ingest), one `POST /v1/token` (web); each one signer Durable Object request | 576 |
| STS audit rows | 2 `token.issued` (a denial adds one `token.denied`) | 576 |
| Audit queue messages | at most 2; the signer relays up to 500 events per message, so usually they share one with other rows | at most 576 |
| STS key-set fetches | one per verifier isolate per 5 minutes: each usage-ingest isolate that serves a verify-route call and each web instance that serves the route fetches once when its copy is older than 5 minutes. The 3 or 4 verify calls and the scheduled run can land on different isolates, so a run can cost several. The forged token keeps a real `kid`, so it causes no unknown-`kid` refresh | at most (usage-ingest isolates + web instances) x 288 |
| Vercel token exchanges | at most 1; 0 while the Runtime Cache holds the exchanged token (until 60 s before its `exp`, which is the base token's). When STS refuses (`identity_rejected`) a token the instance took from the cache, the client drops it and exchanges once more, with one more mint, in the same attempt. When STS refuses that fresh token too, the client writes a refusal marker for the deployment and audience that lives 60 s (`DENIED_RECHECK_MS`): until it expires no instance of the deployment drops a cached token or exchanges, each answers from its denied state. A deployment STS keeps refusing (a `web.yaml` naming the wrong project or environment) so costs at most 1 exchange per 60 s per audience and region, however many instances it runs; 17 such deployments spend about 17 of the project's roughly 100 exchanges a minute, a limit previews share with production, where without the marker each could spend about 6 | at most 288; in practice one per base-token renewal or new deployment |
| Vercel Runtime Cache | 0 reads on an instance memory hit, 1 on a cache hit, 4 reads and 1 write on a miss (5 reads and 2 writes for the exchanger), 1 write or up to 2 reads and 1 delete per refusal | at most about 1,700 operations |
| Log lines | usage-ingest (Workers Logs only): 1 `scheduled_job.completed`, 3 or 4 `sts_canary_verify_*`; web (Vercel drain to Axiom): 1 `sts_canary` | about 1,400 in Workers Logs and 288 Axiom rows |

Both environments together double each daily figure, except the Vercel rows: the web app's
staging is a custom environment, whose client keeps the exchanged token in instance memory only
(it may share the preview Runtime Cache partition). Staging therefore makes no Runtime Cache
operation and one Vercel exchange per web instance per base-token renewal.

The client's cost on a real caller does not grow with its request rate. A request that finds a
usable token reads an in-memory entry and makes no network call. Each caller instance makes one
STS call per 240 s for up to 8 audiences it actually calls (one more call per further 8), and
each verifier isolate fetches the key set once per 5 minutes. At one audience per caller:

| Caller instances | STS mint calls (= signer requests = audit rows) | Audit queue messages at 500 events each |
|---|---|---|
| 10,000 | about 42 per second | about 0.1 per second |
| 50,000 | about 208 per second | about 0.4 per second |
| 200,000 | about 833 per second (843 with the 2,200 Vercel instances of design section 6.1) | about 1.7 per second |

A Vercel caller adds one exchange per deployment, audience and base-token renewal, shared through
the Runtime Cache, and one cache read per new instance; in a custom environment, one exchange per
instance, audience and base-token renewal, with no cache read. A deployment STS refuses adds at
most one exchange per minute per audience and region, through the refusal marker.

Staging shares the project's Vercel exchange budget, about 100 exchanges per minute, with
production (proof run 3: the budget is per project or team, not per deployment). Because a
custom environment exchanges once per instance, custom-environment use must stay well below 100
exchanging instances per minute; before any staging hot path adopts the client, either that
holds or encrypted shared entries (design 4.4) come first.

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
`USAGE_INGEST_HEDGE_QUEUE` binds the global stall-hedge queue, which has its own
consumer and DLQ; preparation creates or verifies that pair and never detaches its
consumer. See [Stall hedge to the global queue](#stall-hedge-to-the-global-queue).
`USAGE_INGEST_ENKRYPT_QUEUE` and `USAGE_INGEST_ENKRYPT_DLQ` bind the dedicated tagged
pair for Enkrypt and Exa fallback usage, which has its own consumer; preparation creates or verifies it in EU after the
other pairs and never detaches its consumer. See [Enkrypt usage queue](#enkrypt-usage-queue).

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

## Enkrypt usage queue

The gateway sends Enkrypt guardrail usage through this queue in every region; there is no
rollout selector. It posts the bare Enkrypt usage record to `/enkrypt-usage` on the same
Worker as `/usage`, and the ingress wraps it in the tagged queue envelope. See `ENVIRONMENT.md`.

The producer depends on the gateway accepting an optional `usageId` in Enkrypt handoff
replies, the web app's Enkrypt usage route echoing `usageId` under queue writer admission,
and the writer's small non-LLM admission class plus the consumer that routes tagged Enkrypt
messages and the `/enkrypt-usage` ingress. These shipped ahead of the producer; nothing posts
to the ingress before the producer is deployed.

Rollback: revert the gateway source that makes the queue path permanent and redeploy. New
Enkrypt usage then takes the direct path again, and the consumer drains what the queue already
accepted. Delete the now-unused `ENKRYPT_USAGE_QUEUE_ENABLED` selector from the gateway project
only after the new source is deployed and the old instances have turned over; deleting it while
old code still reads it would flip that code back to the direct path. If rolling back to source
that still reads the selector, reinstate the flag first. Never roll the consumer back to an
LLM-only version while tagged Enkrypt messages may still be in the source queue or in flight:
they would fail every retry and reach the DLQ.

The now-mixed DLQ needs a replay owner whose replay handles both LLM and Enkrypt messages, and
the existing DLQ alerting must cover it.

### Dedicated tagged queue (Enkrypt and Exa fallback)

When the [cutover switch](#cutover-switch) is on, `/enkrypt-usage` and `/exa-usage` each send
their envelope once, only to `USAGE_INGEST_ENKRYPT_QUEUE`. The queue, DLQ and binding names say
Enkrypt because they predate Exa fallback joining the queue; they also carry Exa fallback usage.

| Environment | Source | DLQ |
|---|---|---|
| Production | `usage-ingest-enkrypt-eu` | `usage-ingest-enkrypt-dlq-eu` |
| Staging | `usage-ingest-enkrypt-staging-eu` | `usage-ingest-enkrypt-dlq-staging-eu` |

The pair, its consumer and its DLQ alert are provisioned and attached on every deployment,
whatever the switch says. Authentication, validation, the envelopes, usage IDs and every
response are unchanged. Exa keeps its direct Frankfurt write as the normal path and posts to
`/exa-usage` only when that write fails, exactly as before. A failed or ambiguous send still
returns 503, and the producer resends the same usage ID within its existing publisher budget
(four attempts, 40 seconds) before it logs the record as dropped; there is no later durable
retry. Tagged ingress is never hedged and never falls back from one queue to the other or to a
direct write, including when the switch is on and the dedicated binding is missing. With the
switch on it has no global destination; with it off it uses whatever `USAGE_INGEST_QUEUE` binds,
which is the global source only after a routing rollback. LLM `/usage` keeps `USAGE_INGEST_QUEUE` and its stall hedge to the global
queue, unchanged.

The same Worker consumes the dedicated queue with the same handler, so the writer protocol,
ACK and retry rules, admission and class-only handling, overload invocation failure and the
final-attempt log are identical for both kinds; an exhausted message goes to the tagged DLQ,
while the shared DLQ can still hold tagged messages published to the shared queue. With the
switch on, what changes is the failure domain on the queue side: a tagged batch never contains
LLM messages, so a tagged writer 503 or unmarked 429 (the explicitly marked class-only 429 still
does not fail an invocation) fails only a tagged invocation and only affects Cloudflare's scaling
of this consumer, and tagged backlog and retries do not delay the shared queue. Enkrypt and Exa
fallback do share this queue with each other. It does **not** isolate the writer, its pool or
the database: queue writes still take the writer's `non_llm` admission class (at most 2 of the 8
admitted writes, pool 10, per writer runtime), and tagged writes still touch the same
organization rows as other usage.

Consumer settings: batch `1`, timeout `0`, cap `50` in production and `10` in staging, retries
`20`, `retry_delay` `60`, its own DLQ. The cap is one ceiling shared by Enkrypt and Exa fallback.
These are configured ceilings, not measured database capacity:

- Batch 1 means one tagged write per invocation, so an overload failure covers exactly one
  message, and `USAGE_INGEST_PARALLELISM` has no effect.
- The cap bounds this consumer's concurrent tagged writer calls at 50 in production and 10 in
  staging, across Enkrypt and Exa fallback together. It is not a fleet-wide tagged limit: while
  the switch is off, after a rollback, or while legacy tagged messages drain, the shared
  consumer (up to 450 writer calls, shared with LLM) can process tagged messages at the same
  time. Writer admission is unchanged: a call beyond a writer runtime's `non_llm`
  ceiling gets the marked class-only 429 and retries on the admission schedule without failing
  the invocation. How many of those 50 calls the writer and database actually complete at once
  depends on writer runtimes and database load, which this ceiling does not measure.
- A renewed Enkrypt surge, or a burst of Exa fallback during a direct-write outage, beyond what
  that allows shows up as backlog in this queue rather than as concurrent writes on the shared
  consumer. The cost is accounting latency for both kinds under such a burst: the backlog is
  retained for the four-day source retention, and Cloudflare may run fewer invocations than the
  cap. Changing the cap is a separate, measured decision.
- Retries and `retry_delay` match the shared consumer, so the retry budget and delivery 21 as
  the final attempt are unchanged.

### Cutover switch

`USAGE_INGEST_DEDICATED_TAGGED_QUEUE_ENABLED` is an optional Worker environment string.
Exactly `true` sends both tagged routes to the dedicated queue. Absent, `false` or any other
value sends them to `USAGE_INGEST_QUEUE`, which is the shared EU source, or the global source
after a routing rollback. It only selects the producer's queue: both consumers, the dedicated
pair's preparation and its DLQ alert stay in place for every value, and it never affects LLM
`/usage`, the hedge or Exa's direct write.

It is a plaintext `vars` entry in `wrangler.jsonc`, so the normal code deployment of each
environment applies it and Git review owns every change:

| Environment | Worker | Committed value | Tagged route |
|---|---|---|---|
| production | `usage-ingest` | `"true"` | `usage-ingest-enkrypt-eu` |
| staging | `usage-ingest-staging` | `"true"` | `usage-ingest-enkrypt-staging-eu` |

Staging does not inherit top-level `vars`, so each environment states its own value, and
`src/queue-budget.test.ts` pins both. Change it only in `wrangler.jsonc`, not in the dashboard:
a deployment replaces dashboard plaintext variables with the committed `vars`. See Cloudflare's
[source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)
notes.

The same name must not also exist as a Worker **secret** binding. An earlier version of this
runbook set the switch as a dashboard secret, and normal deployments keep secrets, so a leftover
secret would sit beside the committed var under one binding name. Do not rely on either value
winning; Cloudflare is expected to reject the upload for the duplicate binding name. Before the
first deployment that carries the committed value in an environment, check both
`wrangler versions secret list` (deployed versions) and
`wrangler versions secret list --latest-version` (the latest uploaded version, whose secrets the
next deployment carries forward); add `--env staging` for staging. Secret values are never
shown, only whether a binding exists. If either lists
`USAGE_INGEST_DEDICATED_TAGGED_QUEUE_ENABLED`, remove it before that deployment with
`wrangler secret delete USAGE_INGEST_DEDICATED_TAGGED_QUEUE_ENABLED` (`--env staging` for
staging), which deploys a version without it at once, so tagged routing falls back to the
shared queue until the code deployment applies the committed value. Then repeat both listings
and confirm neither shows it. Do not register the name as a required secret.

To confirm a change is live, check that the version created by that deployment is the
one serving 100% of traffic on the Worker's **Deployments** page, or with
`wrangler deployments status` (`--env staging` for staging).

### Rollout

One change commits `"true"` for staging and production together. **Do not merge it** until the
dedicated consumer's attachment is verified in both environments, the separate stall alert on
the production dedicated source is deployed and verified, and neither Worker has a same-name
secret binding. A deployment with the switch not `true` provisions and attaches the dedicated
infrastructure and keeps the existing producer routing.

1. Before each environment's first deployment that carries the committed switch, confirm no
   same-name secret binding exists there, and remove it if one does, as described under
   [Cutover switch](#cutover-switch).
2. Deploy usage-ingest normally. Preparation inspects every queue, then creates or reuses the
   dedicated DLQ (EU, 14-day retention, no consumer, read back) and then the source (EU,
   at least the four-day default retention, read back), after the shared and hedge
   pairs, and detaches nothing. It stops before any write if an existing member fails those
   checks or the source's `delivery_paused` value is explicitly `true` or malformed. An omitted
   `delivery_paused` response or explicit `false` is accepted; omission is API-shape compatibility,
   not proof of active delivery. Operator verification of attachment and the production source
   stall alert below still gates merging the switch-on change.
   Wrangler then uploads the Worker with provisioning disabled and attaches the dedicated
   consumer beside the existing two. With the switch not `true`, tagged usage still goes to the
   shared queue.
3. o11y deploys from the same merge, possibly in parallel, and enrolls the production tagged
   DLQ in the [dead-letter alert](#dead-letter-alert); its tagged DLQ evaluation errors until step
   2 has created the DLQ. If the o11y deployment fails while usage-ingest succeeds, the tagged DLQ
   is unwatched until o11y is redeployed; rerun its deployment.
4. Read back, read-only, in each environment: both dedicated queues exist with jurisdiction
   `eu`; the DLQ has no consumer and `message_retention_period` `1209600`; the dedicated source
   is not paused, keeps at least `345600` seconds, and has exactly one consumer, the
   `usage-ingest` (or `usage-ingest-staging`) Worker, with the settings above; the shared and
   hedge consumers are unchanged.
5. Deploy the separate stall alert on `usage-ingest-enkrypt-eu` and verify it, for example that
   it fires on a stalled source and stays quiet on an empty one. The queue already exists after
   step 2; no manual preparation is needed.
6. Immediately before merging the change that commits `"true"` for both environments, repeat
   step 1 in both. After merge, the normal staging and production deployments apply it; confirm
   each new version serves 100% of traffic. Then verify processing in each environment:
   `usage_ingest_processing` lines with `usage_kind` `enkrypt_usage` or `exa_usage` show
   `queue: "usage-ingest-enkrypt-staging-eu"` in staging and `queue: "usage-ingest-enkrypt-eu"`
   in production, with `queue_action: "ack"`.

Instances that started before the switching deployment can still publish to the previous queue
while traffic turns over; both consumers process them. Tagged messages on the shared queue keep
their processing there, with unchanged idempotency and dispositions. No new shared
`enkrypt_usage` or `exa_usage` processing for longer than the source retry window (see
[Retention](#retention)) is only a supporting signal: a paused or backlogged consumer is also
silent, and logs can be dropped. Before treating them as drained, also confirm from queue state
that the shared consumer is attached and healthy and the shared backlog has turned over since
the switch. Nothing moves, purges or replays messages between queues.

### Replay identity and partial failure

The Enkrypt and Exa writers each deduplicate on the pair `record.id` and `record.occurredAt`, so
a copy delivered from either queue, or replayed from either DLQ, settles as `duplicate` with no
second charge only when both are unchanged. A copy with the same `id` and a different
`occurredAt` creates a new ledger row and can charge again, depending on the payer. A replay
must resend the original record unchanged; any queue whose consumer runs this Worker processes
it.

- Preparation fails: nothing is uploaded and the previous version keeps running. Rerun after
  fixing the error; created queues are reused.
- Upload fails after preparation: the new queues exist with no producer or consumer, which is
  harmless. Rerun.
- Preparation stops because the dedicated source is paused: resume its delivery deliberately
  (only after confirming why it was paused), then rerun the deployment. Preparation never
  resumes it. A present malformed `delivery_paused` value also stops preparation; investigate the
  response before rerunning. An omitted value or explicit `false` is accepted, but omission does
  not prove active delivery or waive attachment or production source stall alert verification
  before merging the switch-on change.
- The Worker uploads but the dedicated consumer is not attached: with the switch on, tagged usage
  waits undrained in the dedicated source for up to its retention. Commit `"false"` for that
  environment and deploy it, then rerun the deployment and repeat the readback before turning the
  switch back on.

### Rollback

To move tagged usage back to the shared queue, commit `"false"` for that environment in
`wrangler.jsonc` and deploy it normally; do not add a secret or dashboard variable instead. Keep
the dedicated consumer and its alert active so work the queue already accepted drains. Only the
switch value changes; do not revert the queue routing code.

Do not revert this change, or deploy a revision without the dedicated consumer, while the
dedicated queue or its retries may hold messages: that revision does not declare a consumer for
the queue, and whether an existing attachment survives is not relied on. Remove the consumer only
after the dedicated source shows a zero backlog and no retries remain, in a later change, and
never delete the queues.

The dedicated source has no backlog alert in this change; only its DLQ is watched. Staging DLQs
are not watched, as for the shared queue.

## Exa usage rollout

Exa usage keeps its direct Frankfurt write as the normal path. The queue is only a durable
fallback, published to the queue the [cutover switch](#cutover-switch) selects: when the direct write fails, the web app posts the same bare record, with the same
`id` and `occurredAt`, to `/exa-usage`, and the ingress wraps it in the tagged envelope. The
Exa writer is idempotent by the `id`/`occurredAt` pair, so a queued copy of a write that did
commit returns `duplicate` and makes no second debit; a replay must keep both values. The
`kilocode-app` producer publishes whenever its `USAGE_INGEST_URL` and
`USAGE_INGEST_PUBLISH_SECRET` form a valid publisher configuration; it has no rollout selector.

The consumer that routes tagged Exa messages and its `/exa-usage` ingress, together with the
web app's Exa writer taking the `non_llm` admission class for queue writes, must be deployed
before any `kilocode-app` deployment whose publisher configuration is valid.

Rollback: remove the web app's publisher configuration and redeploy, or revert the producer
source change and redeploy with `EXA_USAGE_QUEUE_FALLBACK_ENABLED` absent or not `true`; the
reverted source still publishes whenever that value is `true`. Failed direct writes then stop publishing, and the consumer drains what the
queue already accepted. Never roll the consumer back to a version without Exa routing while
Exa messages may still be in the source queue or in flight: they would fail every retry and
reach the DLQ.

The shared DLQ and the tagged DLQ need a replay owner whose replay handles LLM, Enkrypt and Exa
messages, and the existing DLQ alerting covers both.

## Retention

Each selected DLQ, including the global stall-hedge DLQ and the dedicated tagged DLQ, keeps messages for
**14 days (1209600 seconds)**, Cloudflare's maximum. Retention is a property of the queue resource, and `wrangler.jsonc`
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

Source queues, including the dedicated tagged source, keep Cloudflare's default of
four days (345600 seconds), which the helper does not change. That is far longer than the source retry window: 20
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

## Stall hedge to the global queue

### Why

Production, Nov 12 12:30–13:15 UTC (Axiom writer, admission and publisher-attempt
logs): 16,263 LLM usage events, 3.8% of traffic, took over 5 s to be recorded. 87.5%
of them had a `Queue.send` of 1 s or more on `usage-ingest-processing-eu`; 4.5%
involved a writer admission rejection. 79% of sends that took 5 s or more started in
two-second intervals where at least 90% of all sends were slow (84 s of the 46
minutes), in both gateway regions equally. Correlated queue-send stalls dominate this
observed tail. They are not shown to be total for the queue: earlier exact traces had
later same-queue retries accepted while the original send stayed stalled. A second
queue may reduce these stalls; that it behaves independently of the first is the
hypothesis to test, not an established fact. When the second queue accepts first, its
acceptance is used. No production benefit is claimed until it is measured as
described below.

### Behaviour

Only LLM usage on `POST /usage` is hedged. `/enkrypt-usage` and `/exa-usage` are
unchanged. Authentication, body reads and schema and size checks run first, as before.

| Variable | Values | Default |
|---|---|---|
| `USAGE_INGEST_HEDGE_MODE` | `on` enables the hedge; any other value, or none, is `off` | `off` |
| `USAGE_INGEST_HEDGE_DELAY_MS` | Whole milliseconds, clamped to 250–10000 | `1000` when missing or not a whole number |
| `USAGE_INGEST_HEDGE_PERCENT` | Whole number 0–100; only read when the mode is `on` | `100` when missing or invalid |

Production config sets `on`, delay 1000 and percent 100. Staging sets `on`, delay
1000 and percent 100.

- `off`, or an event that is not eligible: the single-queue path and its logs, unchanged.
- An event is eligible when the value (0–15) of the last hex digit of its usage ID is
  below `round(percent × 16 / 100)`: 50 selects last digits `0`–`7`, 100 selects all
  and 0 selects none. A last character that is not a hex digit is never eligible.
  Gateway usage IDs are random UUIDs, so the split is even.
- `on` and eligible: the main send to `USAGE_INGEST_QUEUE` starts exactly as before,
  including its `usage_ingest_enqueue_start`, `usage_ingest_enqueue` and
  `usage_ingest_enqueue_observed` events, each logged once. If it settles within the
  delay, the response is as before (202 on acceptance, 503 on failure) with no hedge.
  A main send that fails before the delay is not hedged.
- When the delay elapses first, exactly one `USAGE_INGEST_HEDGE_QUEUE.send` starts with
  the same message and options. The first acceptance from either queue returns 202. A
  failure on one side keeps waiting for the other; 503 only when both fail. The side
  still pending after a 202 is kept alive with `ctx.waitUntil` and logged when it
  settles; it is never cancelled. The hedge is never retried.
- A missing hedge binding, a hedge send that throws, or a `waitUntil` registration
  that fails (the hedge is then not sent) counts as a failed hedge: the request keeps
  waiting on the main send, so the hedge cannot turn a request that would have
  succeeded into a failure.

Each hedged request logs one `usage_ingest_hedge` event when both sends have settled:
`usage_id`, `hedge_delay_ms`, `winner` (`main`, `hedge` or `none`), `main_outcome`,
`main_send_duration_ms`, `hedge_outcome` (`accepted`, `unavailable`, `not_configured`
or `unregistered`), `hedge_send_duration_ms` when the hedge was sent, and
`main_error_name` / `hedge_error_name` (the error's name only) on a failed send. A
failed `waitUntil` registration logs `usage_ingest_hedge_unregistered`. Log failures
never change the response.

### Queues, consumer and data location

The hedge target is the old global (non-EU) pair of each environment. EU
jurisdiction was a latency experiment, not a residency requirement, so hedged copies
stored outside the EU jurisdiction are accepted. Cloudflare requires a DLQ to share
its source queue's [jurisdiction](https://developers.cloudflare.com/queues/configuration/data-location/#dead-letter-queues),
so the hedge consumer dead-letters into the global DLQ, which queue preparation keeps
at maximum [retention](#retention). Dead-letter alerting must cover
`usage-ingest-processing-dlq` as well as the EU DLQ.

The hedge consumer stays attached whatever the mode, with production and
staging batch 1, timeout 0, 20 retries, retry delay 60 and `max_concurrency` 25. The
consumer handler is queue-agnostic and logs `batch.queue`. So:

- Turning the hedge off stops new hedge sends; copies already in the hedge queue keep
  draining.
- Turning it on needs nothing else.
- Capacity: the hedge consumer adds up to 25 invocations × one message = 25 writer
  calls, so the shared plus hedge subtotal is 475 instead of 450 in production (425
  instead of 400 in staging) while hedged copies are being consumed. With the dedicated
  tagged consumer, the full configured ceiling is 525 in production and 435 in staging;
  see [Queue policy](#queue-policy). Writer admission is unchanged.

A hedged event can be accepted by both queues. Duplicate deliveries of one LLM usage
ID are safe: the writer's insert conflicts, its transaction rolls back and there are
no post-commit side effects. The redelivery test in
`packages/web-shared/src/lib/ai-gateway/first-usage-events.test.ts` shows one debit and
one set of first-usage events for two deliveries of one usage ID. Duplicate
completions rise by roughly the hedged share.

### Global single-message batch experiment

Only the existing global hedge consumers use `max_batch_size: 1`: production
`usage-ingest-processing` changes from 6, staging `usage-ingest-processing-staging`
from 2. EU batches stay 6 in production and 2 in staging. All caps, fill timeouts,
retry settings, source parallelism, hedge selection/delay, logs and traces stay fixed.

Cloudflare [checks autoscaling after a whole batch finishes](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/).
Shorter batches may allow faster scaling decisions; this is a hypothesis, not a
proven cold-start fix or production benefit, and lower lag is not guaranteed.
Each global invocation can use only one processing slot despite parallelism 2.
At the configured cap of 25 invocations, the maximum messages held in delivered
hedge batches falls from 150 to 25 in production (25 × batch 6→1), and from 50
to 25 in staging (25 × batch 2→1). These are bounds, not observed occupancy.
This can reduce throughput, increase invocation cost and increase retry pressure.
It does not force a warm Worker or provide minimum concurrency.

For a separately authorized rollout, first retain a baseline and then verify the
executing deployment and actual consumer settings in each environment. Compare
matched traffic, stall windows and mature completion cutoffs before/after: all
assigned LLM treatment/control completion-age tails (including fast requests that
never hedge), global handler-entry age, native consumer concurrency, backlog/lag,
writer rejections, retries, duplicates and extra invocations/cost. Keep sampling
and coverage limits explicit; acceptance winners are not persistence winners.
Treat sustained global hedge queue depth or oldest-message age growth under
matched traffic, or failure to drain after a stall, as a rollback trigger; assess
it alongside writer rejection/retry pressure and assigned completion-age tails.
No new telemetry is needed. Roll back in a future small PR by restoring only the
production global batch 1→6 (staging global 1→2 to restore its baseline), leaving
EU and the hedge protocol/settings intact; verify readback and recovery afterward.

### Flipping the toggle

Change the variable in `wrangler.jsonc` in a small PR and redeploy the Worker through
the normal workflow. `wrangler deploy` replaces dashboard-edited variables, so a
dashboard change does not last. The first production trial set
`USAGE_INGEST_HEDGE_MODE` to `on` and kept `USAGE_INGEST_HEDGE_PERCENT` at `50`;
production has since expanded to percent 100. Rolling production back to the
earlier bounded 50% is a separate follow-up PR that restores
`USAGE_INGEST_HEDGE_PERCENT` to `50` and redeploys the Worker; it is not an
automatic or live action.

### Merge prerequisite

Confirm the old production queue `usage-ingest-processing` is empty before merge. It
is reported empty and never used; this change does not read it back. Merging attaches a consumer to it through the normal deployment workflow, so merging
is not infrastructure-inert even with the toggle off. Merging also creates any
missing global queue and raises the global DLQ's retention.

### Removal

Removal is a forward PR, not a revert:

1. Set `USAGE_INGEST_HEDGE_MODE` to `off` and deploy.
2. Wait until the hedge queue is empty.
3. A new PR removes the hedge consumer, binding and variables. Its legacy-shaped config
   makes queue preparation detach the global consumer, as it did before this change.

A plain revert of this change restores the unconditional detach step and could leave
hedge copies unprocessed, some of which may be the only accepted copy of an event.
Queue preparation keeps accepting the shared shape without the hedge (now alongside the
required tagged pair), and historical source revisions deploy with their own helper; that is
not a safe rollback to an EU-only
consumer once the hedge has been on. Any deployment whose config has that shape (a
source revision from before this change, a plain revert, or a removal PR deployed
before the hedge queue has drained) detaches the global consumer without checking the
hedge queue's backlog. Messages stay in the queue, but nothing consumes them until a
consumer is attached again. `provision-queues.test.mjs` pins that behaviour. Drain
first, then remove forward.

### Measuring

The Worker's `usage_ingest_hedge` event and `batch.queue` are not in Axiom, but the
usage ID is. Production now runs at percent 100, so every eligible LLM usage ID is
hedged and there is no simultaneous non-eligible control arm. The historical
treatment/control split — at percent 50, last hex digits `0`–`7` of `usage_id` were
the treatment and `8`–`f` the control inside the same stalls — no longer describes an
active arm; those earlier digit-based comparisons are history after activation. The
primary measurement is a before/after comparison of:

- `usage_record_completion`: age and the over-5 s share of recorded completions,
  especially in stall hours.
- `usage_publisher_attempt`: `duration_ms` of publisher attempts, and the share of
  5 s or more.

Expanding 50→100 can roughly double eligible hedge attempts at equal workload; it
does not double all publications, because a fast EU send still never hedges and
off-mode or non-hex-digit events are unchanged. Duplicate completions can rise by
roughly the newly eligible share. The hedge consumer cap of 25 is unchanged and does
not by itself guarantee the extra traffic is harmless to speed or load. In
Cloudflare Workers Logs, `usage_ingest_hedge` winner counts show whether the second
queue accepts while the first is blocked. A before/after comparison is only
supporting evidence, because stalls vary a lot from day to day. No benefit is
claimed before that measurement.

## First writer-admission retry spread

A recognized writer-admission HTTP 429 (`queue_limit`, `pool_busy` or
`pool_waiting`) on normalized delivery attempt 1 now retries after a uniformly
distributed integer 1–4 seconds, replacing 1–2 seconds. There is no runtime flag
or environment selector. Invalid attempt metadata still normalizes to 1. Each
retry consumes one random draw. Later admission retries keep their existing
exponential jitter; generic 429, 503, invalid events, missing configuration and
other conservative failures keep their minimum 60-second delay. All usage kinds
share the same native 20-retry budget and DLQ policy. Individual ACK/retry and
overload invocation feedback, payloads, identity and writer admission are unchanged.

The measured 637 repeat admission rejects motivate the hypothesis that a wider
first window reduces repeated pressure; they do not prove a performance gain.
A wider first delay can worsen recovery after a short pressure pulse by up to two
additional seconds: a message may wait after the writer has recovered. Fewer
repeated rejects alone is not a win. Four mature November 12 post-deploy minutes
and late accepted publisher sends/duplicate deliveries do not select a winning
retry value. Logs are not a persistence ledger.

For a separately authorized before/after comparison, record exact deployed
revision/version, environment and UTC transition bounds. Repository production
workflows deploy eligible main revisions after CI, with an hourly catch-up;
merging can therefore schedule deployment of this behavior. This change does not
itself perform a deployment or a production experiment. Existing
`retry_delay_seconds`, `admission_reason` and `delivery_attempts` identify affected
retries without adding all-request events. Keep publisher timeouts at 20/5/40/4,
batch6/parallelism2/cap225 in production, admission wait250ms, writer pool, shared
limits, source retention and DLQ policy fixed. Staging keeps its existing capacity.
The LLM direct lane remains parked.

Before measurement, choose matched accepted-volume and usage-kind/producer-region
cohorts, pressure profiles and equal observation durations, plus numerical stop
thresholds against the matched baseline. Include quiet periods and short pressure
pulses. Compare mature creation cohorts only after completion/retry observation
windows close; report censored or unmatched IDs separately.

Report baseline and changed behavior side by side: rejection rows per unique
usage ID and repeat rejections beyond the first, end-to-end creation-to-recorded
age p95/p99, first-reject-to-recorded latency, quiet latency, drain time, native
backlog slope/size, oldest message age and DLQ arrivals. Retain duplicate and
terminal outcomes. Stop and prepare a small revert PR on any new unexplained DLQ
arrival or terminal/loss signal, sustained growing backlog/oldest age, or p95/p99,
quiet latency or drain time exceeding the predeclared limits. Investigate and
reconcile unresolved IDs; do not purge or replay as part of the comparison.

Rollback is a small follow-up PR restoring the first admission window to 1–2
seconds, followed by the normal review/deployment process. Already scheduled
delayed deliveries remain scheduled. There is no runtime switch for rollback.
