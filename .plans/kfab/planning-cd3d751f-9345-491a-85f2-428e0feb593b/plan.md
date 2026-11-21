<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(usage-writer): stop a failed isFirstUsage read from turning the Frankfurt usage write into an unhandled 500

## Problem

When the SFO gateway hands a usage write to Frankfurt and that handoff fails, the gateway reports it as Sentry KILOCODE-WEB-2860, "usage record handoff to primary region failed". The issue has 477 events between 2026-10-08 and 2026-10-28. About 223 of them have reason=http_500, and the latest event is in that group. The writer route `POST /api/internal/usage/record` is designed to answer only 400 (body fails validation) or 200 (recorded, duplicate or not_recorded). Database errors are supposed to be absorbed by `insertUsageRecord`, which logs them in redacted form and returns null. `saveUsageRelatedDataLocally` has a gap: it awaits `isFirstUsage()` before `insertUsageRecord`, and that function does an unguarded `db.query.microdollar_usage.findFirst`. If getting a pool connection fails on that read (`max_client_conn`, or a connect timeout), the exception passes through `observeUsageRecordCompletion` (try/finally only) and the route, and Next.js answers 500. Sentry shows this as KILOCODE-WEB-27WG: 4472 events, handled=no, stack ending at processUsage.ts `isFirstUsage`, reached from route.ts `POST`. The handoff client treats 500 as non-retryable. It reports KILOCODE-WEB-2860 and the gateway does the full multi-statement write from sfo1 against the fra1 primary. Avoiding exactly that transatlantic lock hold is the reason the endpoint exists. Two more problems: the unhandled error carries the raw drizzle query and its parameters (a user id) into Sentry, and no billing record is shown to be lost today.

## Evidence

- sentry: anaconda-nq KILOCODE-WEB-2860 (7781631899). 'Error: usage record handoff to primary region failed', culprit POST /api/v1/chat/completions, 477 events from 2026-10-08 to 2026-10-28, 0 users. The latest event has tags source=recordUsageInPrimaryRegion, reason=http_500, cloud.region sfo1, handled=yes, response status 200.
- sentry: triage tag breakdown for the reason tag of KILOCODE-WEB-2860 over 30 days: http_400 252, http_500 223, TimeoutError 2.
- sentry: anaconda-nq KILOCODE-WEB-27WG. 'PostgresError: no more connections allowed (max_client_conn)', 4472 events, culprit POST /api/internal/usage/record, fra1, handled=no, mechanism auto.function.nextjs.on_request_error, db.error_code 08P01. Most relevant frame: packages/web-shared/src/lib/ai-gateway/processUsage.ts isFirstUsage (`db.query.microdollar_usage.findFirst`). Call path: route.ts:80 POST → usage-record-diagnostics.ts observeUsageRecordCompletion → processUsage.ts `const isFirst = await isFirstUsage(...)`. The event's drizzle_query context contains the raw query and its parameters.
- sentry (triage): over the same window the errors on transaction POST /api/internal/usage/record are mainly pool-acquisition failures: 'DatabaseError: timeout exceeded when trying to connect' (1593) and max_client_conn (615). Neither is the redacted 'insertUsageRecord failed (code=...)' form.
- file: packages/web-shared/src/lib/ai-gateway/processUsage.ts. `saveUsageRelatedDataLocally` awaits `isFirstUsage` (no try/catch) before `insertUsageRecord`. `insertUsageRecord` wraps its transaction retries in try/catch, falls back to `findAlreadyRecordedUsage`, reports through `describeDatabaseError` and `stackFramesUnderHeader`, and returns null. `isFirstUsage` returns early for org usage or non-zero prior usage, so it only queries for non-org users with no prior usage.
- file: packages/web-shared/src/lib/ai-gateway/usage-record-diagnostics.ts. `observeUsageRecordCompletion` uses try/finally only and logs outcome 'error' before rethrowing. `describeDatabaseError` gives a redacted {name, code, constraint, table, routine}.
- file: apps/web/src/app/api/internal/usage/record/route.ts. The only designed non-2xx is 400. A null write result becomes 200 {status:'not_recorded'}, and a comment says this is deliberately not an 'unavailable' signal, so SFO does not re-add the transatlantic lock hold.
- file: packages/web-shared/src/lib/ai-gateway/usage-record-client.ts. Retries only 429/502/503. Stops on 500 with reason http_500, calls captureException (which produces KILOCODE-WEB-2860), and returns 'unavailable'. `saveUsageRelatedData` in processUsage.ts then writes locally from SFO.
- file: apps/web/src/app/api/internal/usage/record/route.telemetry.test.ts mocks `saveUsageRelatedDataLocally`, and its test 'keeps the original persistence exception' expects the route to rethrow. packages/web-shared/src/lib/ai-gateway/first-usage-events.test.ts covers first-usage events against a real database.
- file: packages/worker-utils/src/usage-writer-client.ts. Queue callers of the same endpoint treat not_recorded and any non-2xx as 'unavailable', so for them a 500 and a not_recorded are equally negative.

