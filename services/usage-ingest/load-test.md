# Staging validation: compare direct and queued usage writes

This is a staging validation runbook. The lasting event and caller-field contract
is documented in [Observability](README.md#observability).

Use the same offered event rate, duration, account/organization distribution, and
model/cost mix in both runs. Include steady traffic and a burst: queued processing
may reduce peak pressure while taking longer to finish the same work.

## Select each path

Staging selects queued accounting under the environment guards below and has no
direct-accounting selector. This recipe does not provide a direct baseline;
establish a separately agreed test setup before comparing direct and queued runs.

For staging queued runs, keep `VERCEL_TARGET_ENV=staging` and `VERCEL_ENV` other
than `production`. Use `USAGE_QUEUE_TRANSPORT=cloudflare` (or unset) for Cloudflare;
exact `vercel` selects the [Vercel prototype](../../packages/usage-queue/README.md).
Production queues every request in any function region,
without a regional or exposure control; the
[rollout gates](eu-queues.md#production-merge-gate) still apply before
deployment. No production change is part of this recipe. Keep the Worker processing mode, writer endpoint and queue
policy fixed.

Background shadow publication has been
removed; reconcile and drain any historically accepted shadow events before
switching a consumer to processing. After attempting publication, queue-only never falls back to a gateway billing
writer. Missing publisher configuration and failed lifetime registration retain
the existing direct fallback before any publication attempt. Count
`usage accounting publication failed` errors
and report their usage IDs and categories with the run. These return null
accounting results after the bounded retries, not queued or recorded success.
`usage enqueue retrying` counts failed attempts, not distinct events: retries
reuse the same event and may create duplicate deliveries after ambiguous acceptance.
Include the retry-enabled Cloudflare publisher's 40-second elapsed budget
(four attempts, a first of up to twenty seconds and later ones of up to five, plus
full-jitter waits, clipped to remaining budget; four full attempts and the maximum
waits fit in under 38.5 seconds, so only a runtime delay shortens a later attempt)
and runtime scheduling overhead, excluding subsequent Bouncer reporting, in
accounting completion deadlines. Non-retry HTTP publication remains one
two-second attempt; Vercel queue transport is unchanged. There is no durable recovery
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
| `writer_caller` | `queue`, `queue_vercel`, `ingress_direct`, `region_handoff`, or `unknown`; authenticated route allowlists the HTTP client's diagnostic header |

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
  to settle. Production uses batch size 6, two writer slots
  and invocation cap 225 (up to 450 concurrent writer calls). Its deployment and activation are subject to the
  [production readiness gates](eu-queues.md#production-merge-gate); this staging recipe
  does not activate it. An ACK follows a matching recorded/duplicate writer response only.
- `event_age_ms`: creation through consumer outcome logging, including writer wait.
- `delivery_attempts`, categorical `reason`, and `queue_action`: diagnose retries;
  `retry` does not confirm DLQ storage.

Record the deployed batch size, processing parallelism, invocation cap and mode
with each run. Staging cap 200 with parallelism 2 allows at most 400 concurrent
writer calls; parallelism 1 allows at most 200 and does not restore a batch-1
baseline. Changing these Worker variables/config settings requires redeployment.
Timeout 0 does not guarantee two-message batches. Diagnostics are always on, so
the shared handler-entry timestamp measures invocation entry, while
`queue_wait_ms` still measures age at each message's own processing start; keep
those boundaries separate.

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

## Validate the `on_stall` direct lane

Staging commits `USAGE_INGEST_DIRECT_MODE=on_stall`, so deploying the staging
Worker activates the direct lane there. First check the
[writer prerequisite](README.md#deployment-prerequisite). This section validates
the lane in hosted staging. It does not establish production capacity or approve a
production mode.

### What local tests already cover

These tests are deterministic and need no hosted service. They inject the
`Queue.send` promise and the writer response:

- `src/publish-usage.test.ts`, suites `direct lane on_stall` and
  `direct lane on_stall race after the hedge`, cover every race order:
  - the send settles before the hedge;
  - the send accepts while the direct write is pending;
  - the send fails, then the direct write accepts or fails;
  - the direct write accepts or fails first.

  They also cover strict success (`recorded` or `duplicate` with the same usage
  ID) against every failure class, and exactly one queue and publish log per
  request. `waitUntil` and log-sink failures are included.
- `src/direct-lane.runtime.test.ts` runs the real staging entry in workerd, with
  the real rate-limit binding and a loopback writer.
- `packages/web-shared/src/lib/ai-gateway/first-usage-events.test.ts` runs against
  local Postgres. A second delivery of one usage ID reports `duplicate` and causes
  no second debit, rollup repair, Bouncer outbox row, PostHog event or Kilo Pass
  bonus.

A `Queue.send` that blocks for seconds or rejects is covered **only** by these
local tests. The hosted staging setup cannot make Cloudflare Queues stall or fail on
demand.

### A normal load run does not prove the lane

With the committed 2000 ms hedge, a healthy `Queue.send` resolves first. A smooth
staging run can therefore produce only `mode: on_stall, lane: queue` events and
never call the writer directly. Neither `mode: on_stall` nor successful queue
traffic shows that the direct lane ran. Report three counts per usage ID, not one:

- **Hedge candidates.** `usage_ingest_publish` events with `direct_outcome` or
  `direct_pending: true`. A hedge became due; this alone proves no writer request.
  `direct_pending` can mean the Worker was still waiting on the limiter.
- **Skips without a writer request.** A `direct_outcome` of `rate_limited`,
  `limiter_unavailable` or `missing_config`. Take each request's outcome from its
  `usage_ingest_publish` event, or, when that event has `direct_pending: true`, from
  its later `usage_ingest_direct_observed` event. One request has at most one of
  the two, so do not add both streams.
- **Observed writer attempts.** Writer-side evidence only: distinct usage IDs in
  `usage_record_completion` with `writer_caller: ingress_direct`, plus
  `usage_writer_admission` rejections with `writer_caller: ingress_direct`.
  Admissions are sampled at 1%; rejections are always logged. A Worker-side
  `direct_outcome` of `recorded` or `duplicate` is also accepted, because the
  shared client returns it only for a writer acknowledgement with the same usage
  ID. Other Worker-side outcomes (`timeout`, `http_error`, `request_failed`, …) show
  that the Worker tried, not that the writer received the request.

Claim direct-path coverage only when observed writer attempts are above zero. With
zero, report coverage as **absent**, even if candidate or refusal logs exist.

### Controlled delayed-send run

Existing settings can force the hedge without new infrastructure. In a separate
staging-only change approved for the test window:

1. Set `USAGE_INGEST_STALL_HEDGE_MS` in `env.staging.vars` below the observed
   `Queue.send` duration, for example `1`.
2. Deploy staging and run the test.
3. Revert the setting and deploy again.

This does not simulate a Cloudflare stall. The send is not delayed; the timer just
overtakes it. It does exercise:

- direct attempts racing a send that is still pending;
- recovery while direct traffic is in flight: sends that accept while the direct
  write is pending log `direct_pending: true`, followed by one
  `usage_ingest_direct_observed`;
- strict success: a direct `recorded` or `duplicate` answer gives 202 with
  `lane: direct`;
- the duplicate path: almost every directly recorded event is also delivered by the
  queue and must come back as `duplicate`.

Hedged events cost up to two writer calls, so size the offered rate for that.

Two failure cases can be produced with existing settings:

- **Admission rejection.** Enough concurrent direct writes per writer instance
  exceed the 5-slot ceiling. The publish event shows `direct_outcome: http_error`
  with `direct_admission_reason: queue_limit`, and the queue lane answers.
- **Direct timeout.** Also lowering `USAGE_INGEST_DIRECT_TIMEOUT_MS` (for example to
  `1`) in the same staging-only change makes every direct attempt `timeout`, so the
  queue decides.

The following cannot be produced in hosted staging, so cover them with the local
tests above and say so in the report:

- a blocking or rejecting `Queue.send`;
- writer 5xx;
- `not_recorded`;
- a limiter refusal at the configured 12,600 per 10 s.

### Reconcile the same usage IDs

Use dedicated staging test users with no other traffic and no Kilo Pass
threshold, and a fixed, recorded set of event IDs. If the events carry Bouncer
usage events, also record their request IDs. Before the run, snapshot each test
user's `kilocode_users.microdollars_used`.

After the drain below, run these read-only checks against the staging database.
`$1` is the expected usage IDs, `$2` the test user IDs and `$3` the Bouncer request
IDs.

```sql
-- Expected IDs with no row: must return nothing.
select expected.id
from unnest($1::uuid[]) as expected(id)
left join microdollar_usage u on u.id = expected.id
where u.id is null;

-- Billed rows per test user. Compare with the expected events and costs.
select kilo_user_id, count(*) as usage_rows, sum(cost) as billed
from microdollar_usage
where id = any($1::uuid[])
group by kilo_user_id;

-- Debit: microdollars_used minus the pre-run snapshot must equal billed above.
select id, microdollars_used
from kilocode_users
where id = any($2::text[]);

-- Bouncer outbox: every expected request ID must have exactly one row.
-- Returns expected IDs with zero rows as well as duplicates.
select expected.request_id, count(o.id) as outbox_rows
from (select distinct unnest($3::text[]) as request_id) as expected
left join bouncer_usage_event_outbox o on o.request_id = expected.request_id
group by expected.request_id
having count(o.id) <> 1;
```

The primary key already prevents a second row for one usage ID. The debit check is
the one that would catch a double charge. Once rollup repairs for the run IDs have
drained, `microdollar_usage_daily.total_cost_microdollars` for the test users should
also grow by exactly the billed amount. PostHog and Kilo Pass side effects are not
visible in SQL; the local duplicate test above covers them.

### Shared database pressure

Collect the database impact signals [below](#collect-database-impact-over-the-same-windows)
for the run, and for a baseline run of the same shape with the committed hedge.
Also compare these writer signals between the two runs:

- `usage_writer_admission` rejections by `writer_class` and `reason`;
- `usage_record_timing` pool gauges and `pool_waiting_peak`.

### Stop and drain

Stop the load generator and restore the committed staging settings if any of these
happens:

- the ingress returns 503;
- the gateway logs `usage accounting publication failed`;
- queue-class admission rejections (`writer_class: queue`), or `pool_waiting`
  sustained above the baseline run;
- writer `not_recorded` or `error` completions;
- any DLQ arrival;
- database CPU or connections exceed the threshold agreed for the test.

To drain:

1. Revert the staging-only settings, or commit `USAGE_INGEST_DIRECT_MODE` as `off`
   for staging, and deploy.
2. Track the generated cohort, not the queue, until a completion deadline stated
   before the run. An empty backlog does not show that billing writes settled: the
   end of `waitUntil` or a client abort does not cancel a writer or database
   operation already running. Classify every expected usage ID:
   - publication: accepted (202), failed (gateway
     `usage accounting publication failed`, ingress 503), or unresolved (timeout or
     no response, which may still have been recorded);
   - writer: a `recorded` or `duplicate` completion, still retrying
     (`usage_ingest_processing` with `queue_action: retry`), in the DLQ, or no
     outcome seen;
   - persistence: whether the reconciliation above finds its row.
3. The cohort is complete when every accepted or unresolved ID has its row and a
   `recorded` or `duplicate` completion, no cohort ID is retrying or in the DLQ, and
   the debit and outbox checks match.

At the deadline, report every ID that is not complete, with its classification, as
incomplete or failed. Do not declare the run drained from a backlog snapshot. A
missing expected ID or a debit mismatch is a failure; do not replay anything before
reconciliation.

Report:

- Worker and writer deployment commits, and all direct-lane settings;
- hedge candidates, skips and observed writer attempts as defined above, and the
  duplicate count;
- the completion deadline and the cohort classification at that deadline;
- reconciliation results and database pressure;
- which cases were covered only by local tests.
