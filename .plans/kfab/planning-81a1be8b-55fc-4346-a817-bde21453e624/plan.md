<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Return a terminal 400 for App Store receipts Apple's verifier rejects on credits.completeAppStorePurchase

## Problem

`credits.completeAppStorePurchase` answers 500 INTERNAL_SERVER_ERROR (which the client treats as retryable) when Apple's `SignedDataVerifier` rejects the submitted `signedTransactionJws`. It should answer with the terminal receipt refusal. In Sentry KILOCODE-WEB-288T, the latest event shows a `VerificationException` (VERIFICATION_FAILURE) from `@apple/app-store-server-library` 3.1.0. That exception wraps a TypeError raised because the library's payload validator received a null decoded payload, which means the string was not a decodable JWS. Neither `decodeAppleStoreTransactionJws` nor `verifyAppleCreditPurchase` converts this library error into `StoreVerificationError`. `mapCreditCompletionError` decides terminal versus retryable by error type, so the error falls through to INTERNAL_SERVER_ERROR. As a result, a receipt that can never verify is reported as retryable, and it lands in Sentry as an untyped "Error".

## Evidence

- Sentry anaconda-nq KILOCODE-WEB-288T (issue 7799753207): 3 events, 0 users impacted, first seen 2026-10-19, last seen 2026-10-29T05:43:02Z, culprit POST /api/trpc/credits.completeAppStorePurchase. The latest event (a66c7d9b…) passes through credits-router.ts:177 → store-verifier.ts:163 → apple-store-verifier.ts:86 → jws_verification.ts:244, where it throws `VerificationException(VerificationStatus.VERIFICATION_FAILURE, error)`. The chained cause is `TypeError: Cannot read properties of null (reading 'originalTransactionId')` from JWSTransactionDecodedPayload.ts:266. The user agent is curl 7.88.1, and the tags include operation=complete-app-store-purchase.
- apps/web/src/lib/kilo-pass/apple-store-verifier.ts:83-90 calls `createAppleStoreSignedDataVerifier().verifyAndDecodeTransaction(...)` with no error translation. It is shared by the credits route, the Kilo Pass route (`verifyAppleKiloPassTransactionJws`), and App Store notification processing (`apple-store-notifications.ts:1111`).
- apps/web/src/lib/credits/store-verifier.ts:160-164: `verifyAppleCreditPurchase` turns only mapping refusals into `StoreVerificationError` (lines 118-141). Errors thrown by the verifier itself pass through untyped.
- apps/web/src/routers/credits-router.ts:89-148: `mapCreditCompletionError` maps `StoreVerificationError` to BAD_REQUEST ('We could not verify this store purchase. Please try again.') and every other unclassified error to INTERNAL_SERVER_ERROR. Before classifying, it calls `captureException(sanitizeErrorForTelemetry(error, [signedTransactionJws]))`.
- apps/web/src/lib/credits/store-purchase-errors.ts documents the contract: only a store refusal may be terminal, and provider/database failures stay retryable. The decision is made by type, never by message.
- apps/web/src/routers/credits-router.test.ts:205-276 already asserts that StoreVerificationError → BAD_REQUEST and that a plain provider Error → INTERNAL_SERVER_ERROR. No test covers a verifier-level rejection.
- apps/web/package.json pins `@apple/app-store-server-library` 3.1.0. A repository-wide search finds no reference to `VerificationException` or `VerificationStatus` in apps/web.
- Triage (Axiom vercel log drain, 2026-10-15..29): 12 curl and 8 desktop-Chrome 500s on this path. The 05:43:02Z credits 500 matches the Sentry event and came from a scripted sequence of valid and invalid receipts, not from an organic purchase.

## Desired outcome