## Desired outcome

A failed `isFirstUsage` read on the writer no longer escapes as an unhandled exception or an HTTP 500. The write goes ahead in Frankfurt through `insertUsageRecord`, which keeps its existing semantics: recorded, duplicate, or a reported not_recorded. The failed read is reported once, redacted, with no SQL or parameters. As a result the reason=http_500 share of KILOCODE-WEB-2860 and the KILOCODE-WEB-27WG stack through `isFirstUsage` stop recurring. A short pool hiccup no longer forces the SFO cross-region fallback, and a real write failure is not made any slower.

## Scope

- Guard the `isFirstUsage` pre-write read in `packages/web-shared/src/lib/ai-gateway/processUsage.ts` so that a rejection gives a conservative 'not first' result instead of throwing.
- Report the guarded failure in redacted form only (`describeDatabaseError`-style fields such as code and name, plus usage id), tagged so it can be told apart from `insertUsageRecord` failures. Never attach the raw drizzle error, SQL or parameters.
- Add focused tests: (a) when `findFirst` rejects, `saveUsageRelatedDataLocally` still calls the insert path and returns its outcome without throwing, and suppresses first-usage analytics; (b) the reported payload contains no query text or parameters; (c) the normal first-usage behaviour in first-usage-events.test.ts is unchanged.

## Exclusions

