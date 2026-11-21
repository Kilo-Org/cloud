<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Answer unverifiable App Store notification signatures with a 4xx instead of a captured 500

## Problem

POST /api/kilo-pass/apple/notifications has no authentication except the JWS signature on signedPayload. When @apple/app-store-server-library's SignedDataVerifier rejects that signature (VerificationException with INVALID_CERTIFICATE / INVALID_CHAIN_LENGTH), the error escapes decodeAppleStoreNotificationJws, and the route's catch-all reports it to Sentry as a production error and returns 500. That is how Sentry issue KILOCODE-WEB-27W8 got opened. Every event in that issue came from a non-Apple caller (curl, or a desktop Chrome user agent), so the noise comes from anonymous probes. It does not show that real App Store notifications are being lost.

## Evidence

- Sentry KILOCODE-WEB-27W8 (anaconda-nq/7733780211): 4 events from 2026-09-15 to 2026-10-28, 0 users, handled, tag source=app_store_kilo_pass_notification. Stack: route.ts:21 POST -> processAppStoreKiloPassNotification (apple-store-notifications.ts:1115) -> decodeAppleStoreNotificationJws (:183) -> jws_verification.ts verifyJWT. The two thrown statuses are VerificationStatus.INVALID_CERTIFICATE (line 228) and INVALID_CHAIN_LENGTH (line 223).
- Sentry search_issue_events for KILOCODE-WEB-27W8 (90d): three events report user agent curl 7.88.1 and the latest reports Chrome 131 / Mac OS X. None look like Apple server-to-server delivery. The verifier throws INVALID_CHAIN_LENGTH when the x5c chain is not the 3-certificate chain Apple signs with.
- route.ts catches every thrown error, calls captureException(sanitizeErrorForTelemetry(error)) and returns 500. Its own comment says a request that can never succeed should not get a 5xx. route.test.ts asserts 400 with no capture for non-JSON bodies, and 500 with capture for any processing rejection.
- apple-store-sdk.ts builds SignedDataVerifier(rootCerts, enableOnlineChecks=true, env, bundleId, appAppleId). With online checks on, revocation/OCSP fetches can fail transiently. The library reports those as a distinct retryable status, and they need to keep getting 5xx and capture.
- No first-party code handles VerificationException or VerificationStatus anywhere (repository search: no matches). apps/web/package.json pins @apple/app-store-server-library 3.1.0.
- store-purchase-errors.ts convention: only a store refusal may be terminal. Database and provider failures stay retryable, and the decision is made from error types, never from message text. The Play notifications route answers 401/400 without Sentry capture for unauthenticated or malformed callers.
- Triage found other error groups on the same transaction (chained TypeError and FetchError). They are separate failure modes and have to stay 5xx and captured.

## Desired outcome

When the top-level signedPayload signature is cryptographically or structurally refused (a non-retryable VerificationException status), the endpoint returns a 4xx client error with a generic body. It does not call Sentry captureException, and it writes a minimal sanitized warning log that names the verification status. Retryable verification failures, database errors, nested-transaction failures and every other unexpected error keep the current behavior: 500 plus Sentry capture. In-flight claims stay 503.

## Scope

- Add a typed error (e.g. AppleNotificationSignatureError, carrying the VerificationStatus) in apps/web/src/lib/kilo-pass. decodeAppleStoreNotificationJws throws it only when verifyAndDecodeNotification throws a VerificationException whose status is not the library's retryable status (RETRYABLE_VERIFICATION_FAILURE).
- In route.ts, map that error type to a 4xx response with a generic error body, no captureException, and a console.warn that holds only the status name. All other errors keep the existing capture + 500 path.
- Update route.test.ts and add unit coverage in apple-store-notifications tests for the classification.

## Exclusions

- No change to verifier configuration (root certificates, environment, bundle id, online checks).
- No change to nested signedTransactionInfo verification (decodeAppleStoreTransactionJws). A transaction-level failure inside an outer payload that verified is unexpected and stays a captured 500.
- No investigation or fix for the separate TypeError / FetchError groups on this transaction.
- No rate limiting, IP allow-listing or other new caller authentication.
- No Google Play route changes.

## Approach

