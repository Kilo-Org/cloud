<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Answer App Store notifications whose signedPayload fails verification (incl. VERIFICATION_FAILURE) with a 4xx instead of a captured 500

## Problem

Sentry KILOCODE-WEB-28A5 (4 events since 2026-10-20, 0 users, curl user agent, production) fails in POST /api/kilo-pass/apple/notifications. decodeAppleStoreNotificationJws (apps/web/src/lib/kilo-pass/apple-store-notifications.ts:183) calls SignedDataVerifier.verifyAndDecodeNotification, which throws VerificationException(VERIFICATION_FAILURE) because the posted JWS decodes to null (nested TypeError reading notificationType). Nothing classifies the exception, so the route's catch-all reports it to Sentry and returns 500. The endpoint's only authentication is the JWS signature, so any anonymous caller posting a malformed or unsigned payload creates a production error. This is the same path as #9045 / KILOCODE-WEB-27W8 (INVALID_CERTIFICATE / INVALID_CHAIN_LENGTH), which planning PR #9049 targets. That plan names only the certificate and chain statuses as examples and does not name VERIFICATION_FAILURE.

## Evidence

- sentry: anaconda-nq KILOCODE-WEB-28A5 (7802821771), latest event f25ef7e5ead04b3986b4bfde1e6f9acf. Frames: route.ts:21 -> apple-store-notifications.ts:1115 -> :183 -> jws_verification.ts:244, which throws VerificationException(VerificationStatus.VERIFICATION_FAILURE). Nested TypeError 'Cannot read properties of null (reading notificationType)' in ResponseBodyV2DecodedPayload.validate. Tags: browser curl 7.88.1, source app_store_kilo_pass_notification, release ebf5c14b.
- file: apps/web/src/app/api/kilo-pass/apple/notifications/route.ts. It returns 400 for non-JSON bodies and a missing signedPayload. Every other thrown error goes to captureException(sanitizeErrorForTelemetry(error)) and returns 500.
- file: apps/web/src/lib/kilo-pass/apple-store-notifications.ts:178-199. decodeAppleStoreNotificationJws has no try/catch around verifyAndDecodeNotification.
- file: apps/web/src/lib/kilo-pass/apple-store-sdk.ts:54-71. createAppleStoreSignedDataVerifier builds the SignedDataVerifier with online checks enabled (true), so some failures can be transient or retryable.
- file: apps/web/src/app/api/kilo-pass/apple/notifications/route.test.ts. Covers the 400 cases and the generic 500 capture, but not verification failures. A repo search finds no VerificationException or VerificationStatus handling in apps/web.
- pull_request: Kilo-Org/cloud#9049 (planning spec, closes #9045). It plans a typed AppleNotificationSignatureError for non-retryable VerificationException statuses, mapped in route.ts to a 4xx with no capture and a status-only console.warn.

## Desired outcome

A signedPayload that Apple's verifier refuses for a non-retryable reason, explicitly including VERIFICATION_FAILURE (malformed or null-decoding JWS) as well as the certificate and chain statuses from #9045, gets a generic 4xx response. It is not reported to Sentry, and it produces only a minimal warning log naming the verification status. Retryable verification failures and all other errors keep the current 500 + Sentry capture behavior. One change resolves both KILOCODE-WEB-28A5 and KILOCODE-WEB-27W8.

## Scope

- Classify VerificationException thrown by verifyAndDecodeNotification inside decodeAppleStoreNotificationJws into a typed signature error that carries the VerificationStatus.
- Define the non-retryable set as every VerificationStatus except the library's retryable status (RETRYABLE_VERIFICATION_FAILURE in @apple/app-store-server-library 3.1.0) and OK. This explicitly includes VERIFICATION_FAILURE, INVALID_CERTIFICATE, INVALID_CHAIN_LENGTH, INVALID_APP_IDENTIFIER and INVALID_ENVIRONMENT.
- Map the typed error in route.ts to a 4xx response with a generic body, no captureException, and a console.warn that contains only the status name.
- Add unit tests for the classification and route tests for the 4xx and no-capture behavior.

## Exclusions

- No change to nested signedTransactionInfo verification, to database or processing error handling, or to the 503 in-flight behavior.
- No rate limiting, IP allow-listing, or other authentication changes for the endpoint.
- No change to how Apple root certificates or the verifier are configured.

## Approach

