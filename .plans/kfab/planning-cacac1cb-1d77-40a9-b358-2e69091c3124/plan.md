<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Return terminal BAD_REQUEST, not retryable 5xx, when Google Play rejects a credits purchase token (duplicate of #9047 / PR #9050)

## Problem

Sentry KILOCODE-WEB-2889 ("TRPCError: We could not finish this purchase. Please try again.", POST /api/trpc/credits.completePlayPurchase, 8 events 2026-10-17 to 2026-10-28, one user, 0 users impacted) is the generic INTERNAL_SERVER_ERROR fallback of mapCreditCompletionError in apps/web/src/routers/credits-router.ts. The error behind it is the Google Android Publisher rejecting the purchase token on purchases.products.get ("Invalid Value", Sentry KILOCODE-WEB-288A, tracked as #9047). getGooglePlayProductPurchase and verifyGooglePlayCreditPurchase pass that error up without classifying it, so the router reports it to Sentry once through captureException (288A), then returns a retryable 5xx. The server Sentry beforeSend only drops tRPC 4xx errors, so the Sentry tRPC middleware reports that 5xx a second time (2889). The client also gets a retryable answer for a receipt the store will never accept.

## Evidence

- sentry: KILOCODE-WEB-2889 (issue 7797125704), latest event 8daaaea9baab4b13861e03fce8a1830a. Stack ends at credits-router.ts:214 (completePlayPurchase catch) -> :95 (mapCreditCompletionError). Mechanism auto.rpc.trpc.middleware, handled:no, release e009d438, trace f76c9908da604f809922804b74d4504a. The request tags show a desktop Chrome/macOS client calling the mobile-only Play completion endpoint, which fits a scripted or fake token rather than the mobile app.
- sentry (triage context): KILOCODE-WEB-288A 'Error: Invalid Value' from google-play-sdk.ts getGooglePlayProductPurchase. Same 8 events, same window, user, release and trace as 2889. It is the only error captured on operation:complete-play-purchase in the last 30 days.
- Pinned code: in credits-router.ts lines 89-150, mapCreditCompletionError only maps StoreVerificationError (BAD_REQUEST), the owned-by-another-account error (FORBIDDEN), pending (CONFLICT) and refunded (BAD_REQUEST). Every other error becomes INTERNAL_SERVER_ERROR 'We could not finish this purchase.' after captureException.
- Pinned code: getGooglePlayProductPurchase in google-play-sdk.ts awaits client.purchases.products.get with no error handling. The pinned tree has no isGooglePlayInvalidPurchaseTokenError or any other HTTP-status classifier.
- Pinned code: beforeSend in packages/web-shared/src/lib/observability/sentry-server.ts drops events whose original exception is a tRPC 4xx code (TRPC_4XX_CODES includes BAD_REQUEST). Once the rejection maps to BAD_REQUEST, the middleware's second report (2889) is suppressed.
- History: draft planning PR #9050 (closes #9047) plans the same fix. It adds a Play-SDK classifier for gaxios 400/404/410 and maps the result to the existing terminal BAD_REQUEST in verifyGooglePlayCreditPurchase/mapCreditCompletionError and in kiloPass mapPlayCompletionError, without captureException. It also adds breadcrumb token redaction. The PR names KILOCODE-WEB-2889 as the second report of this failure.

## Desired outcome

When Google Play definitively rejects a credits purchase token (HTTP 400/404/410 on the products.get lookup), credits.completePlayPurchase answers with the existing terminal BAD_REQUEST "We could not verify this store purchase. Please try again." No Sentry incident is created and no retryable 5xx is returned, so KILOCODE-WEB-2889 stops recurring for this cause. Genuinely transient or internal failures stay retryable and reported as they are today. The work is delivered by the plan already recorded for #9047 (draft PR #9050), not by a separate change.

## Scope

- Associate #9059 with #9047 as a duplicate. The implementation of PR #9050's plan is the change that resolves it, and should reference both Sentry issues (KILOCODE-WEB-288A and KILOCODE-WEB-2889).
- Credits Play path, as already scoped in #9050: classify the Google API status in google-play-sdk.ts, convert a token rejection into a typed terminal verification error in verifyGooglePlayCreditPurchase (apps/web/src/lib/credits/store-verifier.ts), and have mapCreditCompletionError return BAD_REQUEST for it without captureException.

## Exclusions

- No second, separate implementation for #9059. The kiloPass.completePlayPurchase variant (#9061 / KILOCODE-WEB-27WB) and the breadcrumb redaction are covered by #9050's plan, and this item does not re-plan them.
- No change to App Store completion, to retryable classification of Google 5xx/429/401/403/network/database/consume failures, or to the mobile client.
- #9060 (Stripe auto-top-up 'Invalid integer: 0.5') is unrelated.
- Per operator request, no manual post-deployment Sentry verification is part of this plan's acceptance criteria.

## Approach

- Treat #9047 / PR #9050 as the canonical plan. Close #9059 as a duplicate of #9047, or link it so the implementing PR also closes it.
- When implementing #9050, check that the credits path change alone removes 2889: the token rejection becomes a typed StoreVerificationError (or a dedicated subtype) and maps to BAD_REQUEST before captureException, and sentry-server beforeSend then drops the middleware's tRPC 4xx capture.
- Add or extend the credits-router test with a gaxios-shaped 400 error from getGooglePlayProductPurchase. Assert BAD_REQUEST with the verification message and that captureException is not called. Keep a 5xx/403 case asserting INTERNAL_SERVER_ERROR plus capture.

## Affected areas

- apps/web/src/lib/kilo-pass/google-play-sdk.ts
- apps/web/src/lib/credits/store-verifier.ts
- apps/web/src/routers/credits-router.ts and credits-router.test.ts

## Acceptance criteria

### ac-1: If getGooglePlayProductPurchase rejects with a Google API error of HTTP status 400, 404 or 410, credits.completePlayPurchase rejects with TRPCError code BAD_REQUEST and message 'We could not verify this store purchase. Please try again.', and captureException is not called. This is covered by a credits-router unit test that uses a gaxios-shaped error.

**Verification:** Code review

### ac-2: If the same lookup fails with status 500, 429, 401/403, or a non-HTTP network error, credits.completePlayPurchase still returns INTERNAL_SERVER_ERROR 'We could not finish this purchase. Please try again.' and still calls captureException. Existing pending, refunded and owned-by-another-account mappings are unchanged. Unit tests cover at least one non-terminal status.

**Verification:** Code review

## Risks

- If 400 is classified too broadly as terminal, a real paid purchase could be stranded if Google returns 400 for a transient reason. Limiting the classifier to 400/404/410 on the token lookup and keeping every other failure retryable bounds this. The observed events come from a single user calling from a desktop browser.
- If #9059 is implemented separately from #9050, the two changes could conflict in the same functions. Keeping one implementation avoids this.
- With the manual Sentry check removed, nothing in this plan confirms the fix in production. Confirmation rests on the unit tests and on the existing beforeSend filter that drops tRPC 4xx errors.

## Assumptions

- Draft PR #9050 remains the active plan for #9047 and will be implemented. If it is abandoned, this plan's scope (credits path only) is the minimum change that resolves 2889.
- The gaxios error raised by googleapis exposes the HTTP status (e.g. error.status or error.response.status), as #9050 assumes.

## Decisions

### d-1: Should #9059 get its own implementation, or be resolved by #9047's plan (PR #9050)?

**Answer:** #9050 resolves it. #9059 is a duplicate: same root cause, same 8 events, same trace. #9050 explicitly names KILOCODE-WEB-2889.

**Blocking:** no
