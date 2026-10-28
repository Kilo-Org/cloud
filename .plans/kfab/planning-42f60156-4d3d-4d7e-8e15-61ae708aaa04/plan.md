<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Treat Google Play invalid-token 400s as terminal refusals on Play purchase completion, and redact purchase tokens from server Sentry breadcrumbs

## Problem

Sentry issue KILOCODE-WEB-288A ("Error: Invalid Value", 8 events from 2026-10-17 to 2026-10-28) is raised on credits.completePlayPurchase. Google's Android Publisher API answers purchases.products.get with HTTP 400 when it does not recognise the purchase token for the package/product pair, and on 2026-10-28 the token was clearly fake. The server treats that answer as unexpected. mapCreditCompletionError sends it to captureException and returns INTERNAL_SERVER_ERROR, which is retryable. The tRPC 5xx is then reported a second time as KILOCODE-WEB-2889. Because the mobile client only remembers the BAD_REQUEST verification message as a permanent refusal, it keeps resending the token (6 events in 10 seconds on 2026-10-17). The same pattern hits kiloPass.completePlayPurchase through getGooglePlaySubscriptionPurchase (KILOCODE-WEB-27WC). Separately, the server Sentry setup has no beforeBreadcrumb hook, so HTTP breadcrumbs keep the androidpublisher URL with the purchase token as a path segment. The repository treats that token as a bearer credential that must never reach telemetry.

## Evidence

- Sentry KILOCODE-WEB-288A, latest event 653272533a2b4ff1b287ad36537c632d: the stack runs google-play-sdk.ts:93 getGooglePlayProductPurchase -> store-verifier.ts:178 verifyGooglePlayCreditPurchase -> credits-router.ts:197. It is then re-captured at credits-router.ts:125 (captureException inside mapCreditCompletionError). Tags: area=credits, operation=complete-play-purchase, production.
- Triage context (sentry): breadcrumbs show GET androidpublisher .../purchases/products/credits_usd10/tokens/<token> -> 400. On 2026-10-28 the token is a literal fake value. 6 of the 8 events fall within 10 seconds on 2026-10-17 from an Android client. KILOCODE-WEB-2889 (TRPCError 'We could not finish this purchase') has the same 8 events. KILOCODE-WEB-27WC shows the same 400 on subscriptionsv2.get for kiloPass.completePlayPurchase.
- apps/web/src/routers/credits-router.ts:89-147: errors are classified by type. Only StorePurchasePendingError and the refunded message skip captureException. Anything other than StoreVerificationError or the ownership error becomes INTERNAL_SERVER_ERROR.
- apps/web/src/lib/credits/store-verifier.ts:174-178 calls getGooglePlayProductPurchase directly, with no handling of a provider HTTP error. A comment there already says 'the API answers 400 when the token belongs to a different product'.
- apps/web/src/lib/kilo-pass/google-play-sdk.ts: getGooglePlayProductPurchase and getGooglePlaySubscriptionPurchase return response.data without inspecting errors. consumeGooglePlayProductPurchase, acknowledgeGooglePlaySubscriptionPurchase and revokeGooglePlaySubscriptionPurchase reuse these getters as fallbacks.
- apps/web/src/routers/kilo-pass-router.ts:345-394 mapPlayCompletionError: it calls captureException on every non-TRPC error, then uses message heuristics. 'Google Play ...' messages map to BAD_REQUEST 'We could not verify this Google Play purchase. Please try again.'; everything else maps to INTERNAL_SERVER_ERROR.
- packages/web-shared/src/lib/observability/sentry-server.ts initServerSentry: beforeSend drops tRPC 4xx errors (which is why a BAD_REQUEST mapping removes the duplicate 2889 report). There is no beforeBreadcrumb hook, and httpIntegration is enabled. Searching the repository finds beforeBreadcrumb only in apps/mobile.
- apps/mobile/src/lib/credits/use-store-credit-purchase.ts:208-211: TERMINAL_PURCHASE_MESSAGES contains exactly 'We could not verify this store purchase. Please try again.' and the refunded message.
- Repository searches for 'GaxiosError', 'Invalid Value' and 'isGooglePlayApiError' return no matches (from triage). No existing code classifies Play API HTTP statuses.

## Desired outcome

When Google Play definitively rejects a purchase token (an HTTP 4xx verdict on the token lookup during completion), both credits.completePlayPurchase and kiloPass.completePlayPurchase answer immediately with their existing terminal BAD_REQUEST verification message. They do not create a Sentry incident, and the mobile client stops resending that receipt. Failures that are genuinely transient or ours (Google 5xx, 429, 401/403 auth or permission problems, network errors, database errors, failed consumes) stay retryable and reported, exactly as today. Purchase tokens no longer reach server-side Sentry HTTP breadcrumbs.

## Scope