- Coordinate with #9049 / #9045. If #9049's implementation lands first, this work shrinks to making sure its non-retryable set includes VERIFICATION_FAILURE, plus a regression test for the null-JWS case. Otherwise, implement the full change below and reference both Sentry issues (Fixes KILOCODE-WEB-28A5, KILOCODE-WEB-27W8).
- In apps/web/src/lib/kilo-pass (beside apple-store-notifications.ts), add AppleNotificationSignatureError(status: VerificationStatus). Wrap only the verifyAndDecodeNotification call in decodeAppleStoreNotificationJws with try/catch. If the error is an instanceof VerificationException and its status is non-retryable, throw AppleNotificationSignatureError with a cause-free, payload-free message. Otherwise rethrow the original error. Leave the later schema-parse failure ('missing required identifiers') unchanged.
- Import VerificationException and VerificationStatus from @apple/app-store-server-library. Keep a single exported helper, such as isNonRetryableAppleVerificationStatus, so the set can be tested directly.
- In route.ts, before the generic capture, check for AppleNotificationSignatureError. On a match, console.warn a short message with the status name only, never the payload, and return Response.json({ error: 'Invalid signedPayload' }, { status: 400 }). Use the same 4xx code #9049 settles on if it differs.
- Tests: route.test.ts mocks processAppStoreKiloPassNotification to reject with AppleNotificationSignatureError and expects a 4xx, the generic body, and that captureException is not called. The existing generic-error test stays as the 500 + capture regression. In apple-store-notifications.test.ts (or a new focused test), mock the verifier to throw VerificationException(VERIFICATION_FAILURE), INVALID_CERTIFICATE, and the retryable status, and assert the classification for each.

## Affected areas

- apps/web/src/lib/kilo-pass/apple-store-notifications.ts
- apps/web/src/lib/kilo-pass/apple-store-notifications.test.ts
- apps/web/src/app/api/kilo-pass/apple/notifications/route.ts
- apps/web/src/app/api/kilo-pass/apple/notifications/route.test.ts

## Acceptance criteria

### ac-1: When verifyAndDecodeNotification throws VerificationException with VERIFICATION_FAILURE (the KILOCODE-WEB-28A5 case), INVALID_CERTIFICATE or INVALID_CHAIN_LENGTH, decodeAppleStoreNotificationJws throws AppleNotificationSignatureError carrying that status. A unit test covers VERIFICATION_FAILURE explicitly.

**Verification:** Code review

### ac-2: POST /api/kilo-pass/apple/notifications answers an AppleNotificationSignatureError with a 4xx status and a generic error body. captureException is not called, and any log line contains only the verification status name, never the signedPayload or decoded content. Route tests assert all three.

**Verification:** Code review

### ac-3: A retryable VerificationException status, any non-VerificationException error from the verifier, the 'missing required identifiers' schema failure, and processing or database errors still produce a 500 with captureException tagged source app_store_kilo_pass_notification. The 503 in-flight and 400 missing-payload behaviors are unchanged. Existing and new tests cover the retryable-status and generic-error paths.

**Verification:** Code review

### ac-4: After deployment, Sentry records no new KILOCODE-WEB-28A5 (or KILOCODE-WEB-27W8) events for anonymous unverifiable payloads.

**Verification:** Manual: confirm in Sentry (anaconda-nq/kilocode-web) that issues 7802821771 and 7733780211 stop receiving events after the fix is released

## Risks

- A genuine Apple notification refused for a configuration reason (for example INVALID_ENVIRONMENT or INVALID_APP_IDENTIFIER after a misconfiguration) would no longer reach Sentry, only a warning log. Apple still retries non-2xx responses, so nothing is lost silently, but alerting falls back to logs. Mitigation: the warn log names the status so a log-based monitor can catch spikes.
- Duplicating #9049's work in a parallel change could cause merge conflicts. Mitigation: implement once, in whichever change lands first, and make sure it covers VERIFICATION_FAILURE.
- The exact name of the retryable status in library 3.1.0 must be confirmed against the installed typings during implementation.

## Assumptions

- The 28A5 callers are non-Apple probes (curl UA, 0 users). Real Apple deliveries are not affected.
- @apple/app-store-server-library 3.1.0 exports VerificationException with a public status field and a VerificationStatus enum, including a retryable status for online-check network failures.

## Decisions

### d-1: Which VerificationException statuses count as non-retryable client errors?

**Answer:** All statuses except OK and the library's retryable status. This explicitly includes VERIFICATION_FAILURE, so KILOCODE-WEB-28A5 is covered along with the #9045 statuses.

**Blocking:** no

### d-2: How does this work relate to #9045 / PR #9049?

**Answer:** Treat #9105 as a duplicate root cause. One implementation fixes both issues. If #9049 lands first, only add VERIFICATION_FAILURE coverage and a regression test.

**Blocking:** no

### d-3: Which 4xx status code should the endpoint return?

**Answer:** 400 with a generic 'Invalid signedPayload' body, unless #9049 has already chosen a different 4xx. In that case, use #9049's code for consistency.

**Blocking:** no
