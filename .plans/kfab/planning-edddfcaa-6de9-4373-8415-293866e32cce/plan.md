<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(cloud-agent-next): return tRPC error envelopes from pre-adapter failures so session runtime reads fail legibly

## Problem

Opening a cloud session sometimes fails with HTTP 500 from `cliSessionsV2.getWithRuntimeState` ("Failed to fetch session runtime state", Sentry KILOCODE-WEB-27S8). The web router calls the cloud-agent-next worker's `/trpc/getSession`. When the worker fails before its tRPC adapter runs (observed: a Postgres failure in the bearer-token pepper lookup inside `validateKiloToken`, called without a try/catch from `authMiddleware`), the error reaches Hono's global `app.onError(createErrorHandler(...))`. That handler returns `{ error: 'Internal server error' }`, which is not a tRPC envelope. The web tRPC client then throws `TransformResultError` ("Unable to transform response from server", Sentry KILOCODE-WEB-27RK). The router cannot classify that error, so it wraps it as an opaque INTERNAL_SERVER_ERROR. The real cause, a retryable worker-side outage, is hidden, every such failure creates two Sentry groups, and callers cannot tell a transient outage from a defect.

## Evidence

- Sentry KILOCODE-WEB-27S8 (latest event f376fb43…, 2026-10-29T04:54Z, 21 events since 2026-08-25): `TRPCError: Failed to fetch session runtime state` thrown at apps/web/src/routers/cli-sessions-v2-router.ts:1857. The chained cause is `TRPCClientError: Unable to transform response from server` from tRPC httpLink → transformer.ts `TransformResultError`.
- Triage (Sentry KILOCODE-WEB-27RK, same trace 62e883bf…): the failure was captured with tags source=cloud-agent-next-client, endpoint=getSession. This places the failure on the web→worker hop.
- Triage (Axiom cloudflare-logpush): cloud-agent-next `/trpc/getSession` returned 14×500 between 2026-10-29T04:50 and 04:59Z, with Outcome ok and no Cloudflare exception. Worker logs show `Unhandled error` for a failed `kilocode_users` pepper query, with stack findKiloUserPepper → verifyKiloBearerAgainstCurrentPepper → validateKiloToken. The same failure also hit other procedures (getWorktreeChanges, getSessionHealth, prepareSession).
- Triage (Axiom vercel): at 04:53:20Z the web app logged `Failed to fetch runtime state … Unable to transform response from server` for a 500 response, while other requests to the same procedure in the same minute returned 200.
- Pinned code services/cloud-agent-next/src/middleware/auth.ts awaits `validateKiloToken(...)` without try/catch. validate-kilo-token.ts does not catch errors from `verifyKiloBearerAgainstCurrentPepper`. Only the later `verifyKiloTokenForResource` call is wrapped.
- Pinned code services/cloud-agent-next/src/server.ts registers `app.onError(createErrorHandler(logger, { includeMessage: false }))`. packages/worker-utils/src/error-handler.ts always returns the JSON `{ error: 'Internal server error' }` with status 500, which is not a tRPC envelope.
- Pinned code services/cloud-agent-next/src/trpc-error.ts already provides `buildTrpcErrorResponse(status, message, path)`, which emits a proper tRPC error envelope with `data.clientError.retryable` (503 maps to SERVICE_UNAVAILABLE, retryable). Auth and balance middleware already use it for expected failures. session-access.ts already maps a DB failure to SERVICE_UNAVAILABLE ('temporarily unavailable').
- Pinned code apps/web/src/routers/cli-sessions-v2-router.ts `isSessionNotFoundError` only recognizes NOT_FOUND/404. Every other worker failure becomes INTERNAL_SERVER_ERROR. Test 'preserves runtime failures for current workspace identifiers' (cli-sessions-v2-router.test.ts ~2077) asserts that behavior for a generic Error.
- Related Sentry KILOCODE-WEB-27SN (per triage): the same wrapper and culprit, but caused by HeadersTimeoutError/fetch failed. PR #7934 previously fixed only unsupported or legacy runtime identifiers.
- apps/web/src/components/cloud-agent-next/fetched-session-data.ts derives isInitiated, isPreparingAsync, mode, model, prompt and routeReady from runtimeState. A null runtimeState therefore means 'no runtime or legacy session' to the SDK, not 'runtime state unknown'.

## Desired outcome

Every failure that cloud-agent-next returns on `/trpc/*`, including failures before the tRPC adapter runs, is a valid tRPC error envelope that the web client can parse. An auth-time database outage is reported as a retryable SERVICE_UNAVAILABLE instead of an opaque 500. `getWithRuntimeState` returns a specific error code that matches the worker's classification. Transient and transport failures (worker 503, timeouts, network) become a retryable SERVICE_UNAVAILABLE ("temporarily unavailable"). Genuine defects stay INTERNAL_SERVER_ERROR. Logs and Sentry show the real cause instead of "Unable to transform response from server".

## Scope