- Add a small helper next to google-play-sdk.ts that reads the HTTP status from a Google API (gaxios) error, e.g. isGooglePlayInvalidPurchaseTokenError(error). It returns true only for status 400, 404 or 410.
- In verifyGooglePlayCreditPurchase (store-verifier.ts), catch such an error from getGooglePlayProductPurchase and throw StoreVerificationError('Google Play rejected the purchase token'). Every other error is rethrown unchanged.
- In verifyGooglePlayKiloPassPurchase (google-play-verifier.ts), catch the same error class from getGooglePlaySubscriptionPurchase and throw a typed terminal error whose message starts with 'Google Play '. Reuse StoreVerificationError, or add a Kilo-Pass equivalent if import layering prefers it.
- credits-router.ts mapCreditCompletionError: return the existing BAD_REQUEST 'We could not verify this store purchase. Please try again.' for a token rejection without calling captureException. Other StoreVerificationError cases keep their current reporting.
- kilo-pass-router.ts mapPlayCompletionError: add an early typed branch for the token-rejection error. It returns the existing BAD_REQUEST 'We could not verify this Google Play purchase. Please try again.' and skips captureException.
- packages/web-shared/src/lib/observability/sentry-server.ts: add a beforeBreadcrumb hook that redacts the token path segment of androidpublisher.googleapis.com URLs (…/tokens/<token>…) in breadcrumb data.url and message. The breadcrumb stays; only the token is removed.
- Unit tests: router tests with a mocked gaxios-shaped 400 error for both procedures; verifier tests for the 400/404/410 vs 5xx/403/429 split; a sentry-server test for the breadcrumb redaction.

## Exclusions

- No allowlist or product pre-validation of productId before calling Google. A request for an unknown product would also become a 400 verdict; this can be a follow-up if wanted.
- No change to the mobile client's terminal-message list or retry loop. The fix reuses messages the client already treats as terminal (credits path). Kilo Pass mobile handling is left as is.
- consumeGooglePlayProductPurchase, the acknowledge and revoke fallbacks, and the Play RTDN notification handlers keep their current error behaviour. Only the completion-time token lookup is reclassified.
- No support or remediation for the 2026-10-17 Android user. Whether that token was a real purchase is an open operational question (triage mi-provenance) and does not change this fix.
- No change to the edge Sentry config. The Play calls run only in the Node runtime.

## Approach

- 1. google-play-sdk.ts: export a function that reads the HTTP status from a Google API error without depending on gaxios internals beyond the documented shape (error.status or error.response?.status, numeric). It treats 400, 404 and 410 as Google's definitive 'this token is not a valid purchase for this package/product' verdict. 401, 403, 429, 5xx and status-less (network) errors are explicitly excluded, because they can mean our credentials, quota or Google's availability are at fault.
- 2. store-verifier.ts: wrap only the getGooglePlayProductPurchase call in verifyGooglePlayCreditPurchase. On a token-rejection error, throw a StoreVerificationError subclass or tagged instance (e.g. GooglePlayPurchaseTokenRejectedError extends StoreVerificationError in store-purchase-errors.ts), so the router can recognise it by type and not by message, following the file's 'type, not text' rule. Do not keep the original error as cause: it holds the request URL containing the token.
- 3. google-play-verifier.ts: wrap the getGooglePlaySubscriptionPurchase call in verifyGooglePlayKiloPassPurchase the same way, throwing the same typed error with a message starting 'Google Play ' so the existing heuristic would also put it in BAD_REQUEST.
- 4. credits-router.ts: in mapCreditCompletionError, before captureException, return TRPCError BAD_REQUEST with the existing verification message when the error is a GooglePlayPurchaseTokenRejectedError. Update the doc comment to list the provider token rejection among terminal outcomes that are expected, not incidents.
- 5. kilo-pass-router.ts: in mapPlayCompletionError, add the same typed early return (BAD_REQUEST, existing Google Play verification message, no captureException) right after the TRPCError branch.
- 6. sentry-server.ts: add beforeBreadcrumb(breadcrumb) that, for http/fetch breadcrumbs whose data.url (or message) contains androidpublisher.googleapis.com, replaces the segment after '/tokens/' with '[redacted]'. Keep it a pure exported function so it can be unit-tested like sanitizeSentryRequestData. It must never return null, so breadcrumbs are not silently dropped.
- 7. Tests: extend apps/web/src/routers/credits-router.test.ts and kilo-pass-router.test.ts, add or extend store-verifier and google-play-verifier tests with a fake error object shaped like a gaxios 400 ({ status: 400, response: { status: 400 }, message: 'Invalid Value' }), and extend packages/web-shared sentry-server.test.ts for the breadcrumb scrubber. Follow the repository-verification skill for narrow jest runs.

## Affected areas

- apps/web/src/lib/kilo-pass/google-play-sdk.ts
- apps/web/src/lib/credits/store-purchase-errors.ts
- apps/web/src/lib/credits/store-verifier.ts
- apps/web/src/lib/kilo-pass/google-play-verifier.ts
- apps/web/src/routers/credits-router.ts (+ credits-router.test.ts)
- apps/web/src/routers/kilo-pass-router.ts (+ kilo-pass-router.test.ts)
- packages/web-shared/src/lib/observability/sentry-server.ts (+ sentry-server.test.ts)

