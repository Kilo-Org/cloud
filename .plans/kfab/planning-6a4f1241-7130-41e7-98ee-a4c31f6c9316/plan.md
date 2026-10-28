<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(usage): stop the analytics-only isFirstUsage lookup from turning writer-endpoint usage writes into HTTP 500s

## Problem

Sentry KILOCODE-WEB-28HE (4 events, first seen 2026-10-28) is the newest release group of a long-running failure. The SFO half of kilocode-ai-gateway hands each usage write to the Frankfurt writer at POST /api/internal/usage/record, and that writer answers HTTP 500. `recordUsageInPrimaryRegion` treats a 500 as final: it captures "usage record handoff to primary region failed" with reason=http_500 and falls back to a local write from SFO, which brings back the transatlantic row-lock hold and pool pressure the writer endpoint was built to remove. The writer route answers 200 with recorded, duplicate or not_recorded for write outcomes and 400 for schema failures. It has no try/catch, so a 500 means an exception escaped the handler. The only unguarded database step in `saveUsageRelatedDataLocally` is `isFirstUsage`, which runs before `insertUsageRecord` and only decides whether a PostHog `first_usage` event fires; billing does not depend on it. When that lookup cannot get a primary connection, it throws, the insert is never attempted, and the request ends as a 500. In the last 7 days Sentry shows 924 unhandled connection DatabaseErrors attributed to `isFirstUsage` at this transaction, against 1001 http_500 handoff failures in the same window.

## Evidence