- services/cloud-agent-next auth middleware: catch exceptions thrown by `validateKiloToken`. Return a tRPC envelope via `buildTrpcErrorResponse(503, <non-sensitive 'temporarily unavailable' message>, procedureName)` and log the error without token material.
- services/cloud-agent-next server global error handling: for requests under `/trpc/`, return a tRPC error envelope (`buildTrpcErrorResponse(500, 'Internal server error', procedureName)`) instead of the generic JSON body, and keep logging. Other routes keep their current response shape.
- apps/web cli-sessions-v2-router `getWithRuntimeState`: classify non-NOT_FOUND runtime-state failures. A worker tRPC error with httpStatus 503 / SERVICE_UNAVAILABLE / retryable clientError, or a transport failure (fetch failed / timeout), becomes `TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Session runtime state is temporarily unavailable', cause })`. All other errors keep INTERNAL_SERVER_ERROR 'Failed to fetch session runtime state'. The NOT_FOUND legacy path is unchanged.
- Unit tests for each change, including updating or extending the existing 'preserves runtime failures' router test.

## Exclusions

- Do not change `packages/worker-utils/src/error-handler.ts`. It is shared by other workers with non-tRPC routes, so the fix stays scoped to cloud-agent-next's `/trpc/*` path.
- Do not return session metadata with `runtimeState: null` on transient failures. The SDK reads null as 'not initiated / legacy', which would show a wrong session state (see Decision).
- No infrastructure investigation of the 2026-10-29 Hyperdrive/Postgres failures (triage M1). That is a separate follow-up.
- No new retry loops in the web router or the worker. Existing client-side retry for a retryable failure is relied on.
- No changes to mobile or extension clients, and no changes to other session-read wrappers (getSessionMessages and others) beyond the shared classification helper, if one is extracted.

## Approach

