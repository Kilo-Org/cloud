# Queue delivery diagnostics

`USAGE_INGEST_DIAGNOSTICS=all` enables 100% diagnostic logging on the staging
publisher/consumer and retained staging writer relay (when bound). No random
sampling is applied: each valid test usage ID can join across stages. An absent or different value disables
the extra logs and correlation header. Production omits the setting. Existing
processing outcome logs remain enabled, now including `queue` for old/EU filters.
Normal staging calls the writer directly, so it emits no relay-forward records or
relay correlation header. Disable diagnostic settings after the investigation to
reduce log volume.

| Event | Fields and boundary |
|---|---|
| `usage_ingest_enqueue_start` | Validated `usage_id`, `publisher_entry_at_ms`, `before_send_at_ms`; emitted before the existing single send |
| `usage_ingest_enqueue` | `accepted` / `unavailable`, `after_send_at_ms`, monotonic `send_duration_ms`; accepted sends also repeat entry/before times and expose valid optional returned `queue_backlog_count`, `queue_backlog_bytes`, `queue_oldest_message_at_ms` |
| `usage_ingest_handler_entry` | `queue`, local invocation `batch_id`, actual `batch_size`, handler entry and per-message start epochs, queue message ID/timestamp, attempts, validated usage ID/event timestamp, optional batch backlog sample; emitted before that message's writer call |
| `usage_ingest_processing` | Existing per-message writer duration/outcome/disposition plus `queue` and, when enabled, the same batch identity and handler entry |
| `usage_ingest_relay_forward` | Validated UUID `usage_id`, relay entry/before/after-forward epochs, monotonic `forward_duration_ms`, HTTP status or categorical transport failure; emitted when fetch settles, before response-body validation in the consumer |

Times ending `_at_ms` and `message_timestamp_ms` are epoch milliseconds. Elapsed
send/writer/forward durations use `performance.now()`. `batch_id` is local
diagnostic identity, not a Cloudflare batch ID. For serial multi-message batches,
`handler_entry_at_ms` is shared; `message_start_at_ms` includes time spent on prior
messages. Retries and duplicate publications may share a usage ID: retain queue
message ID, attempts and batch identity when joining. Relay correlation identifies
usage, not a unique delivery attempt.

The consumer adds `x-usage-id` only to its private relay call while diagnostics
are enabled. The relay accepts only UUID-shaped values and forwards this marker
only when enabled itself. It keeps the configured writer destination and existing
authentication/timeout/redirect behavior. It does not read or copy the body for
logging. No user ID, prompt, payload, credentials, cookies, URL or exception text
is logged by these diagnostics.

Send results and batch metadata are optional runtime boundaries: absent or invalid
fields are omitted. `oldestMessageTimestamp` is accepted only as a finite `Date`,
matching installed types; strings/numbers are deliberately omitted until hosted
shape is verified. No per-event `metrics()` call is added. Diagnostic formatting,
metadata and log-sink errors cannot convert an accepted send to a 503, republish,
or change the processing outcome log's ACK/retry disposition. The shared writer's
existing response validation and overload failure still determine disposition.

## Staging smoke gate (separate authorization and deployment)

1. Confirm both deployed versions/settings and exact source/config first. Send a
   small approved staging cohort with known usage IDs and reconcile persistence
   using the existing shared writer. This PR does not authorize or perform it.
2. Join enqueue start/acceptance, handler entry, processing and, when bound, relay
   records by usage ID; retain queue/message/attempt/batch fields. Confirm finite runtime
   timestamps, actual send/batch metadata shape and unchanged ACK/duplicate/retry
   behavior. Check missing-log coverage before computing tails.
3. Compare per-event publisher-before-send → handler-entry and accepted-send →
   handler-entry alongside monotonic send/writer/relay durations. Queue delivery
   may begin before acceptance returns. Cross-system clocks and message timestamp
   semantics may differ; retain negative intervals and investigate them rather
   than adding or clamping unrelated counters. `queue_wait_ms` remains the existing
   clamped message-timestamp age at per-message processing start.
4. Backlog is a point-in-time sample, not active concurrency. Do not infer GraphQL
   concurrency, consumer execution geography or API latency improvements from
   these logs. Hosted timing/placement and performance benefits remain unmeasured.

Merge order is diagnostics → EU queue → batching → middleware. EU/batching config
refreshes must preserve staging diagnostic vars and generated types, plus `queue`
in outcome logs and the shared handler-entry timestamp/batch identity. Rerun the
combined runtime tests after composition; this PR changes no queue names, batch,
delay, retry/DLQ, concurrency or early-ACK policy.
