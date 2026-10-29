<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

fix(kilo-pass): acknowledge Google Play notifications with a non-UUID account token instead of failing with 500

## Problem

Production Sentry issue KILOCODE-WEB-2828 (anaconda-nq/7760494034) is unresolved and recurring: `PostgresError: invalid input syntax for type uuid: "xxxx"` (db.error_code 22P02) on POST /api/kilo-pass/play/notifications. It has about 4,400 events since 2026-09-29, and the latest event was 2026-10-29T03:18Z. The Google Play RTDN handler passes the purchase's `obfuscatedExternalAccountId` straight to `claimGooglePlayStoreEventForProcessing`. That function inserts it into the uuid column `kilo_pass_store_events.app_account_token`. Google echoes whatever the client set. When that value is not a UUID, the first write fails, so no step after it runs. The route turns every processor error into a 500, so Pub/Sub redelivers the same event for days. The notification is never recorded or acknowledged.

## Evidence

- Sentry KILOCODE-WEB-2828 latest event 5500900df33140d2a78be68b5cb3e533: stack route.ts:66 POST -> google-play-notifications.ts:875 processGooglePlayKiloPassNotification -> :182 claimGooglePlayStoreEventForProcessing. The failing statement is the kilo_pass_store_events insert ... on conflict (payment_provider,event_id) do update ... returning id. Release ebf5c14b, environment production.
- Sentry: the same route has related permanent-error loops ('Google Play replacement has no current subscription', about 870 and 810 events; 'renewal notification cannot create a subscription without a user'). Retrying permanent errors with 500 is a recurring pattern on this route.
- Triage (Sentry, per day): bursts of about 650-720 events/day from 2026-09-29 to 2026-10-06, nothing from 10-07 to 10-28, and a new burst on 10-29. The error appears across at least 15 releases.
- Triage (Axiom vercel dataset): on 2026-10-29 at 03:00Z there were 20 HTTP 500s on the route, spaced with growing backoff on a single deployment. This pattern means the same event is being redelivered.
- Source google-play-notifications.ts:165-215: the claim insert binds `app_account_token: params.appAccountToken`. Call sites at :652/:667 (voided refund), :882 (subscription notifications) and :1120 (revocation) pass `obfuscatedExternalAccountId ?? null` without validating it.
- Source google-play-verifier.ts:164-168: `obfuscatedExternalAccountId` is read from externalAccountIdentifiers or from outOfAppPurchaseContext.expiredExternalAccountIdentifiers, with no format check.
- Source packages/db/src/schema.ts:2140 and :2187: `app_account_token` is `uuid()` in both kilo_pass_store_events and kilo_pass_store_purchases. Kilo's own account token (kilocode_users.app_store_account_token) is always a generated UUID.
- Source google-play-notifications.ts:263-296 getUserForGooglePlayRenewal: it throws when the subscription owner's token differs from the supplied token. With a null token and no existing subscription it returns null, and the renewal path then throws 'cannot create a subscription without a user'. So setting the token to null alone can move the 500 loop to a later step.
- Source route.ts:36-83: the route returns 400 for non-JSON or invalid bodies, 503 for in-flight duplicates and 500 for any other error.
- Provider history: PR #7306 (open, 'do not merge before 2026-11-09') retires the Kilo Pass store backend and changes the routes to record, mark processed and return 200 for every Kilo Pass notification. Until it merges, the pinned code path stays in production.

## Desired outcome

A Google Play notification whose purchase carries a missing or non-UUID account token never causes a database type error or a 500. The event is recorded once with a null `app_account_token`. Steps that key only on the purchase token (cancellation, expiry, revocation, refund clawback) still run. A purchase or renewal that cannot be attributed to a Kilo account is acknowledged with 200 and an audit record instead of being retried. The case is reported to Sentry once per event with a stable, non-sensitive message that does not include the raw token. Genuine transient failures keep returning 500, so Pub/Sub still retries them.

## Scope