- In apple-store-notifications.ts (or a small sibling module), import VerificationException and VerificationStatus from @apple/app-store-server-library. Wrap only the verifyAndDecodeNotification call in decodeAppleStoreNotificationJws. If the error is an instanceof VerificationException and its status !== VerificationStatus.RETRYABLE_VERIFICATION_FAILURE, rethrow it as AppleNotificationSignatureError(status). Rethrow anything else unchanged. Before coding, confirm the status enum and the exception's status field against the installed 3.1.0 typings.
- Leave the existing payload-schema failure ('Apple notification payload missing required identifiers') as it is. It only happens after a valid Apple signature, so it stays visible.
- In route.ts, before the generic capture, add `if (error instanceof AppleNotificationSignatureError)`: log console.warn('[app-store-notification] rejected unverifiable signedPayload', { status: VerificationStatus name }) and return Response.json({ error: 'Invalid signedPayload' }, { status: 400 }). Don't log the payload, headers or certificate contents. Use 400 so the route matches its existing client-error answer for bad bodies.
- Tests: (a) route.test.ts: processing rejects with AppleNotificationSignatureError -> 400, generic body, captureException not called. The existing generic-Error -> 500 + capture test stays. (b) apple-store-notifications tests: mock the SDK verifier (or jest.mock apple-store-sdk) so verifyAndDecodeNotification throws VerificationException(INVALID_CHAIN_LENGTH) and VerificationException(INVALID_CERTIFICATE), and check that decodeAppleStoreNotificationJws throws AppleNotificationSignatureError. Throwing VerificationException(RETRYABLE_VERIFICATION_FAILURE) or a plain Error must propagate as the original error, not the typed one.

## Affected areas

- apps/web/src/lib/kilo-pass/apple-store-notifications.ts
- apps/web/src/lib/kilo-pass/apple-store-notifications.test.ts
- apps/web/src/app/api/kilo-pass/apple/notifications/route.ts
- apps/web/src/app/api/kilo-pass/apple/notifications/route.test.ts

## Acceptance criteria

### ac-1: When the top-level notification signature is refused with a non-retryable VerificationStatus (covering at least INVALID_CHAIN_LENGTH and INVALID_CERTIFICATE), the route returns HTTP 400 with a generic error body. It does not call Sentry captureException, and the warning log carries only the status name, never the payload, headers or certificates. A route test locks this in.

**Verification:** Code review

### ac-2: A VerificationException with RETRYABLE_VERIFICATION_FAILURE, any non-VerificationException error from the verifier, nested-transaction verification failures and database/processing errors still produce HTTP 500 with captureException tagged source=app_store_kilo_pass_notification. In-flight claims still return 503. Unit tests show that the retryable status and a plain Error are not converted to the typed signature error, and the existing 500-with-capture route test is kept.

**Verification:** Code review

### ac-3: Classification is decided from the error type and the VerificationStatus enum, never from error message text. That matches the store-purchase-errors.ts convention.

**Verification:** Source review

### ac-4: After deployment, new curl or browser-originated unverifiable POSTs to /api/kilo-pass/apple/notifications no longer add events to Sentry issue KILOCODE-WEB-27W8. Genuine App Store notifications keep processing; check this through kilo_pass_store_events / audit log activity.

**Verification:** Manual: After release, confirm in Sentry that KILOCODE-WEB-27W8 receives no new events and that App Store notification processing continues normally.

## Risks

- Misconfiguration masking: if APPLE_ROOT_CERTIFICATES_PEM or APPLE_IAP_ENVIRONMENT were ever wrong, genuine Apple deliveries would be refused with 400 and only logged as warnings, not raised as Sentry errors. Mitigation: the warning log includes the status, and current evidence (curl/browser callers only, 0 users) shows no genuine deliveries failing. If more visibility is wanted later, a reviewer can choose a Sentry warning-level message for INVALID_ENVIRONMENT / INVALID_APP_IDENTIFIER.
- Apple's notification retry policy may treat any non-200 as retryable. For forged payloads this doesn't matter because Apple isn't the sender. The change only claims to stop error noise, not to change Apple's retry behavior.
- Library typing drift: the status enum names and exception shape must be checked against the pinned 3.1.0 package before coding.

## Assumptions

- @apple/app-store-server-library 3.1.0 exports VerificationException (with a public status field) and VerificationStatus, including RETRYABLE_VERIFICATION_FAILURE for transient online-check failures.
- The KILOCODE-WEB-27W8 events come from non-Apple callers, based on curl / desktop-browser user agents and the INVALID_CHAIN_LENGTH outcome.
- No configured baseline command catalog was established from the pinned checkout, so criteria use code review rather than invented commands.

## Decisions

### d-1: Which HTTP status should an unverifiable signedPayload get?

**Answer:** 400, matching the route's existing client-error answer for malformed bodies. The body stays generic and does not reveal which verification step failed.

**Blocking:** no

### d-2: Should nested signedTransactionInfo verification failures also be treated as terminal?

**Answer:** No. A payload whose outer signature passed came from Apple, so a nested failure is unexpected and stays a captured 500.

**Blocking:** no

### d-3: How should refused signatures stay diagnosable without Sentry errors?

**Answer:** A sanitized console.warn naming only the VerificationStatus. No store-event row is written, because nothing trustworthy (no verified notificationUUID) is available to key it.

**Blocking:** no
