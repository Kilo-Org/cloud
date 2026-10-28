<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(web): retry session-ingest messages-page read once on transient connection reset within the 8s budget

## Problem

Sentry KILOCODE-WEB-27VE (8 events, 2026-09-10 to 2026-10-28) is a TRPCError "Failed to fetch session messages page" thrown in cliSessionsV2.getSessionMessagesPage (cli-sessions-v2-router.ts:1608, pagePromise). The cause chain is undici `TypeError: terminated`, then `read ECONNRESET`. The web app's GET /api/session/:id/messages to the session-ingest worker is idempotent, but a single socket reset fails the whole request. fetchSessionIngest has no retry, and the router turns every rejection into INTERNAL_SERVER_ERROR. The mobile app then shows "Couldn't load this session", and the user has to tap Retry by hand. Triage found the affected sessions were small and healthy: the worker served one of them with HTTP 200 in under 800 ms, 13 s before and 13 s after the failure. So this is a transient transport failure, not a slow read. Two details shape the fix. First, `fetchWithinBudget` only bounds the time until response headers arrive. Second, the router's catch also wraps `response.json()`. So a "terminated" error can come either before the response or while the body is being read.

## Evidence

- sentry: KILOCODE-WEB-27VE latest event 5a78003fdb224d0eaeea45eb54d65607 (2026-10-28T17:40:47Z, fra1, okhttp mobile client). The TRPCError is caused by TypeError: terminated (undici Fetch.onAborted / onHttpSocketClose), which is caused by Error: read ECONNRESET. Most relevant frame: cli-sessions-v2-router.ts:1608. 8 occurrences, 0 users.
- axiom (triage): router lines for the two 2026-10-28 events read '...: terminated' and involve two different sessions. Over 30 days the cause mix was about 1567 8s-budget timeouts, 342 worker 500s, 6 'fetch failed', 3 'terminated' and 7 other. Session-ingest logs show one of the affected sessions served with HTTP 200 just before and just after its failure.
- file: apps/web/src/lib/session-ingest-client.ts:126 `fetchSessionIngest` wraps `fetchWithinBudget` with no retry. `fetchSessionMessagesPage` (around line 240) calls it, then reads `response.json()` outside the budget.
- file: apps/web/src/lib/bounded-service-fetch.ts: CONTROL_PLANE_UPSTREAM_BUDGET_MS = 8000, kept strictly under the mobile CONTROL_PLANE_DEADLINE_MS of 15000. `FetchWithinBudgetDeps.budgetMs` can override the budget. The timer is cleared once headers arrive.
- file: apps/web/src/routers/cli-sessions-v2-router.ts (getSessionMessagesPage) maps any page-fetch rejection to INTERNAL_SERVER_ERROR 'Failed to fetch session messages page' as a deliberate stable contract.
- file: apps/web/src/lib/user/deletion-queue/deletion-http.ts:44 and apps/web/src/tests/openrouterApi.timeout.test.ts already treat ECONNRESET / 'fetch failed' as transient. That gives a precedent for classifying these errors.
- history (triage): PRs #7379 and #7393 address the dominant timeout and worker-500 failures on this path. No PR mentions KILOCODE-WEB-27VE.

## Desired outcome

When a single connection reset hits the messages-page read, before or during the response, the read is retried once and the page loads normally. Genuine failures still fail quickly with the same INTERNAL_SERVER_ERROR contract: budget timeouts, HTTP error statuses, schema mismatches, caller aborts, and a second reset. The total time a request can wait stays within the existing 8s upstream budget, so a genuine failure never takes longer to surface than it does today.

## Scope

- Add a bounded transient-transport retry to `fetchSessionMessagesPage` in apps/web/src/lib/session-ingest-client.ts. It covers the full attempt: fetch, status handling and `response.json()`.
- Add a small helper that classifies transient transport errors. It should match undici `TypeError` 'terminated' and 'fetch failed', and causes with socket codes such as ECONNRESET, EPIPE and UND_ERR_SOCKET. It must exclude ServiceFetchTimeoutError and caller aborts.
- Share one deadline between attempts. The retry gets only the remaining part of CONTROL_PLANE_UPSTREAM_BUDGET_MS, passed via `fetchWithinBudget`'s budget override or an equivalent. If too little budget remains, skip the retry.
- Add unit tests in apps/web/src/lib/session-ingest-client.test.ts.

## Exclusions

