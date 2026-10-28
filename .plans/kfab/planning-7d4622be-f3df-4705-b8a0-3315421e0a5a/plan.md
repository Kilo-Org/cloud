<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Classify Google Play "Invalid Value" token rejections on kiloPass.completePlayPurchase as terminal BAD_REQUEST without Sentry capture

## Problem

Sentry KILOCODE-WEB-27WC ("Error: Invalid Value", 12 events 2026-09-16 to 2026-10-28, 0 users impacted reported) is the raw Google Android Publisher (gaxios) HTTP 400 rejection thrown by client.purchases.subscriptionsv2.get in getGooglePlaySubscriptionPurchase (apps/web/src/lib/kilo-pass/google-play-sdk.ts:81). verifyGooglePlayKiloPassPurchase (google-play-verifier.ts:181-188) passes it through unchanged, and mapPlayCompletionError (kilo-pass-router.ts:344-384) captures every non-TRPCError to Sentry and classifies only by message substring. "Invalid Value" matches no branch, so a rejected client purchase token is reported as a server incident and returned as a retryable INTERNAL_SERVER_ERROR (the separate Sentry face KILOCODE-WEB-27WB / #9061). This is the same defect already planned in PR #9067.

## Evidence

- sentry: anaconda-nq KILOCODE-WEB-27WC (issue 7735545083), latest event ca9982cd138941588f3070912142fce5: 'Error: Invalid Value', culprit POST /api/trpc/kiloPass.completePlayPurchase, tags area=kilo-pass, operation=complete-play-purchase, handled=yes; stack kilo-pass-router.ts:1435 -> google-play-verifier.ts:185 -> google-play-sdk.ts:81 -> gaxios _request.
- file: apps/web/src/routers/kilo-pass-router.ts mapPlayCompletionError calls captureException before classification; isVerifierFailure requires 'Google Play ' prefix or 'transaction'/'product'; fallback is INTERNAL_SERVER_ERROR.
- file: apps/web/src/lib/kilo-pass/google-play-verifier.ts verifyGooglePlayKiloPassPurchase has no catch around getGooglePlaySubscriptionPurchase.
- pull_request: Kilo-Org/cloud#9067 (Closes #9061) plans the same classification (HTTP 400/404/410 -> terminal BAD_REQUEST, no Sentry incident) for this exact path, sharing a gaxios-status helper with the credits plan #9050.

## Desired outcome

When Google Play definitively rejects a purchase token on the Kilo Pass subscription lookup (HTTP 400 such as "Invalid Value", 404, 410), kiloPass.completePlayPurchase returns the existing terminal BAD_REQUEST "We could not verify this Google Play purchase. Please try again." with no Sentry capture and no ledger/entitlement change. Transient or server-side failures (5xx, 429, 401/403, network, DB) remain retryable INTERNAL_SERVER_ERRORs and are still reported. KILOCODE-WEB-27WC stops receiving new events.

## Scope

- Classify gaxios errors from getGooglePlaySubscriptionPurchase by HTTP status in the Kilo Pass verifier path (or via the shared helper planned in #9050/#9067).
- Update mapPlayCompletionError so classified token rejections return terminal BAD_REQUEST before captureException runs.
- Unit tests in kilo-pass-router.test.ts (and verifier tests if present) for 400 'Invalid Value', 404, 410 vs 5xx/429/403/network.

## Exclusions

- Credits-path changes (owned by #9047 / PR #9050), except reusing a shared helper if it already exists.
- Mobile client retry behavior changes.
- Google Play service-account or package configuration changes.
- Breadcrumb/token-redaction work beyond what the shared helper already covers.

## Approach

- Coordinate with PR #9067: if its implementation lands first, this issue is satisfied by it; verify it cites KILOCODE-WEB-27WC and close #9078 with it. Otherwise implement the same change once, not twice.
- Add (or reuse) a helper that inspects a Google API error's HTTP status (gaxios error.status / error.response.status) and identifies 400/404/410 as an invalid purchase token.
- In verifyGooglePlayKiloPassPurchase, catch errors from getGooglePlaySubscriptionPurchase; rethrow token rejections as a typed verifier error (e.g. message beginning 'Google Play purchase token was rejected' or a dedicated error class) without the raw token in the message; rethrow everything else unchanged.
- In mapPlayCompletionError, check for the typed token-rejection error before captureException and return the existing BAD_REQUEST verification message; leave all other branches and the capture for unclassified errors unchanged.
- Add router tests mocking the verifier/SDK to throw gaxios-shaped errors and asserting TRPC code and that captureException is not called for rejections but is called for 5xx.

## Affected areas

- apps/web/src/lib/kilo-pass/google-play-verifier.ts
- apps/web/src/lib/kilo-pass/google-play-sdk.ts (only if the helper lives here)
- apps/web/src/routers/kilo-pass-router.ts (mapPlayCompletionError)
- apps/web/src/routers/kilo-pass-router.test.ts

## Acceptance criteria

### ac-1: A gaxios-shaped error with HTTP status 400 and message 'Invalid Value' (and likewise 404 and 410) thrown by the Play subscription lookup makes kiloPass.completePlayPurchase reject with TRPC code BAD_REQUEST and message 'We could not verify this Google Play purchase. Please try again.', and captureException is not called; no Kilo Pass entitlement or ledger write occurs.

**Verification:** Code review

### ac-2: Google API errors with status 5xx, 429, 401 or 403, network errors without a status, and non-Google errors still produce INTERNAL_SERVER_ERROR (or their existing mapped code) and are still sent to captureException with tags area=kilo-pass, operation=complete-play-purchase.

**Verification:** Code review

### ac-3: Router unit tests cover the 400 'Invalid Value', 404 and 410 rejection cases and at least one retryable case (5xx), asserting both the TRPC error code and whether captureException was called.

**Verification:** Source review

### ac-4: The purchase token value does not appear in any new error message, log line, or Sentry extra introduced by the change.

**Verification:** Code review

## Risks

- Duplicate implementation with PR #9067/#9050 producing two helpers; mitigated by reusing whichever lands first.
- Treating 400 as terminal could hide a genuine server misconfiguration that also returns 400; low likelihood since the request only carries a hardcoded package name and the client token, and other statuses (401/403) stay reported.
- Mobile client may treat BAD_REQUEST as permanent and stop retrying; this is intended for rejected tokens.

## Assumptions

- Google returns HTTP 400 'Invalid Value' on subscriptionsv2.get when the purchase token is not recognised (per Sentry stack and PR #9067's analysis).
- gaxios errors expose the HTTP status on error.status or error.response.status in gaxios 7.x.

## Decisions

### d-1: Should #9078 get its own implementation or be resolved by the change planned in PR #9067 for #9061?

**Answer:** Resolve with the single PR #9067 implementation (same root cause and path); this plan documents the expected behavior so the implementer can confirm KILOCODE-WEB-27WC is covered and reference it.

**Blocking:** no
