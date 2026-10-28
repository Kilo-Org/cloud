<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Return a terminal BAD_REQUEST for Google Play token rejections on kiloPass.completePlayPurchase instead of a reported 500

## Problem

Sentry KILOCODE-WEB-27WB (18 events, 2026-09-16 to 2026-10-28, 0 users impacted reported) is the generic INTERNAL_SERVER_ERROR fallback "We could not finish this Google Play purchase. Please try again." in mapPlayCompletionError (apps/web/src/routers/kilo-pass-router.ts). verifyGooglePlayKiloPassPurchase passes raw Google Android Publisher (gaxios) errors from getGooglePlaySubscriptionPurchase through unchanged. These include HTTP 400 "Invalid Value" and 404 "The subscription was not found.", which Google returns when it does not recognise a purchase token. mapPlayCompletionError only classifies errors by message substring, so these errors fall through to a retryable 500. Each one is also reported twice: once by its own captureException call (sibling issue KILOCODE-WEB-27WC) and once by the tRPC middleware. A smaller class of DB connect timeouts also reaches this fallback, and that behavior is correct.

## Evidence

- Sentry anaconda-nq/7735545077 (KILOCODE-WEB-27WB), latest event 30014f6935cc4022bcd9e54f51b65c23 at 2026-10-28T15:02:32Z, culprit POST /api/trpc/kiloPass.completePlayPurchase. The most relevant frame is in mapPlayCompletionError at kilo-pass-router.ts:374, and the message is the INTERNAL_SERVER_ERROR fallback (handled: no, mechanism auto.rpc.trpc.middleware).
- Sentry KILOCODE-WEB-27WC (7735545083) shares this issue's trace id. It is 'Error: Invalid Value' thrown from getGooglePlaySubscriptionPurchase (google-play-sdk.ts) and is the underlying error recorded by mapPlayCompletionError's captureException (per triage).
- Triage grouped the 90-day Sentry events for operation:complete-play-purchase. The unmapped classes are 'Invalid Value' (10), 'timeout exceeded when trying to connect' (5) and 'The subscription was not found.' (1).
- Pinned kilo-pass-router.ts lines 344-392: mapPlayCompletionError calls captureException before classifying, and the verifier and domain branches match only on message substrings.
- Pinned google-play-verifier.ts verifyGooglePlayKiloPassPurchase calls getGooglePlaySubscriptionPurchase with no try/catch, so it does not translate Google API errors.
- Draft planning PR #9050 (from #9047) plans the same fix: an isGooglePlayInvalidPurchaseTokenError helper (status 400/404/410), a terminal error in verifyGooglePlayKiloPassPurchase, and an early BAD_REQUEST branch in mapPlayCompletionError that skips captureException. That helper does not exist at the pinned commit.

## Desired outcome

When Google Play definitively rejects the purchase token (HTTP 400, 404 or 410 on the subscription lookup), kiloPass.completePlayPurchase immediately returns the existing terminal BAD_REQUEST "We could not verify this Google Play purchase. Please try again." It creates no Sentry incident and writes nothing to the ledger. Transient or internal failures (Google 5xx, 429, 401/403, network errors, DB errors such as connect timeouts) stay retryable INTERNAL_SERVER_ERRORs and are still reported.

## Scope

- kiloPass.completePlayPurchase error classification for Google Play subscription token rejections.
- A shared helper that classifies a Google API (gaxios) error by HTTP status, shared with the credits path planned in #9050. If #9050 has already added the helper, reuse it instead of creating a second one.
- Router and verifier unit tests for the kiloPass path.

## Exclusions

- credits.completePlayPurchase / mapCreditCompletionError and the Sentry breadcrumb token redaction. Both are covered by #9047 / PR #9050; this plan must not duplicate them.
- Reclassifying the transient 'timeout exceeded when trying to connect' DB class. It intentionally stays a retryable, reported 500.
- Mobile client retry/terminal-refusal changes. No first-party caller of kiloPass.completePlayPurchase exists in the pinned mobile/web trees.
- App Store (mapStoreCompletionError) behavior.

## Approach