## Acceptance criteria

### ac-1: When verifyGooglePlayCreditPurchase's token lookup fails with a Google API error of status 400, 404 or 410, credits.completePlayPurchase rejects with code BAD_REQUEST and message exactly 'We could not verify this store purchase. Please try again.', which the mobile client already treats as terminal. It does not call captureException, completeStoreCreditPurchase or acknowledgeGooglePlayCreditPurchase. A router test with a mocked gaxios-shaped 400 asserts all of this.

**Verification:** Code review

### ac-2: When verifyGooglePlayKiloPassPurchase's subscriptionsv2 lookup fails with a Google API error of status 400, 404 or 410, kiloPass.completePlayPurchase rejects with BAD_REQUEST and its existing message 'We could not verify this Google Play purchase. Please try again.'. It does not call captureException and does not grant or acknowledge anything. A kilo-pass-router test asserts this.

**Verification:** Code review

### ac-3: Errors that are not a token verdict keep today's behaviour on both procedures: a Google API error with status 401, 403, 429 or 5xx, a status-less network error, a database error, and a failed consume are still reported with captureException and still answered with INTERNAL_SERVER_ERROR (retryable). Pending purchases still answer CONFLICT without a report. Tests cover at least the 403 and 503 cases for the credits path, plus one non-verdict case for the Kilo Pass path.

**Verification:** Code review

### ac-4: The typed token-rejection error does not keep the original Google API error, its request config or the URL as message or cause. Its message contains no part of the purchase token. A test asserts that the thrown error's message and cause chain do not contain the token string.

**Verification:** Code review

### ac-5: Server Sentry (initServerSentry) has a beforeBreadcrumb hook. For a breadcrumb whose data.url or message contains an androidpublisher.googleapis.com …/tokens/<token> path, it replaces the token segment with a redaction marker and leaves other URL parts and the status code intact. It returns every breadcrumb, never null, and leaves unrelated breadcrumbs unchanged. Unit tests in packages/web-shared cover the products and subscriptionsv2 URL forms plus an unrelated URL.

**Verification:** Code review

### ac-6: The change's verification notes state both effects that the AGENTS.md Failure UX section requires. First, the spurious retryable 500 and replay loop, and the duplicate 288A/2889 reports, stop for receipts Google rejects. Second, a genuinely invalid receipt now fails fast with a specific terminal refusal, and no transient or credential failure is newly made terminal. After deploy, Sentry shows no new KILOCODE-WEB-288A, KILOCODE-WEB-2889 or KILOCODE-WEB-27WC events caused by a Play 400.

**Verification:** Manual: after deployment, confirm in Sentry (anaconda-nq/kilocode-web) that no new 288A/2889/27WC events from a Play 400 appear, and that the PR description states both Failure UX effects

## Risks

- Misclassifying a transient or our-side Google failure as terminal would make the mobile client stop recovering a paid purchase for the rest of the process. Mitigation: only 400, 404 and 410 count as terminal. 403 (which also covers a service-account permission or linkage problem) and 401 stay retryable and reported. Mobile memory is in-memory only, so the next app launch retries once.
- If a real paid purchase is ever answered 400 (e.g. an app-variant or package mismatch), it is no longer a Sentry incident. Mitigation (optional): emit a low-severity log or metric on the terminal path with the productId and status only, never the token, so volume stays observable.
- gaxios error shape can change across versions (status vs response.status). Mitigation: check both properties, and cover both in tests.
- beforeBreadcrumb lives in shared web-shared code that ai-gateway also uses. The redaction is scoped to androidpublisher URLs, so other breadcrumbs are untouched.

## Assumptions

- The Android Publisher API's 400 'Invalid Value' (and 404/410) on purchases.products.get or subscriptionsv2.get means the token is not a valid purchase for this package/product. Retrying the same token will not change that answer.
- The second Sentry group, KILOCODE-WEB-2889, comes from the tRPC-level report of the INTERNAL_SERVER_ERROR. It disappears once the error maps to BAD_REQUEST, because initServerSentry.beforeSend already drops tRPC 4xx errors.
- The Kilo Pass mobile flow tolerates BAD_REQUEST with its existing verification message, because that is already the response for other 'Google Play …' verifier failures.

## Decisions

### d-1: Which Google API HTTP statuses count as a terminal token verdict?

**Answer:** 400, 404 and 410 only. 401, 403, 429, 5xx and network errors stay retryable and reported, because they can mean a credential, quota or availability problem on our side or Google's.

**Blocking:** no

### d-2: Should a terminal token rejection still be reported to Sentry?

**Answer:** No. It is an expected outcome of a bad client input, like the pending and refunded cases. It is not captured, which also removes the duplicate tRPC report. An optional token-free log or metric may be added for volume visibility.

**Blocking:** no

### d-3: How do the routers recognise the new outcome?

**Answer:** By a dedicated error type thrown in the verifiers (subclass of StoreVerificationError), following store-purchase-errors.ts's rule of classifying by type, not message text.

**Blocking:** no