- Sentry anaconda-nq/7816997517 (KILOCODE-WEB-28HE), latest event f6ed3213eb6d46dd83cb90f4895848f7: Error 'usage record handoff to primary region failed', handled=yes, tags source=recordUsageInPrimaryRegion and reason=http_500, cloud.region=sfo1, the gateway response was still 200, release 476bf2e6.
- Sentry errors for transaction:"POST /api/internal/usage/record" with error.handled:false over 7d: 'timeout exceeded when trying to connect' 544, 'Connection terminated due to connection timeout' 234 and 'no more connections allowed (max_client_conn)' 146. All three are attributed to processUsage.ts isFirstUsage.
- Triage aggregation (sentry): over 7d, the handoff failure message grouped by reason gives http_500 = 1001 events, http_400 = 46 and TimeoutError = 2. The same message appears in 7 release groups over 29 days, including KILOCODE-WEB-2860 (#9032) and 28BG.
- packages/web-shared/src/lib/ai-gateway/processUsage.ts:489-541: `saveUsageRelatedDataLocally` awaits `isFirstUsage` (a `db.query.microdollar_usage.findFirst` on the primary) with no try/catch before `insertUsageRecord`. `isFirst` is only used to gate `sendFirstUsageEvent` and the `has_prior_free_usage` property, and only when `posthog_distinct_id` is set and the write was not a redelivery.
- processUsage.ts:872-948: `insertUsageRecord` retries up to 3 attempts, catches its own failures, recovers the identity of a redelivered row, reports a redacted error through captureException with `describeDatabaseError`, and returns null.
- apps/web/src/app/api/internal/usage/record/route.ts: no try/catch. Write outcomes are reported in-band as 200 recorded, duplicate or not_recorded; schema failures get 400.
- usage-record-client.ts:44-58,95-150: only 429, 502 and 503 are retried. A 500 breaks out of the retry loop, gets captured with reason http_<status>, and returns 'unavailable'. `saveUsageRelatedData` then falls back to `saveUsageRelatedDataLocally` from SFO.
- usage-record-diagnostics.ts:26-65: `observeUsageRecordCompletion` logs outcome 'error' for thrown writes. The phase-timing comments in route.ts identify pool acquisition as the cause of the endpoint's latency.

## Desired outcome

An `isFirstUsage` lookup that fails can no longer abort a usage write. The billing insert is always attempted, and the writer endpoint answers within its in-band contract instead of returning HTTP 500. That cuts the http_500 handoff failures and the SFO local-write fallbacks they trigger. The cost is at most one missed `first_usage` analytics event per failed lookup.

## Scope

- Make `isFirstUsage` best-effort inside `saveUsageRelatedDataLocally`. On a thrown error it resolves to `false`, reports a redacted error (built with `describeDatabaseError`, tagged source=isFirstUsage, raw message and statement never logged), and execution continues to `insertUsageRecord`.
- Skip the `isFirstUsage` query when `posthog_distinct_id` is null, because nothing consumes the result then. This removes a primary round trip and a pool checkout from those writes.
- Unit and integration tests in packages/web-shared covering both behaviours, plus a route-level test showing that a failing first-usage lookup still produces a 200 recorded response.

## Exclusions

- Adding a catch-all try/catch to the writer route that converts unexpected exceptions into 200 not_recorded. The SFO client would read that as a final, no-fallback outcome and could lose billing rows. Truly unexpected throws should keep returning 500 so the caller falls back to a local write.
- Changing the retry or fallback policy in usage-record-client.ts (which statuses are retryable, timeouts, attempt counts).
- Resizing the primary pool, Supavisor max_client_conn, or other connection-capacity tuning. The pool-wait versus event-loop question in usage-record-diagnostics.ts stays separate work.
- Retiring the SFO primary-region handoff in favour of USAGE_QUEUE_ONLY_ENABLED.
- Closing the duplicate tracking issues (#9032 and the other Sentry release groups). That is triage bookkeeping, not code.

## Approach

- In processUsage.ts, replace `const isFirst = await isFirstUsage(...)` with a guarded helper. If `posthog_distinct_id` is null, return false without querying. Otherwise run the existing query inside try/catch. On error, call `captureException` with a redacted Error whose summary includes `describeDatabaseError(error).code`, keeping only stack frames via the existing `stackFramesUnderHeader`, with tags {source: 'isFirstUsage'} and extra {usageId}. Then return false. Keep the evaluation before the insert so the existing redelivery and first-usage ordering stays the same.
- Keep `insertUsageRecord`, the route, and the client unchanged. A failed insert after this change still maps to the existing not_recorded contract. A lookup failure no longer skips the insert.
- Tests: (1) mock the db query or the isFirstUsage dependency to throw a connection-style error. Assert that saveUsageRelatedDataLocally still calls the insert, returns a recorded outcome, emits no first_usage event, and captures a redacted error without the raw message. (2) With posthog_distinct_id null, assert that no microdollar_usage findFirst query is issued. (3) Extend apps/web/src/app/api/internal/usage/record route tests: a throwing first-usage lookup yields HTTP 200 with status recorded. Keep the existing first-usage-events.test.ts redelivery tests passing unchanged.
- After deployment, compare 7-day Sentry counts for unhandled isFirstUsage DatabaseErrors at POST /api/internal/usage/record and for handoff failures with reason=http_500. Also watch the 'insertUsageRecord failed' rate (KILOCODE-WEB-28BR) for an offsetting rise.

## Affected areas

- packages/web-shared/src/lib/ai-gateway/processUsage.ts (saveUsageRelatedDataLocally, isFirstUsage)
- packages/web-shared/src/lib/ai-gateway/first-usage-events.test.ts or a new sibling test file
- apps/web/src/app/api/internal/usage/record/route.test.ts (route-level regression)

## Acceptance criteria

### ac-1: When the first-usage lookup throws, such as on a pool connect timeout or max_client_conn, saveUsageRelatedDataLocally still runs insertUsageRecord, returns the recorded outcome with the correct usageId and balance, and emits no first_usage PostHog event for that write. A test proves this by injecting a throwing lookup.

**Verification:** Code review

### ac-2: POST /api/internal/usage/record answers HTTP 200 with status 'recorded' (not 500) when the first-usage lookup fails and the insert succeeds. A route-level test covers this.

**Verification:** Code review

### ac-3: A failed first-usage lookup is reported to Sentry exactly once as a handled, redacted error tagged source=isFirstUsage. The report includes the database error code and usageId, but not the driver message or the SQL statement and its parameters.

**Verification:** Code review

### ac-4: When posthog_distinct_id is null, no microdollar_usage lookup for first usage is issued. When it is present, first_usage and first_microdollar_usage are still emitted exactly once for a first write and for a concurrent redelivery, as the existing first-usage-events tests already require.

**Verification:** Code review

### ac-5: Within 7 days of production deployment, Sentry shows unhandled isFirstUsage DatabaseErrors at POST /api/internal/usage/record near zero, and handoff failures with reason=http_500 well below the pre-change baseline of about 1001 per week. The 'insertUsageRecord failed' rate shows no offsetting increase large enough to cancel the improvement.

**Verification:** Manual: compare 7-day Sentry aggregates for kilocode-web before and after deployment

## Risks

- Billing-loss tradeoff. A request that today fails in isFirstUsage gets a 500 and an SFO local-write fallback, which often succeeds. After the change, the insert runs in Frankfurt under the same pool pressure. If all 3 insert attempts fail, the client receives not_recorded and does not fall back, so the record is reported but not persisted. That is already the route's documented contract for insert failures, but it could move some failures from 'slow but written' to 'not recorded'. AC5 tracks the insertUsageRecord failure rate to catch this.
- Analytics: a missed first_usage event for users whose lookup failed, and has_prior_free_usage defaulting to true in that case. This is bounded to failed lookups.
- Fixing the 500 does not fix the underlying connection scarcity. Insert-path connection failures (28BR, 28EM) continue until capacity work happens.

## Assumptions

- The unhandled isFirstUsage connection errors are the main source of the writer's HTTP 500s. Counts match closely (924 vs 1001 per week), but platform-level 500s are not fully ruled out.
- The isFirst value has no billing or balance effect. Code review confirms it only gates PostHog events.
- Tests can inject a failing lookup through existing jest mocking of the db module or a small injectable seam, without restructuring processUsage.

## Decisions

### d-1: When the first-usage lookup fails, should the write proceed with the insert (treating the user as not first) or keep failing so the SFO client falls back to a local write?

**Answer:** Proceed with the insert. The lookup is analytics-only, the writer endpoint exists so that Frankfurt performs the write, and insert failures already have a defined in-band outcome. The billing-loss tradeoff is monitored through AC5.

**Blocking:** no

### d-2: Should the writer route gain a catch-all that converts unexpected exceptions into 200 not_recorded?

**Answer:** No. not_recorded stops the SFO fallback, so a catch-all could silently drop billing rows for unknown failures. Unexpected throws keep returning 500.

**Blocking:** no