- Characterising or fixing the reason=http_400 subset of KILOCODE-WEB-2860 (252 events). The route's validation log line produced no drained log matches in 30 days, so its cause is unknown and needs its own investigation.
- Adding pool admission control or a 503 shedding branch to the writer route (the PR #5115 idea). That changes retry and fallback behaviour and is a separate decision.
- Changing the handoff client's retry or fallback policy, timeouts, or the route's 200/not_recorded contract.
- Fixing pool-exhaustion causes in general (pool size, Supavisor limits), or other unhandled-error paths unrelated to the pre-write read.
- Changing the route-level behaviour for exceptions other than this one. The existing test that expects persistence exceptions to propagate stays.

## Approach

- In `saveUsageRelatedDataLocally`, replace the direct `await isFirstUsage(...)` with a guarded call, either a wrapper or a try/catch inside `isFirstUsage`. On rejection, return `false` (not first) and continue to `insertUsageRecord`. Returning false is safe: it can only suppress a `first_usage` analytics event, never billing. The same redelivery race already makes `isFirst` best-effort.
- Report the swallowed read failure with only redacted fields from `describeDatabaseError(error)` plus `usageId`. Use the existing `sentryLogger(...,'warning')` / `console.warn` pattern, or a captureException of a redacted `Error` built like the one in `insertUsageRecord` with `stackFramesUnderHeader`. Use a distinct source tag (for example `isFirstUsage`) so the volume stays visible after the unhandled 27WG group goes quiet. Never pass the raw error object: its drizzle message embeds SQL and parameters.
- Leave the insert path alone. If the pool is still exhausted, `insertUsageRecord`'s bounded retries (3 attempts with short jitter) run as before and end in a recorded/duplicate result or the reported null → 200 not_recorded. That is the route's documented outcome for a failed write, so a real failure takes no extra time.
- Tests: a unit test in packages/web-shared/src/lib/ai-gateway mocks `db.query.microdollar_usage.findFirst` to reject with a pg-shaped error (code 08P01, message containing SQL text and a parameter value). It asserts the insert path is still called, the function resolves rather than rejects, no first_usage event is captured, and the reported payload contains neither the SQL nor the parameter. Keep first-usage-events.test.ts passing unchanged.
- After deploy, compare in Sentry: new KILOCODE-WEB-27WG events whose stack goes through `isFirstUsage`, the reason=http_500 count on KILOCODE-WEB-2860, and the new redacted `isFirstUsage` signal.

## Affected areas

- packages/web-shared/src/lib/ai-gateway/processUsage.ts (isFirstUsage / saveUsageRelatedDataLocally)
- packages/web-shared/src/lib/ai-gateway (new or extended unit test)
- Indirectly: apps/web/src/app/api/internal/usage/record/route.ts responses and the handoff client's fallback rate (no code change expected)

## Acceptance criteria

### ac-1: When the `isFirstUsage` database read rejects (for example a pg error with code 08P01 or a connect timeout), `saveUsageRelatedDataLocally` does not reject. It still invokes the usage insert and returns the insert's outcome: recorded, duplicate, or null. The writer route therefore answers 200 with recorded/duplicate/not_recorded instead of an unhandled 500. A unit test with a mocked rejecting `findFirst` demonstrates this.

**Verification:** Code review

### ac-2: A failed `isFirstUsage` read is treated as 'not first'. No `first_usage` event is emitted for that delivery. `first_microdollar_usage` still gets `has_prior_free_usage: true` consistent with isFirst=false. Billing values written by the insert are unaffected.

**Verification:** Code review

### ac-3: The guarded failure is reported exactly once per occurrence with a distinct source tag and only redacted fields (error name/code and usage id). The log and Sentry payload never include the SQL statement, query parameters, or the raw driver error message. A test asserts that neither a synthetic SQL fragment nor a synthetic parameter value from the rejected error appears in what is logged or captured.

**Verification:** Code review

### ac-4: Behaviour is unchanged when the read succeeds. A first write for a non-org user with zero prior usage still emits `first_usage` once, a concurrent redelivery still emits it once, and org usage or non-zero prior usage still skips the query. The existing first-usage-events tests keep these assertions unmodified.

**Verification:** Code review

### ac-5: A real write failure is not slowed down. The guard adds no retries, sleeps or extra database calls. The insert path's retry count and delays are unchanged, so a genuine failure still ends in the existing not_recorded response with no added latency.

**Verification:** Source review

### ac-6: After deploy, Sentry shows no new KILOCODE-WEB-27WG (or sibling unhandled pool-error) events whose stack goes through `isFirstUsage` from the usage-record route. The reason=http_500 occurrences of KILOCODE-WEB-2860 fall substantially compared with the ~10/day baseline. Any remaining http_500 events are checked for a different throw site.

**Verification:** Manual: after production deploy, review Sentry (anaconda-nq/kilocode-web) for KILOCODE-WEB-27WG events with an isFirstUsage frame and the KILOCODE-WEB-2860 reason=http_500 trend over at least 7 days

## Risks

- Under sustained pool exhaustion the insert will usually also fail, and the route will return 200 not_recorded. The handoff client treats that as final, with no SFO fallback, while today the accidental 500 triggers a fallback write from SFO that may succeed. For those requests the change could turn a slow-but-recorded fallback into a reported not_recorded. This matches the route's documented design for failed writes, but it is a real trade-off. Watch the `insertUsageRecord failed` volume with writer_caller=region_handoff after deploy.
- Not every http_500 on KILOCODE-WEB-2860 is proven to come from `isFirstUsage`. Other throws or a platform 500 could remain, which AC6's follow-up check covers.
- Suppressing `first_usage` on a failed read slightly undercounts a product analytics event during pool incidents.
- Accidentally reporting the raw error would leak SQL parameters. AC3's test guards against this.

## Assumptions

- `isFirstUsage` exists only to drive PostHog first-usage analytics and has no role in billing correctness. The code supports this: `isFirst` is passed only to the two analytics senders.
- The route's documented contract (a failed write is 200 not_recorded, not a retryable or fallback signal) is still the intended design. This change brings the pre-write read in line with it rather than reopening it.
- No configured baseline command catalog was found in the pinned checkout (packages/web-shared has no test script), so criteria use code review plus a manual post-deploy Sentry check.

## Decisions

### d-1: When the pre-write `isFirstUsage` read fails, should the writer continue the write (treating the user as not first) or refuse the request with a retryable status such as 503?

**Answer:** Continue the write and treat the user as not first. Nothing has been written at that point and the flag only affects analytics, so proceeding gives `insertUsageRecord` a chance to record in Frankfurt and keeps the route's documented outcomes. A 503 would just turn http_500 into http_503 fallbacks and keep the transatlantic write.

**Blocking:** no

### d-2: Should the http_400 subset of KILOCODE-WEB-2860 and writer-side 503 admission control be handled in this change?

**Answer:** No. Both are excluded. The http_400 cause is unestablished and admission control changes the retry/fallback contract, so each needs its own work item.

**Blocking:** no