- Worker auth: in `services/cloud-agent-next/src/middleware/auth.ts`, wrap the `validateKiloToken` call in try/catch. On a throw, log `logger.withFields({ error: message }).error('Authentication check unavailable')` with no headers or token, then return `buildTrpcErrorResponse(503, 'Authentication is temporarily unavailable', extractProcedureName(pathname) ?? undefined)`. Behavior for a `{ success: false }` result is unchanged (401). Rationale: a DB outage during token validation is transient and not an invalid credential, so it must not become a 401, which would sign the user out or show a misleading message.
- Worker global handler: in `services/cloud-agent-next/src/server.ts`, replace `app.onError(createErrorHandler(...))` with a small handler. For a `/trpc/` path it logs as before ('Unhandled error' with message and stack) and returns `buildTrpcErrorResponse(500, 'Internal server error', procedureName)`. Otherwise it delegates to the existing `createErrorHandler(logger, { includeMessage: false })`. Keep the raw error message out of the response body, as the current includeMessage:false does. This guarantees that any future pre-adapter throw (auth, balance, validateBalanceOnly) stays parseable.
- Web router: add a small `isTransientRuntimeError(err)` helper next to `isSessionNotFoundError` in cli-sessions-v2-router.ts. It returns true for a TRPCClientError with data/shape code SERVICE_UNAVAILABLE or TIMEOUT, httpStatus 503/504, or `clientError.retryable === true`, and for a TRPCClientError whose cause is a fetch/transport failure (TypeError 'fetch failed', HeadersTimeoutError, AbortError). In the catch block, NOT_FOUND keeps today's legacy path. A transient error logs and throws `TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Session runtime state is temporarily unavailable', cause: error })`. Anything else keeps the current INTERNAL_SERVER_ERROR throw. Do not treat TransformResultError as transient: once the worker fix ships it indicates a real contract defect and should stay a 500.
- Tests: cloud-agent-next `middleware/auth.test.ts`: when `validateKiloToken` rejects, the response is 503 with a parseable tRPC envelope (error.code SERVICE_UNAVAILABLE, data.clientError.retryable true, path set), `next` is not called, and nothing token-like appears in logs. Add a server-level or app-level test: an exception thrown in `/trpc/*` middleware returns a tRPC envelope with status 500, and a non-trpc route keeps `{ error: 'Internal server error' }`. Web router test: keep the generic-Error case asserting INTERNAL_SERVER_ERROR. Add cases where `mockGetSession` rejects with a TRPCClientError carrying httpStatus 503 / SERVICE_UNAVAILABLE and with a transport-failure cause, expecting SERVICE_UNAVAILABLE. Confirm the NOT_FOUND legacy case is unchanged.
- Check web consumers (CloudAgentProvider / CloudChatPage / PrefetchedCloudChat) for code-specific handling of `getWithRuntimeState` errors. Confirm that SERVICE_UNAVAILABLE still reaches the existing error/retry state and is not treated as terminal. Adjust only if a consumer special-cases INTERNAL_SERVER_ERROR.

## Affected areas

- services/cloud-agent-next/src/middleware/auth.ts
- services/cloud-agent-next/src/middleware/auth.test.ts
- services/cloud-agent-next/src/server.ts (onError registration) plus a focused test
- apps/web/src/routers/cli-sessions-v2-router.ts (getWithRuntimeState catch block, new helper)
- apps/web/src/routers/cli-sessions-v2-router.test.ts (getWithRuntimeState stored runtime identifiers block)

## Acceptance criteria

### ac-1: When `validateKiloToken` throws (for example the DB pepper lookup fails) for a `/trpc/<procedure>` request, cloud-agent-next responds with HTTP 503 and a valid tRPC error envelope: `error.code` is the SERVICE_UNAVAILABLE numeric code, `error.data.code` is 'SERVICE_UNAVAILABLE', `error.data.clientError.retryable` is true, and `error.data.path` is the procedure. The downstream handler is not invoked, and the logged fields contain the error message but no authorization header or token. A `{ success: false }` validation result still returns the existing 401 envelope unchanged. Covered by new and updated cases in services/cloud-agent-next/src/middleware/auth.test.ts.

**Verification:** Code review

### ac-2: Any unhandled exception raised while serving a `/trpc/*` request in cloud-agent-next returns HTTP 500 with a tRPC error envelope ('Internal server error', data.code INTERNAL_SERVER_ERROR) that a tRPC httpLink client can parse without `TransformResultError`, and it is still logged as 'Unhandled error'. Non-`/trpc` routes keep the current `{ error: 'Internal server error' }` body. The raw error message is not included in either response body. Covered by a focused cloud-agent-next test.

**Verification:** Code review

### ac-3: `cliSessionsV2.getWithRuntimeState` for a supported workspace_ identifier throws TRPCError SERVICE_UNAVAILABLE ('Session runtime state is temporarily unavailable') when the worker getSession call fails with a TRPCClientError carrying httpStatus 503 / code SERVICE_UNAVAILABLE / retryable clientError, or with a transport failure (fetch failed or headers timeout). A generic or unclassified failure still throws INTERNAL_SERVER_ERROR 'Failed to fetch session runtime state'. NOT_FOUND/404 still returns metadata with `runtimeState: null`. Ownership and organization checks still run before the runtime read. Covered by router tests in cli-sessions-v2-router.test.ts.

**Verification:** Code review

### ac-4: Web consumers of `getWithRuntimeState` (CloudAgentProvider, CloudChatPage, PrefetchedCloudChat, session fork) still show the existing retryable error state for a SERVICE_UNAVAILABLE failure. None treats it as a terminal not-found or unauthorized state.

**Verification:** Source review

### ac-5: After deployment, new occurrences caused by worker pre-adapter failures no longer appear under KILOCODE-WEB-27RK ('Unable to transform response from server') for endpoint getSession. Any recurrence of a worker DB outage shows a SERVICE_UNAVAILABLE cause instead of TransformResultError.

**Verification:** Manual: after release, check Sentry groups KILOCODE-WEB-27S8 and KILOCODE-WEB-27RK and Axiom cloudflare-logpush for /trpc/getSession 5xx bodies and cause

## Risks

- Failure-UX effects. Spurious-failure side: a transient worker outage is now labeled retryable/temporarily-unavailable and its real cause is visible, but the request still fails during the outage (no added retry), so users still see the retry state for its duration. Genuine-failure side: no added wait, because there are no new retries or timeouts and genuine defects still return 500 immediately.
- Changing the auth-time throw from 500 to 503 could change how other web callers (getWorktreeChanges, prepareSession, getSessionHealth and others) react. These callers already handle tRPC envelopes from the same middleware, so they should improve. Confirm that no caller treats SERVICE_UNAVAILABLE as fatal.
- Sentry grouping changes: SERVICE_UNAVAILABLE errors may group differently or be filtered, depending on the web app's tRPC Sentry middleware configuration. Verify that the outage is still observable (the worker logs remain).
- Detecting transport failures by cause shape (undici error names) is somewhat brittle. Keep the helper conservative, and fall back to INTERNAL_SERVER_ERROR when unsure.

## Assumptions

- `buildTrpcErrorResponse` produces an envelope that tRPC v11 httpLink parses (it is already used for 401/403/balance failures that the web client handles).
- The 2026-10-29 burst came from a transient DB outage (triage H4). Its infrastructure cause is out of scope.
- Existing client UIs already offer retry for non-NOT_FOUND errors on session open (per PR #6111 behavior).

## Decisions

### d-1: Should getWithRuntimeState degrade to returning metadata with runtimeState null on transient runtime-read failures, or keep failing with a more specific code?

**Answer:** Keep failing, but with a specific retryable SERVICE_UNAVAILABLE code. A null runtimeState is read by the SDK (toFetchedSessionData) as 'not initiated / not preparing', which would show a wrong session phase and could prompt wrong actions. Adding an explicit 'runtime unavailable' flag would need SDK, mobile and extension changes and is out of scope for this bug.

**Blocking:** no

### d-2: Where should the non-tRPC 500 body be fixed: the shared worker-utils error handler or cloud-agent-next only?

**Answer:** cloud-agent-next only, for `/trpc/*` paths, plus an explicit catch in auth middleware. The shared handler serves non-tRPC workers and routes whose callers expect the current JSON shape.

**Blocking:** no

### d-3: How should an auth-time DB failure be classified?

**Answer:** As 503 SERVICE_UNAVAILABLE (retryable), consistent with session-access.ts's handling of DB failures. Not as 401, which would misreport a valid credential as invalid.

**Blocking:** no