When Apple's verifier definitively rejects a submitted App Store transaction JWS (malformed or undecodable, bad signature or chain, wrong app identifier or environment), `credits.completeAppStorePurchase` answers the existing terminal BAD_REQUEST receipt refusal through `StoreVerificationError`. Apple's explicitly retryable verifier status (RETRYABLE_VERIFICATION_FAILURE, e.g. an OCSP/network problem), missing configuration, and all other provider or database errors remain retryable INTERNAL_SERVER_ERROR. The JWS never appears in an error message or telemetry.

## Scope

- Translate `VerificationException` from `@apple/app-store-server-library` inside `verifyAppleCreditPurchase` (apps/web/src/lib/credits/store-verifier.ts). Non-retryable statuses become `StoreVerificationError` with a fixed message. RETRYABLE_VERIFICATION_FAILURE and non-`VerificationException` errors are rethrown unchanged.
- Add unit tests in apps/web/src/lib/credits/store-verifier.test.ts for the verifier-level rejection cases (terminal) and the retryable-status case.
- Optionally add a router-level test in credits-router.test.ts: a verifier rejection surfaced as StoreVerificationError returns BAD_REQUEST, and the JWS is absent from the captured report. The existing generic-error retryable tests must stay unchanged.

## Exclusions

- Kilo Pass `kiloPass.completeAppStorePurchase` (Sentry KILOCODE-WEB-28F2) and its message-matching `mapAppStoreCompletionError`. That mapper uses a different, message-based classification, and changing it is a separate decision.
- App Store Server Notification processing and the shared `decodeAppleStoreTransactionJws`. No translation goes into the shared function, because notification retry semantics are different.
- Google Play credit path 'Invalid Value' failures (KILOCODE-WEB-288A, #9122).
- Adding a JWS-shape regex to the tRPC zod input schema. A zod input error would return a different BAD_REQUEST message than the one mobile clients match, and Apple's VERIFICATION_FAILURE already covers malformed input.
- Changing Sentry capture policy for typed refusals. They remain captured, sanitized, as StoreVerificationError, as other Apple refusals are today.
- Reclassifying the plain Error 'Apple transaction payload missing required identifiers' from apple-store-verifier.ts. The pattern is to classify by type, not by message.

## Approach

- Before coding, confirm in the installed `@apple/app-store-server-library` 3.1.0 (node_modules or its published source) that `VerificationException` (fields `status` and `cause`) and the `VerificationStatus` enum are exported from the package root. Also confirm the enum member names (OK, VERIFICATION_FAILURE, RETRYABLE_VERIFICATION_FAILURE, INVALID_APP_IDENTIFIER, INVALID_ENVIRONMENT, INVALID_CHAIN_LENGTH, INVALID_CERTIFICATE, FAILURE). If the class is not exported, fall back to a structural check: an Error whose numeric `status` is a known `VerificationStatus` value.
- In `verifyAppleCreditPurchase`, wrap only the `decodeAppleStoreTransactionJws` call in try/catch. If the error is a `VerificationException` whose status is not RETRYABLE_VERIFICATION_FAILURE, throw `new StoreVerificationError('Apple transaction could not be verified')`. Use a fixed message that does not include the library's cause or the JWS. If it helps the Sentry title, a bounded status name may be included, but never input-derived text. Rethrow everything else unchanged. Keep `mapAppleCreditTransaction` outside the try/catch so its existing typed refusals are unaffected.
- Leave `mapCreditCompletionError` unchanged. StoreVerificationError already maps to BAD_REQUEST after the sanitized capture.
- Tests (store-verifier.test.ts already mocks `decodeAppleStoreTransactionJws`): (a) a rejection with `new VerificationException(VerificationStatus.VERIFICATION_FAILURE, new TypeError(...))` produces a rejection that is an instance of StoreVerificationError and whose message does not contain the input JWS; (b) INVALID_APP_IDENTIFIER and INVALID_ENVIRONMENT are terminal in the same way; (c) RETRYABLE_VERIFICATION_FAILURE rejects with the original exception, not a StoreVerificationError; (d) a plain `Error('provider unavailable')` passes through untyped.

## Affected areas

- apps/web/src/lib/credits/store-verifier.ts
- apps/web/src/lib/credits/store-verifier.test.ts
- apps/web/src/routers/credits-router.test.ts (optional regression test only)

## Acceptance criteria

### ac-1: When `decodeAppleStoreTransactionJws` rejects with Apple's `VerificationException` carrying a non-retryable status (at least VERIFICATION_FAILURE, which is the KILOCODE-WEB-288T case of an undecodable JWS/null payload, plus INVALID_APP_IDENTIFIER and INVALID_ENVIRONMENT), `verifyAppleCreditPurchase` rejects with a `StoreVerificationError`. As a result, `credits.completeAppStorePurchase` answers BAD_REQUEST with the existing terminal message. Unit tests in store-verifier.test.ts cover each of these statuses.

**Verification:** Code review

### ac-2: Retryability is preserved for genuine transient failures. A `VerificationException` with RETRYABLE_VERIFICATION_FAILURE, a missing-configuration error (e.g. 'APPLE_ROOT_CERTIFICATES_PEM is not set'), and a plain provider Error all still reach the router untyped and produce INTERNAL_SERVER_ERROR. The existing credits-router tests 'keeps a provider failure that names a product retryable' and 'maps a store or API failure to a retryable internal error' remain unchanged, and a new store-verifier test asserts the retryable-status passthrough. Verification states both effects: a receipt that can never verify now fails fast as terminal, and the wait and retry behavior for real outages is unchanged.

**Verification:** Code review

### ac-3: The translated `StoreVerificationError` message is fixed text. It never contains the submitted `signedTransactionJws` or the library's cause text, and a test asserts the input JWS is absent from the thrown error's message. The translation does not affect existing mapping refusals from `mapAppleCreditTransaction`, and it does not change the shared `decodeAppleStoreTransactionJws`, the Kilo Pass route, or notification processing.

**Verification:** Code review

## Risks

- Misclassifying a verifier status as terminal could make the mobile client permanently give up on a paid purchase. Mitigation: only RETRYABLE_VERIFICATION_FAILURE is treated as transient (Apple's own designation), and configuration errors thrown before verification (`requiredEnv`) are not VerificationExceptions, so they stay retryable.
- If production were misconfigured (wrong APPLE_IAP_ENVIRONMENT, root certificates, or APPLE_APP_APPLE_ID), genuine receipts would now get a terminal 400 instead of a retryable 500. Triage found no evidence of this (0 users impacted; the route returns 200 for valid receipts). These refusals are still captured to Sentry, so a spike remains visible.
- The export surface of library 3.1.0 is assumed (VerificationException/VerificationStatus at the package root). The approach includes a confirmation step and a structural fallback.

## Assumptions

- The root cause is caller input that is not a decodable JWS (scripted curl client), not an Apple configuration fault. This is consistent with a null decoded payload, 0 users impacted, and successful 200s on the same route.
- Mobile clients already handle the existing BAD_REQUEST 'We could not verify this store purchase' refusal as terminal, so no client change is needed.

## Decisions

### d-1: Where should Apple verifier failures be translated into the terminal type?

**Answer:** In `verifyAppleCreditPurchase` (credits-only), not in the shared `decodeAppleStoreTransactionJws`. StoreVerificationError is a credits-flow type, and the Kilo Pass and notification paths have different classification and retry semantics.

**Blocking:** no

### d-2: Should typed verifier refusals stop being reported to Sentry?

**Answer:** No. Keep the existing policy: StoreVerificationError is captured (sanitized) before mapping to BAD_REQUEST, as other Apple refusals are today. The fix corrects the retry semantics and gives the reports a meaningful type. Changing capture policy is out of scope.

**Blocking:** no

### d-3: Should a JWS-shape guard be added to the tRPC input schema?

**Answer:** No. Apple's VERIFICATION_FAILURE already covers malformed input, and a zod failure would return a different error message than the one clients match.

**Blocking:** no
