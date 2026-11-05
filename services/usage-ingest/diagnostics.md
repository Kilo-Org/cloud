# Queue delivery diagnostics

Diagnostics are always on. The publisher logs enqueue start plus every accepted
or unavailable result; the consumer logs every handler entry and repeats the same
batch identity and handler-entry time on every processing outcome. No random
sampling applies to these records: each valid test usage ID can join across
stages. Existing processing outcome logs remain enabled, including `queue` for
old/EU filters.

The independent phase sampling described in the service README under
[Processing](README.md#processing) still applies only to the
`handler_entry_queue_age_ms` and `slot_wait_ms` fields on processing
outcomes; it does not gate the diagnostics above.

These records are emitted for 100% of valid publisher requests and deliveries in
every environment, including production, except `usage_ingest_enqueue_observed`,
which is best effort because its promise is only kept alive by `waitUntil()`. That is more log volume than the
previous production publisher path, which logged only sampled, slow, or failed
sends. There is no runtime flag to reduce it; any reduction requires a code change
or an explicit Workers Logs sampling configuration.

| Event | Fields and boundary |
|---|---|
| `usage_ingest_enqueue_start` | Validated `usage_id`, `publisher_entry_at_ms`, `before_send_at_ms`; emitted before the existing single send |
| `usage_ingest_enqueue` | Validated `usage_id`, `accepted` / `unavailable` outcome, `after_send_at_ms`, monotonic `send_duration_ms`; accepted sends also repeat entry/before times and expose valid optional returned `queue_backlog_count`, `queue_backlog_bytes`, `queue_oldest_message_at_ms` |
| `usage_ingest_enqueue_observed` | Validated `usage_id`, `accepted` (`info`) / `unavailable` (`warn`) outcome and monotonic `send_duration_ms` for the same single send, logged from a promise registered with `ExecutionContext.waitUntil` before that send is awaited; intended to survive a client abort or disconnect while the send is still pending |
| `usage_ingest_enqueue_observation_unregistered` | `warn` with the validated `usage_id` only, when `ExecutionContext.waitUntil` throws while registering the observation; no exception text |
| `usage_ingest_handler_entry` | `queue`, local invocation `batch_id`, actual `batch_size`, handler entry and per-message start epochs, queue message ID/timestamp, attempts, validated usage ID/event timestamp, optional batch backlog sample; emitted before that message's writer call |
| `usage_ingest_processing` | Existing per-message writer duration/outcome/disposition plus `queue`, the same batch identity and handler entry |
| `usage_ingest_batch_dispositions` | One summary per invocation, always `info`, emitted after every message has settled and before any invocation throw: `queue`, the same `batch_id`, actual `batch_size`, `messages_started_n` (messages that reached an ACK or retry call), `processing_exception_n`, `ack_called_n`, `ack_exception_n`, `retry_called_n`, `retry_exception_n`, `overloaded`, `invocation_result` (`return`, `overload_throw` or `exception_throw`), `earliest_message_timestamp_ms` / `latest_message_timestamp_ms` (epoch ms, present only when at least one finite message timestamp exists) and fixed delivery-attempt buckets `delivery_attempt_1_n` … `delivery_attempt_5_n`, `delivery_attempt_6_plus_n`, `delivery_attempts_unknown_n` |

Times ending `_at_ms` and `message_timestamp_ms` are epoch milliseconds. Elapsed
send/writer durations use `performance.now()`. `batch_id` is local
diagnostic identity, not a Cloudflare batch ID. For serial multi-message batches,
`handler_entry_at_ms` is shared; `message_start_at_ms` includes time spent on prior
messages. Retries and duplicate publications may share a usage ID: retain queue
message ID, attempts and batch identity when joining.

No user ID, prompt, payload, credentials, cookies, URL or exception text is logged
by these diagnostics.

The batch summary describes local actions, not delivery confirmation. `ack_called_n`
and `retry_called_n` count the disposition call being made; `ack_exception_n` and
`retry_exception_n` count calls where that method threw. A disposition call is not
proof Cloudflare received or registered it, and a `return` invocation result still
relies on Cloudflare's documented successful-return acknowledgement. Queues remain
at-least-once and may deliver a message more than once regardless of an explicit
ACK. The summary carries no queue message IDs, usage IDs, payloads, headers or
exception text, and never changes an ACK, retry, overload decision or thrown error;
a summary formatting or log-sink failure is swallowed like every other diagnostic.
An empty batch emits one summary with `batch_size: 0`. Volume is one event per
invocation, not per message, so do not build a per-message trail from it. It is
written at invocation exit and is not a crash-safe record: a platform termination
before that point can lose it.

Send results and batch metadata are optional runtime boundaries: absent or invalid
fields are omitted. `oldestMessageTimestamp` is accepted only as a finite `Date`,
matching installed types; strings/numbers are deliberately omitted until hosted
shape is verified. No per-event `metrics()` call is added. Diagnostic formatting,
metadata and log-sink errors cannot convert an accepted send to a 503, republish,
or change the processing outcome log's ACK/retry disposition. The shared writer's
existing response validation and overload failure still determine disposition.

The completion observation registers before the original send's first `await` and
attaches both a fulfilment and a rejection handler, so it cannot leave an unhandled
rejection, cannot observe a different or second send, and cannot replace the
awaited send's response or failure. A `waitUntil` registration error does not
break a send that has already started: it logs `usage_ingest_enqueue_observation_unregistered`
and the send continues to determine the response. The observation only
covers time after the response or disconnect while Cloudflare keeps the invocation
alive, up to the shared 30 s `waitUntil` allowance; a hard kill, platform timeout,
or a longer stall can drop it. It describes queue acceptance, not a committed
ledger row, and no hosted disconnect, production deployment or lifecycle-bound
measurement has been performed.

## Staging smoke gate (separate authorization and deployment)

1. Confirm both deployed versions/settings and exact source/config first. Send a
   small approved staging cohort with known usage IDs and reconcile persistence
   using the existing shared writer. This PR does not authorize or perform it.
2. Join enqueue start/acceptance, handler entry and processing records by usage ID;
   retain queue/message/attempt/batch fields. Confirm finite runtime
   timestamps, actual send/batch metadata shape and unchanged ACK/duplicate/retry
   behavior. Check missing-log coverage before computing tails.
3. Compare per-event publisher-before-send → handler-entry and accepted-send →
   handler-entry alongside monotonic send/writer durations. Queue delivery
   may begin before acceptance returns. Cross-system clocks and message timestamp
   semantics may differ; retain negative intervals and investigate them rather
   than adding or clamping unrelated counters. `queue_wait_ms` remains the existing
   clamped message-timestamp age at per-message processing start.
4. Backlog is a point-in-time sample, not active concurrency. Do not infer GraphQL
   concurrency, consumer execution geography or API latency improvements from
   these logs. Hosted timing/placement and performance benefits remain unmeasured.

Merge order is diagnostics → EU queue → batching → middleware. EU/batching config
refreshes must preserve the always-on diagnostics, generated types, `queue` in
outcome logs and the shared handler-entry timestamp/batch identity. Rerun the
combined runtime tests after composition; this PR changes no queue names, batch,
delay, retry/DLQ, concurrency or early-ACK policy.
