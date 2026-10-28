<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Return 401 instead of 500 when a malformed cookie makes next-auth getServerSession throw during session auth

## Problem

Session-protected App Router API routes (/api/user, /api/profile, /api/profile/usage, /api/profile/balance) return an unhandled 500 when a request has a malformed Cookie header. Sentry reports these errors as KILOCODE-WEB-28HC. The error is thrown inside next-auth 4.24.15 getServerSession, called from resolveUserFromSession (packages/web-shared/src/lib/user/server.ts:375). After an invalid session token fails to decrypt (JWT_SESSION_ERROR / Invalid Compact JWE), next-auth tries to re-serialize cookies that clear the session. cookie@0.7.2 serialize() then rejects a cookie name that came from the request: TypeError 'argument name is invalid'. Our code never catches the exception, so it reaches Next's onRequestError and is reported to Sentry as unhandled. The intended response for a missing or invalid session is the existing authError(401, 'Unauthorized').

## Evidence

- Sentry KILOCODE-WEB-28HC (anaconda-nq/7816846531, kilocode-web): TypeError 'argument name is invalid', handled=no, mechanism auto.function.nextjs.on_request_error, 6 events between 15:40:03Z and 15:40:26Z on 2026-10-28, 0 users, all from a curl 7.88.1 client, App Router route GET /api/user, release fd18005162dd.
- Sentry stack of the latest event: route.ts GET -> server.ts:162 getUserFromAuth -> server.ts:375 resolveUserFromSession -> next-auth/next/index.js:143 getServerSession `cookies.forEach(cookie => setCookie(res, cookie))` -> next-auth/next/utils.js:21 setCookie -> cookie@0.7.2 serialize throws.
- Triage (from Sentry breadcrumbs): a JWT_SESSION_ERROR 'Invalid Compact JWE' was logged 3 ms before the throw, so the session-token cookie was not a valid session.
- Repo at 09eb2221: getServerSession(sessionAuthOptions) is called at server.ts:112 (getUserFromSession) and server.ts:375 (resolveUserFromSession), and neither call is wrapped in try/catch. The only other caller is apps/web/src/app/users/accept-invite/[token]/page.tsx:22, which uses authOptions.
- packages/web-shared/src/lib/user/server.test.ts already mocks next-auth getServerSession through mockGetServerSession, so session-read failure cases can be unit-tested there.
- Unavailable: the next-auth source in node_modules could not be read, and Sentry does not capture request cookies. The exact malformed cookie name and next-auth's line-level intent are therefore inferred from the stack, not confirmed.

## Desired outcome

An unauthenticated request whose cookies make getServerSession throw gets the normal 401 'Unauthorized' auth failure. It no longer produces an unhandled 500 or a Sentry error event. Valid sessions and every other auth path behave exactly as before.

## Scope

- Add a small internal helper in packages/web-shared/src/lib/user/server.ts that calls getServerSession(sessionAuthOptions). If the call throws, the helper returns null (no session). Both getUserFromSession and resolveUserFromSession use the helper.
- Unit tests in packages/web-shared/src/lib/user/server.test.ts for the throwing case and for unchanged valid-session behavior.

## Exclusions

- No patch or upgrade of next-auth or cookie, and no cookie-header sanitizing middleware.
- No change to authOptions, the sign-in flows, the accept-invite page's getServerSession(authOptions) call, or the bearer-token auth path.
- No change to Sentry configuration. sendDefaultPii and cookie capture stay off.

## Approach

- In server.ts, add `async function readSession(): Promise<Session | null>`. It wraps `await getServerSession(sessionAuthOptions)` in try/catch and returns null on any thrown error. getServerSession with the JWT strategy does no DB or network I/O; it only parses, decrypts and re-serializes cookies. A throw here therefore means the request's cookies are unusable, and treating that as 'no session' is correct. Keep next-auth's own logger behavior unchanged. Do not call captureException in the catch. At most add a warning-level breadcrumb or log with no cookie or header values, following the Security Baseline.
- Replace both direct calls (getUserFromSession at line 112, resolveUserFromSession at line 375) with readSession(). resolveUserFromSession then reaches the existing `if (!maybeKiloUserId) return authError(401, 'Unauthorized', '?')` branch. getUserFromSession returns null, which matches its documented 'no valid session' contract.
- Tests: make mockGetServerSession reject with `new TypeError('argument name is invalid')`, then assert that getUserFromAuth({adminOnly:false}) without an Authorization header returns user null and a 401 authFailedResponse, and that getUserFromSessionForCredentialIssuance does the same. Keep or add a check that a resolved valid session still authenticates the user.

## Affected areas

- packages/web-shared/src/lib/user/server.ts
- packages/web-shared/src/lib/user/server.test.ts
- Indirectly, every session-authenticated route that uses getUserFromAuth, getUserFromSession or the credential-issuance helpers (web and ai-gateway).

## Acceptance criteria

### ac-1: When getServerSession throws (simulated with TypeError 'argument name is invalid'), getUserFromAuth on a request without an Authorization header resolves, without throwing, to user null and an authFailedResponse with HTTP status 401. A unit test in server.test.ts covers this.

**Verification:** Code review

### ac-2: getUserFromSession resolves to null, and getUserFromSessionForCredentialIssuance returns a 401 failure instead of throwing, when getServerSession throws. Every getServerSession(sessionAuthOptions) call in server.ts goes through the single guarded helper.

**Verification:** Code review

### ac-3: Regression: a valid session (getServerSession resolving with a kiloUserId of an existing, current user) still authenticates exactly as before, and the bearer-token path is unchanged. A test covers the valid-session case.

**Verification:** Code review

### ac-4: The catch path does not report the error to Sentry as an exception, and does not log cookie values, header values or token contents.

**Verification:** Source review

### ac-5: After deployment, sending a malformed Cookie header (for example a next-auth session-token cookie with an invalid value plus an invalid-named session-token-prefixed cookie) to GET /api/user returns 401, and Sentry records no new KILOCODE-WEB-28HC event for it.

**Verification:** Manual: reproduce against a preview or local deployment with curl using a crafted Cookie header, and confirm a 401 response and no new Sentry event

## Risks

- A blanket catch could hide a real next-auth misconfiguration, such as a missing secret, by turning it into 401s for everyone. Mitigation: next-auth's logger still routes its own errors (for example JWT_SESSION_ERROR) to Sentry via sentryLogger at error level, and NEXTAUTH_SECRET is validated at config load. The implementer may narrow the catch to TypeError if review prefers that.
- The exact malformed cookie name is unknown, so the regression test simulates the throw at the getServerSession boundary rather than reproducing next-auth's internals. AC-5 covers the end-to-end manual check.
- Failure UX: a genuine auth failure still returns 401 immediately, with no added wait. Only the 500 becomes a 401.

## Assumptions

- Under the App Router, next-auth's response setCookie target is effectively a no-op, so suppressing the throw loses no real cookie writes.
- Requests with malformed cookie names come only from crafted, non-browser clients. Real browsers do not send them.
- The existing jest setup for packages/web-shared (DB-backed helpers in server.test.ts) is the right place for the new tests.

## Decisions

### d-1: Fix at our call site, not by patching next-auth or sanitizing cookies in middleware.

**Answer:** Yes: a guarded helper around getServerSession in server.ts is the smallest change that covers all session-read callers.

**Blocking:** no

### d-2: Should scanner-triggered auth-path 500s be hardened now rather than the Sentry issue being archived?

**Answer:** Harden now with the small change. Priority is low, and the team may defer it without risk.

**Blocking:** no