- Add one helper (for example `normalizeGooglePlayAccountToken`) in the kilo-pass Google Play code. It returns the token when it is a valid UUID (use the existing `z.uuid()` pattern) and otherwise returns null, together with a flag saying a non-UUID value was present.
- Apply the helper in processGooglePlayKiloPassNotification wherever `obfuscatedExternalAccountId` reaches the claim insert, owner lookups or purchase mapping. That covers the voided-refund branch, the subscription-notification claim, the revocation owner lookup and `mapGooglePlayKiloPassPurchase` output used by this handler.
- Purchase-type notifications (purchase, renew, recover and similar PURCHASE_TYPES) with a non-UUID token: record the claim with a null token, write a StoreNotificationReceived audit entry noting that the purchase is unattributable because of an invalid account token (no raw value), mark the event processed and return `{ processed: true }`. Do not grant credits or create a subscription.
- Voided refund and revocation branches with a non-UUID token: resolve the owner by purchase token only, without throwing a token mismatch. Then reverse credits and mark the event processed as today.
- Report each such event once to Sentry, as a warning-level message with tag source=google_play_kilo_pass_notification and a reason tag. Include only non-sensitive identifiers (notification type, order id). Do not include the purchase token or the raw account token.
- Add unit tests in apps/web/src/lib/kilo-pass/google-play-notifications.test.ts, plus a route test if one exists, covering the non-UUID token cases.

## Exclusions

- No schema or migration change: `app_account_token` stays uuid in both tables.
- No change to client-side purchase completion fencing (completePlayPurchase / store-verifier for credit packs). Their own token checks keep rejecting mismatches.
- No blanket mapping of every DB error or 22P02 to 200 in the route. Only the known permanent data case is acknowledged.
- No change to Pub/Sub subscription retention, dead-letter or retry settings, and no replay or reconciliation of notifications that may already have been dropped during the earlier burst. These are operational follow-ups.
- No work on the separate 'Google Play replacement has no current subscription' loops (KILOCODE-WEB-282V/281K). They are a different root cause.
- No changes to PR #7306. It must be rebased over this fix if this merges first.

## Approach

- Add a token normalizer next to the Play decoding code. Use z.uuid().safeParse to accept only canonical UUIDs, and return `{ token: string | null, invalid: boolean }`. A missing value maps to `{ token: null, invalid: false }`.
- In processGooglePlayKiloPassNotification, normalize once per branch right after decodeGooglePlaySubscriptionPurchase. Pass the normalized token to claimGooglePlayStoreEventForProcessing and every owner lookup, so the uuid column never receives an invalid value. The claim stays the first write, so idempotency (claim, then already_processed / in_flight) is unchanged.
- In the purchase-type branch, after the claim and the existing expired/refunded/terminal short-circuits: if `invalid` is set, append a StoreNotificationReceived audit log with `skippedStorePurchaseCompletion: true` and `reason: 'invalid_app_account_token'`, mark the event processed in the same transaction, emit one Sentry warning and return 200. Expired or refunded reconciliation keyed on the purchase token still runs first.
- In the voided-refund branch and the revocation branch, an invalid token must not cause getUserForGooglePlayRenewal to throw a mismatch. Use the non-throwing owner resolution (resolveGooglePlayKiloPassOwner, or a purchase-token-only lookup for the row lock) whenever the token was invalid. The credit reversal itself is keyed on purchase token and order id and stays unchanged.
- Leave route.ts response semantics unchanged. The fix makes the processor return normally for this case, so the existing 200 path applies, while real errors still return 500.
- Tests: build the Play API fixture with `obfuscatedExternalAccountId: 'xxxx'` (current and expired-identifier variants) for SUBSCRIPTION_RENEWED, SUBSCRIPTION_PURCHASED, a non-purchase lifecycle type (for example EXPIRED or CANCELED) and a voided refund. Assert no throw, a stored event with null app_account_token and processed_at set, no credit grant for purchase types, lifecycle and reversal effects still applied, and a second delivery returning already_processed. Keep the existing valid-UUID tests unchanged.

## Affected areas