- The dominant 8s-timeout and worker-500 failures on this path (KILOCODE-WEB-2822 family, #7379, #7393). Those are not retried here.
- Retrying HTTP error responses (5xx, 4xx) or non-idempotent session-ingest calls (share, unshare, delete, invalidate).
- Changing the router's INTERNAL_SERVER_ERROR contract, the mobile error surface, or CONTROL_PLANE_UPSTREAM_BUDGET_MS.
- Changes to the session-ingest worker, or pinning down at the socket level why the connection closed.

## Approach

- In session-ingest-client.ts, add `isTransientTransportError(error)`. It returns false for ServiceFetchTimeoutError and AbortError / caller-abort reasons. It returns true for TypeError whose message is 'terminated' or 'fetch failed', or whose `cause` chain (bounded depth) has code ECONNRESET, EPIPE, UND_ERR_SOCKET or ECONNREFUSED.
- Restructure `fetchSessionMessagesPage` so that one attempt covers request, status checks and JSON body parse. Record `startedAt` and run the attempt. If it throws a transient transport error and the remaining budget (CONTROL_PLANE_UPSTREAM_BUDGET_MS minus elapsed) is above a small floor (about 1s), run exactly one more attempt with the remaining budget as its fetch budget. Otherwise rethrow the original error. Thread the budget through fetchSessionIngest (an optional budgetMs param passed to fetchWithinBudget's deps). A fresh internal token per attempt is fine.
- Emit one allow-listed JSON log line per retry, following the session_ingest_timeout pattern: type 'session_ingest_transport_retry', the redacted route, attempt number, elapsed ms, and outcome 'retry' or 'retry_failed'. It must never include the session id, token, Authorization header or query string. This keeps the class visible in Axiom.
- Keep everything else unchanged: the 404 → null mapping, captureException on HTTP error and schema mismatch (no retry for either), and the rejection that propagates to the router's existing catch.
- Tests use the existing mockFetch harness. Cover: reset then success; body-read 'terminated' then success; two resets; timeout not retried; HTTP 500 not retried; insufficient remaining budget; and a check that the log line has no secrets.

## Affected areas

- apps/web/src/lib/session-ingest-client.ts (fetchSessionIngest budget passthrough, fetchSessionMessagesPage retry, transient-error classifier)
- apps/web/src/lib/session-ingest-client.test.ts (new fetchSessionMessagesPage retry cases)

## Acceptance criteria

### ac-1: When the first worker fetch rejects with a TypeError('terminated') whose cause has code ECONNRESET, or with TypeError('fetch failed'), and the second attempt returns a valid 200 page, fetchSessionMessagesPage resolves with that page. The fetch is called exactly twice, and no exception reaches the router.

**Verification:** Code review

### ac-2: If the first response's `json()` rejects with TypeError('terminated') (a reset during the body read) and the retry succeeds, fetchSessionMessagesPage resolves with the retried page.

**Verification:** Code review

### ac-3: None of the following trigger a retry; each propagates after a single attempt with today's error shape: ServiceFetchTimeoutError, a caller abort, an HTTP 500 or other non-OK status (captureException still fires once), a schema mismatch, and 404 (still returns null). A second consecutive transient error propagates after exactly two attempts.

**Verification:** Code review

### ac-4: Both attempts together are bounded by CONTROL_PLANE_UPSTREAM_BUDGET_MS (8000 ms). The retry's fetch budget is the remaining budget. If the remaining budget is below the floor, no retry is made and the original error propagates. So the worst-case wait for a genuine failure is no longer than before the change. A test with a near-exhausted budget or fake timers shows the retry is skipped or receives only the remaining budget.

**Verification:** Code review

### ac-5: The retry log line contains only the type, redacted route, attempt, elapsed ms and outcome. A test asserts it contains no session id, token, Authorization header or query string.

**Verification:** Code review

### ac-6: The router's getSessionMessagesPage error contract is unchanged: if the retry also fails, the client still receives INTERNAL_SERVER_ERROR 'Failed to fetch session messages page'.

**Verification:** Source review

## Risks

- Retrying an idempotent GET is safe. The only extra cost is at most one more worker read per transient failure.
- The classifier could be too broad and retry errors that are not transient. Keeping it limited to undici's terminated/fetch-failed errors and socket codes, and excluding timeouts and aborts, limits this.
- Effect on genuine failures: the shared deadline keeps the total wait at or under 8s. A transient reset late in the budget is simply not retried, so the user sees today's retryable error. Both effects should be stated in the PR verification, as AGENTS.md Failure UX requires.
- Low volume (about 3–9 per month) means production confirmation will be slow. Use the new retry log line in Axiom to confirm recoveries.

## Assumptions

- The 'terminated' errors come from a transient socket close on the Vercel → session-ingest connection. Triage evidence shows healthy worker reads either side of the failures, so an immediate retry is likely to succeed.
- Applying the retry only to fetchSessionMessagesPage, the path this Sentry issue covers, is enough for now. Other idempotent session-ingest GETs can adopt the helper later.
- Unit tests with the existing jest harness in apps/web (`NODE_ENV=test jest`) are enough verification. No live reproduction of a socket reset is required.

## Decisions

### d-1: Retry inside the web server (session-ingest client) or leave recovery to the mobile client's manual Retry as documented today?

**Answer:** Add one bounded server-side retry for transport-level resets only, inside the existing 8s budget. This follows AGENTS.md Failure UX (do not fail on a transient condition; retry within a bound). The comments' INTERNAL_SERVER_ERROR contract is kept for real failures. Triage had recommended deferring; this plan applies the narrow fix because it is small and does not lengthen genuine failures.

**Blocking:** no

### d-2: Limit the retry to the messages-page read or apply it to every session-ingest call?

**Answer:** Messages-page read only, the path in this Sentry issue. Mutating calls are excluded, and other GETs can opt in later.

**Blocking:** no
