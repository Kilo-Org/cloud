# Staging validation: compare direct and queued usage writes

This is a staging validation runbook. The lasting event and caller-field contract
is documented in [Observability](README.md#observability).

Use the same offered event rate, duration, account/organization distribution, and
model/cost mix in both runs. Include steady traffic and a burst: queued processing
may reduce peak pressure while taking longer to finish the same work.

## Select each path

With the gateway queue-selection change installed, configure the intended staging
gateway deployment as follows. Keep the Worker in processing mode with the same
writer endpoint and queue policy for both runs.

| Gateway setting | Direct baseline | Queued run |
|---|---|---|
| `USAGE_QUEUE_ONLY_ENABLED` | `false` | `true` |

Apply server environment settings through the gateway deployment. Queue-only is
enabled by the existing staging controls for this recipe; production SFO selection
uses separate `USAGE_QUEUE_SFO_EXPOSURE` (`0`–`1`) and optional
`USAGE_QUEUE_SFO_USER_IDS` controls and [rollout gates](eu-queues.md#production-merge-gate),
and is not activated here. Disabling queue-only
keeps new events on direct accounting. Background shadow publication has been
removed; reconcile and drain any historically accepted shadow events before
switching a consumer to processing. Queue-only never falls back to a gateway billing writer. Count
`usage accounting publication failed` errors
and report their usage IDs and categories with the run. These return null
accounting results after the bounded retries, not queued or recorded success.
`usage enqueue retrying` counts failed attempts, not distinct events: retries
reuse the same event and may create duplicate deliveries after ambiguous acceptance.
Include the publisher retry/backoff budget (up to seven seconds plus runtime
scheduling overhead, excluding subsequent Bouncer reporting) in accounting
completion deadlines. There is no durable recovery
for unaccepted events in this path; an ambiguous failure such as a timeout may
still be followed by consumer persistence, so reconcile those IDs separately.

Wait for the source queue backlog to drain before each run. Record deployment
commit, settings, start/end timestamps, generated event count, offered rate, and
request failure count. Use disjoint event IDs for the two runs. Continue observing
until queued events finish or the test's stated completion deadline is reached;
report unfinished events and DLQ arrivals rather than dropping them from totals.

## Read comparable completion measurements

In staging, every invocation of the shared `saveUsageRelatedDataLocally`
persistence boundary attempts to emit `usage_record_completion`. Both Frankfurt
gateway direct writes and the HTTP writer called by the consumer use this boundary.
Production logs recorded/duplicate completions at 100% by default,
configurable with the server-only `USAGE_RECORD_COMPLETION_SAMPLE_RATE` (`0`–`1`)
and a redeploy of the gateway and HTTP writer apps. Null/error completions remain
at 100%. See the [deployment sampling rules](README.md#observability),
and confirm hosted log retention, ingestion and sampling cover the test window.

| Field | Meaning |
|---|---|
| `usage_id` | Correlates a delivery with consumer/gateway logs; repeated attempts share the ID |
| `outcome` | `recorded`, `duplicate`, `not_recorded` (null result), or `error` (thrown exception) |
| `level` | `info` for recorded/duplicate; `warn` for null/exception |
| `sample_rate` | Application selection probability: `1` for full logging; configured production recorded/duplicate probability, default `1` |
| `duration_ms` | Rounded monotonic elapsed time around the shared persistence operation, including first-usage checks, the write and awaited follow-up work; excludes caller HTTP/queue waiting |
| `event_age_ms` | Age of the event at operation completion, clamped at zero; omitted if timestamp cannot be parsed |
| `execution_region` | Function region from `VERCEL_REGION`, restricted to `fra1`, `sfo1`, or `unknown` |
| `entrypoint` | `gateway`, `writer_endpoint`, or `unknown` |
| `writer_caller` | `queue`, `region_handoff`, or `unknown`; authenticated route allowlists the HTTP client's diagnostic header |

`execution_region` identifies where persistence ran, not the originating gateway.
SFO gateway direct writes handed to the Frankfurt HTTP writer therefore log `fra1`;
`sfo1` identifies an SFO local fallback.

Compare p50/p95/p99 of `duration_ms` and `event_age_ms` over matching run windows
and persistence regions, grouping by `entrypoint` and `writer_caller` and separating
recorded and duplicate outcomes. In a full staging run, count attempts by outcome
and completed **distinct** usage IDs with recorded/duplicate outcomes; count null
and exception outcomes separately. For sampled production data, estimate attempt
counts with `sum(1 / sample_rate)` per outcome when the rate is nonzero; no success
estimate is available with success sampling disabled. Do not scale distinct-ID counts
or treat estimates as exact accounting. This weight covers application sampling
only, not platform sampling or missing logs. Keep success latency percentiles
within comparable groups with the same sampling rate; mixing fully logged failures
and sampled successes requires weighted statistics. An `error` can happen after
commit during follow-up work, so it does not prove rollback. Logging failure preserves the
original result/exception, and missing logs do not prove missing billing rows.
Reconcile completed unique IDs with the load generator's expected event set and,
when checking persistence, recorded rows.

The existing `usage_record_timing` events add endpoint phases and pool gauges for
diagnosis. They emit every slow request plus a 1% baseline sample; their raw counts
and percentiles are not comparable to the uniformly sampled success completion series.

Consumer `usage_ingest_processing` events additionally expose:

- `writer_duration_ms`: the HTTP writer attempt, including response validation;
  omitted when the writer is skipped.
- `queue_wait_ms`: age of the platform queue message at the start of processing
  that individual message, before its writer attempt. It includes time before
  invocation and any wait for a processing slot within the delivered batch,
  including backlog and redelivery delay; it is not a pure queue-delivery metric.
  Staging uses batch size 2 and parallelism 2, allowing two messages to start
  concurrently. `USAGE_INGEST_PARALLELISM=1` keeps batch size 2 but processes it
  serially, so the second message's value includes waiting for the first message
  to settle. Production uses batch size 2, two writer slots
  and invocation cap 200 (up to 400 concurrent writer calls). Its deployment and activation are subject to the
  [production readiness gates](eu-queues.md#production-merge-gate); this staging recipe
  does not activate it. An ACK follows a matching recorded/duplicate writer response only.
- `event_age_ms`: creation through consumer outcome logging, including writer wait.
- `delivery_attempts`, categorical `reason`, and `queue_action`: diagnose retries;
  `retry` does not confirm DLQ storage.

Record the deployed batch size, processing parallelism, invocation cap and mode
with each run. Staging cap 200 with parallelism 2 allows at most 400 concurrent
writer calls; parallelism 1 allows at most 200 and does not restore a batch-1
baseline. Changing these Worker variables/config settings requires redeployment.
Timeout 0 does not guarantee two-message batches. With main's diagnostics enabled
(`USAGE_INGEST_DIAGNOSTICS=all` in staging), the shared handler-entry timestamp
measures invocation entry, while `queue_wait_ms` still measures age at each
message's own processing start; keep those boundaries separate.

Use the queue's backlog and DLQ monitoring to observe growth, exhaustion and drain
time. A quiet database alongside an increasing backlog is not equivalent throughput.
Do not count publisher acceptance as completed persistence.

## Collect database impact over the same windows

Collect database CPU, disk I/O/IOPS, connection demand and lock waits alongside the
application measurements. Capture cumulative query-statistics snapshots immediately
before each run and after its completion/drain window. Prefer deltas per completed
unique usage ID as well as rates per second; record background database traffic.

Supabase exposes these query statistics through `pg_stat_statements`. Determine its
installed schema first, then replace `<extension_schema>` below with that schema.
The queries are read-only and do not reset shared statistics. Run only against the
intended test database; retain the same query IDs, database/user IDs and reset epoch
when calculating deltas.

```sql
select n.nspname as extension_schema
from pg_extension e
join pg_namespace n on n.oid = e.extnamespace
where e.extname = 'pg_stat_statements';

select stats_reset, dealloc
from <extension_schema>.pg_stat_statements_info;

select now() as captured_at,
       dbid, userid, queryid, toplevel,
       calls, total_exec_time, rows,
       shared_blks_hit, shared_blks_read,
       shared_blks_dirtied, shared_blks_written,
       temp_blks_read, temp_blks_written
from <extension_schema>.pg_stat_statements
where dbid = (select oid from pg_database where datname = current_database())
  and query ~* '(microdollar_usage|kilocode_users|organizations|organization_user_usage)'
order by dbid, userid, queryid, toplevel;
```

The filter selects candidate usage-related statements; other features may use the
same tables. Query IDs are aggregated statement identities, not individual usage
IDs. New, reset or evicted entries require separate accounting; never subtract
incompatible snapshots. Buffer counters are not physical disk IOPS. Failed statements may be absent from execution counters. Query execution
time is not client-side pool wait or total end-to-end latency. No representative SQL
text or parameter values are returned in the snapshot above.

Sources: [Supabase query statistics](https://supabase.com/docs/guides/database/extensions/pg_stat_statements),
[database inspection](https://supabase.com/docs/guides/observability/inspect), and
[resource reports](https://supabase.com/docs/guides/observability/reports).