- apps/web/src/lib/kilo-pass/google-play-notifications.ts
- apps/web/src/lib/kilo-pass/google-play-verifier.ts (only if the normalizer is placed here; decoded raw value otherwise unchanged)
- apps/web/src/lib/kilo-pass/google-play-notifications.test.ts
- apps/web/src/app/api/kilo-pass/play/notifications/route.ts (behaviour verified, no planned change)

## Acceptance criteria

### ac-1: A Google Play subscription notification whose purchase has obfuscatedExternalAccountId 'xxxx' (in either externalAccountIdentifiers or expiredExternalAccountIdentifiers) never binds that value to a uuid column. processGooglePlayKiloPassNotification resolves without throwing, and the kilo_pass_store_events row exists with app_account_token NULL and processed_at set.

**Verification:** Code review

### ac-2: For a purchase-type notification (for example SUBSCRIPTION_RENEWED or SUBSCRIPTION_PURCHASED) with a non-UUID token, no credits are granted, no subscription is created or reassigned, an audit entry records the skipped completion with reason invalid_app_account_token, and the result is { processed: true }, so the route answers 200.

**Verification:** Code review

### ac-3: For a non-purchase lifecycle notification (for example expiry or revocation) and for a voided refund with a non-UUID token, the purchase-token-keyed effects still apply: the subscription is ended, credits are reversed and the audit log is written. No token-mismatch error is thrown because of the invalid token.

**Verification:** Code review

### ac-4: Redelivery of the same notification after it has been handled returns already_processed with no further side effects. Notifications with a valid UUID token behave exactly as before, and the existing tests for them stay unchanged.

**Verification:** Code review

### ac-5: Each invalid-token event produces one warning-level Sentry report with the existing source tag and a reason tag. Neither the report nor the audit payload contains the raw account token or the purchase token. Transient failures (for example a failing Play API or DB call) still propagate and return 500.

**Verification:** Source review

### ac-6: After deployment, Sentry issue KILOCODE-WEB-2828 receives no new events, and the Axiom vercel dataset shows no repeated backoff-spaced 500s on /api/kilo-pass/play/notifications caused by this error.

**Verification:** Manual: after deploy, confirm in Sentry (anaconda-nq/kilocode-web) that KILOCODE-WEB-2828 stops recurring and in Axiom that the route's 500 burst ends

## Risks

- Acknowledging an unattributable renewal means Kilo never grants it. Kilo never issues non-UUID tokens, so no Kilo account can own such a purchase. The audit entry and Sentry warning keep the case visible for manual follow-up if a real customer turns out to be affected.
- Notifications for this lineage that were dropped during the 2026-09-29 to 10-06 burst are not recovered by this change. Whether Pub/Sub dropped them depends on subscription retention (unverified).
- PR #7306 rewrites the same handler. Whoever merges second must keep the rule that the claim insert receives only validated UUID tokens.
- If a different branch also throws a permanent error when the token is null (for example an owner-token mismatch), the loop could move rather than end. The tests per notification type in AC1-AC3 guard against this.

## Assumptions

- The quoted value 'xxxx' is the real bound parameter (the sanitiser does not insert placeholders), and it comes from the client-set Play obfuscatedAccountId.
- Kilo-issued account tokens are always UUIDs (kilocode_users.app_store_account_token defaults to gen_random_uuid()), so a non-UUID token can never match a Kilo user.
- Test commands are not catalogued as approved baseline checks in the pinned context, so per-criterion verification is by code and source review of the added tests plus a post-deploy manual check.

## Decisions

### d-1: Fix in the current pinned handler instead of waiting for PR #7306.

**Answer:** Fix now. #7306 cannot merge before 2026-11-09 and the loop is active today on a payment path.

**Blocking:** no

### d-2: How should a non-UUID account token be handled: reject with 4xx, set to null and continue, or skip the event?

**Answer:** Store it as null and continue with steps keyed on the purchase token. Acknowledge purchase and renewal attribution as unattributable (record, audit, 200). A 4xx would also stop retries but would not record the event, and blanket null-and-continue would move the loop to the owner/renewal throws.

**Blocking:** no

### d-3: Change the uuid column type to text?

**Answer:** No. The uuid contract is correct, so validate at the boundary instead.

**Blocking:** no