- Coordinate with #9050 first. If its implementation has landed, check that it covers every criterion below and only add whatever kiloPass tests are missing. Otherwise implement the kiloPass portion here using the same helper name and semantics so the two changes merge cleanly.
- Add isGooglePlayInvalidPurchaseTokenError(error) next to google-play-sdk.ts. It reads the numeric HTTP status from a gaxios-shaped error (error.status or error.response.status, or error.code when it is numeric) and returns true only for 400, 404 and 410.
- In verifyGooglePlayKiloPassPurchase, wrap only the getGooglePlaySubscriptionPurchase call. When the helper returns true, throw a typed terminal error such as GooglePlayPurchaseTokenRejectedError, whose message starts with 'Google Play ' and contains no token. Rethrow every other error unchanged.
- In mapPlayCompletionError, add an instanceof branch for the typed error after the TRPCError check and before captureException. It returns BAD_REQUEST with the existing verifier copy. Keep the fallback and its captureException for all other errors.
- Tests: (a) in kilo-pass-router.test.ts, the verifier mock rejects with the typed error, so the mutation rejects with the verifier copy, captureException is not called and completeStoreKiloPassPurchase is not called; (b) a generic Error, such as a DB timeout, still produces the INTERNAL_SERVER_ERROR copy with captureException called once; (c) verifier/helper tests show gaxios-shaped 400/404/410 are mapped to the typed error, while 403/429/500 and errors with no status are rethrown unchanged.

## Affected areas

- apps/web/src/lib/kilo-pass/google-play-sdk.ts (or a sibling helper module)
- apps/web/src/lib/kilo-pass/google-play-verifier.ts
- apps/web/src/routers/kilo-pass-router.ts (mapPlayCompletionError)
- apps/web/src/routers/kilo-pass-router.test.ts and verifier tests

## Acceptance criteria

### ac-1: When verifyGooglePlayKiloPassPurchase fails because Google returned HTTP 400, 404 or 410 for the subscription token, kiloPass.completePlayPurchase rejects with BAD_REQUEST 'We could not verify this Google Play purchase. Please try again.', does not call captureException, and does not call completeStoreKiloPassPurchase. A router unit test with a gaxios-shaped rejection covers this.

**Verification:** Code review

### ac-2: Google API errors with status 401, 403, 429 or 5xx, errors with no status, and non-Google errors (such as a DB 'timeout exceeded when trying to connect') are not converted. They still produce INTERNAL_SERVER_ERROR 'We could not finish this Google Play purchase. Please try again.' with exactly one captureException call. Router and verifier unit tests cover both sides of this split.

**Verification:** Code review

### ac-3: The typed terminal error message and any logging added by the change contain no purchase token value.

**Verification:** Source review

### ac-4: The change does not duplicate #9050's work: the invalid-token helper exists only once in the tree, and credits-router behavior is left unchanged by this change.

**Verification:** Source review

### ac-5: After deploy, KILOCODE-WEB-27WB and KILOCODE-WEB-27WC receive no new events for Google token rejections. Any remaining 27WB events come only from transient or internal classes.

**Verification:** Manual: Review Sentry issues KILOCODE-WEB-27WB and KILOCODE-WEB-27WC in anaconda-nq/kilocode-web for one to two weeks after release

## Risks

- Classifying a status too broadly could turn a misconfiguration (403 permission denied on the service account) into a silent terminal refusal. This is mitigated by limiting the helper to 400/404/410 and testing 403 explicitly.
- This change and #9050 can collide if both are implemented separately. This is mitigated by reusing one helper name and checking #9050's state first.
- The deployed release (e009d438…) differs from the pinned commit. The relevant code matches the pinned file, but the line numbers may drift.

## Assumptions

- Google's 400 'Invalid Value' and 404 'subscription not found' on subscriptionsv2.get mean the token is permanently unusable for this package, so retrying cannot succeed.
- The BAD_REQUEST verifier copy that already exists is acceptable user-facing text for a token rejection; no new copy is needed.
- No database write happens before verification on this path, so a terminal refusal strands no charge or credit.

## Decisions

### d-1: Should the transient DB connect-timeout class also become terminal?

**Answer:** No. It stays a retryable, reported INTERNAL_SERVER_ERROR, which is consistent with the repository's Failure UX guidance and with the #9050 plan.

**Blocking:** no

### d-2: Re-plan independently or align with #9047/#9050?

**Answer:** Align with it. This plan is the kiloPass-only slice of #9050. If #9050 lands first, the work reduces to confirming these criteria and filling any test gaps.

**Blocking:** no
