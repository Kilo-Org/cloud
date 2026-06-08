# Kilo Pass

## Role of This Document

This spec records Kilo Pass business rules: valid states, provider support, credit amounts, eligibility rules,
lifecycle behavior, and known limits. Most sections describe current behavior. A section marked as approved target
behavior is authoritative before implementation and records the behavior that implementation work MUST satisfy. For
all other disagreements while this draft is being aligned retrospectively, code remains authoritative.

Billing-platform behavior shared with other products (Stripe webhook processing, fraud warnings, the Subscription Center
surface, affiliate/referral attribution) is governed by the adjacent specs listed in the Changelog and is summarized
here only where Kilo Pass adds product-specific behavior.

## Status

Draft -- current-code alignment revision created 2026-06-01. The first-fingerprint-claim cooldown in Duplicate-Card
Rules 51-55 were implemented on 2026-06-05.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT
RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174]
when, and only when, they appear in all capitals, as shown here.

All monetary amounts are expressed in USD unless stated otherwise. All instants are UTC. Unless stated otherwise,
rounding to whole cents uses round-half-up (ties round toward positive infinity).

## Definitions

- **Subscription row**: A persisted Kilo Pass enrollment at a given **tier** and **cadence**, owned by one **payment
  provider**.
- **Tier**: The price point of the subscription. The tiers are `tier_19` ($19/mo), `tier_49` ($49/mo), and `tier_199`
  ($199/mo).
- **Cadence**: The billing rhythm: `monthly` or `yearly`. Stripe yearly subscriptions are billed once per year but
  receive base credits monthly.
- **Payment provider**: `stripe`, `app_store`, or `google_play`. `app_store` and `google_play` are collectively the
  **store providers**. Persisted representation does not imply that an end-user purchase flow is exposed for that
  provider and cadence.
- **Effective subscription**: The subscription row selected from a user's persisted rows before read-time state
  derivation. Rows are ranked by persisted status and recency (see Subscription Selection and Derived State).
- **Derived state**: A read-time state adjustment applied after effective subscription selection. An open pause event
  derives `paused`. An expired latest store purchase derives `canceled` on the web read path.
- **Ended provider status**: `canceled`, `unpaid`, or `incomplete_expired`. Transitional statuses such as `past_due`,
  `trialing`, `incomplete`, and `paused` are not ended provider statuses.
- **Ended marker**: A non-null persisted `ended_at` value. Some lifecycle paths use this marker in addition to provider
  status. Generic effective subscription selection ranks rows by persisted status and does not inspect the ended marker.
- **Pending cancellation**: A subscription set to cancel at its period end but still within its current paid period.
- **Base credits**: The monthly credit allotment equal to the tier's configured monthly price.
- **Bonus credits**: Additional credits computed as a percentage of the tier's configured monthly price and unlocked by
  usage.
- **Bonus-like issuance item**: An issuance item of kind `bonus`, legacy `promo_first_month_50pct`, or `referral_bonus`.
- **User-global threshold**: The nullable cumulative-usage threshold stored on the user row. A qualifying base-credit
  grant overwrites it with the user's cumulative usage at grant time plus the base-credit amount. The effective trigger
  point subtracts a $1 early-unlock allowance and clamps the result to zero.
- **Monthly ramp**: The default monthly-cadence bonus schedule: 5% in streak month 1, increasing by 5 percentage points
  each streak month to a 40% cap.
- **Streak**: A capped monthly issuance-history scan. The scan walks backward through at most 36 calendar issue months,
  counts issuance months, and allows pause-overlap months to bridge gaps without adding to the count. Stripe yearly
  subscriptions store a streak of `0`.
- **Welcome promo**: A 50% monthly bonus override for eligible first-time subscribers. New grants are recorded as
  `bonus` issuance items.
- **Initial welcome-promo reason**: The nullable reason stored on the earliest issuance for a Stripe monthly
  subscription. Values are `first_payment_fingerprint_claim`, `fingerprint_previously_claimed`, `missing_fingerprint`,
  `no_supported_fingerprint`, `no_positive_settlement`, and `settlement_unresolved`.
- **Welcome-promo fingerprint claim**: A permanent atomic Stripe claim keyed by payment-method type plus fingerprint. It
  stores the first source Stripe invoice and database claim timestamp and is never refreshed. Supported reusable types
  are `card`, `sepa_debit`, `us_bank_account`, `bacs_debit`, and `au_becs_debit`.
- **Paid settlement**: One successful Stripe invoice payment resolved to the payment instrument that settled it and, when
  available, its refundable PaymentIntent or Charge identifier.
- **Eligible duplicate-card purchase**: A first paid monthly or yearly Stripe subscription purchase settled by card.
  Renewals, zero-value starts, later payments for the same subscription, non-card payments, and store-provider purchases
  are not subject to duplicate-card blocking.
- **First fingerprint claimant**: The Kilo user attributed to a card's permanent welcome-promo fingerprint claim by
  joining its source Stripe invoice to an issuance and that issuance to its subscription. Missing attribution is not a
  match and fails open.
- **First-fingerprint-claim cooldown**: The period while a card's permanent first claim is strictly less than 24 hours old
  at database transaction time. Exactly 24 hours is outside the cooldown. Allowed later purchases never refresh or
  replace the first claim, so this is intentionally not a rolling purchase-to-purchase window.
- **Issuance**: A persisted record for one subscription and one **issue month** (a calendar-month anchor such as
  `2026-03-01`).
- **Issuance item**: One credit grant within an issuance, of kind `base`, `bonus`, `promo_first_month_50pct`, or
  `referral_bonus`. New code MUST NOT issue `promo_first_month_50pct`; it remains recognized for idempotency and
  reversal of historical grants.
- **Current issuance**: For monthly cadence, the latest issuance by issue month. For yearly cadence, the issuance
  anchored to the current subscription-month, derived from the next monthly issue cursor or the subscription start.
- **First-time subscriber**: A user with no other Kilo Pass subscription row, regardless of provider or status.
- **Kilo Pass state projection**: The current-period or next-period bonus estimate returned by the Kilo Pass state read
  path for UI display.
- **KiloClaw pending-balance projection**: A narrower read-only estimate used by KiloClaw balance checks after threshold
  crossing. It does not reproduce full Kilo Pass issuance logic.
- **Scheduled change**: A Stripe-only pending tier or cadence change that takes effect at a future billing boundary.

## Overview

Kilo Pass exchanges a recurring payment for monthly base credits and a usage-triggered bonus. Stripe supports monthly
and yearly subscriptions. The exposed mobile store flow supports App Store monthly subscriptions, including purchase
completion and App Store notification handling. Google Play identifiers, state handling, and generic persistence
branches exist, but the repository does not expose a verified Google Play purchase completion or notification flow.

A successful base-credit grant writes one threshold on the user row. When cumulative user usage reaches the effective
threshold, bonus logic acts on the selected effective active subscription. Monthly subscriptions use the tenure ramp
with welcome-promo overrides. Yearly subscriptions use a flat 50% monthly bonus.

### Current provider support

| Capability | Stripe | App Store | Google Play |
|---|---|---|---|
| Persisted provider representation | Yes | Yes | Yes |
| Web state reads | Yes | Yes | Existing rows only |
| Monthly subscription entrypoint | Yes | Yes | Not exposed |
| Yearly subscription entrypoint | Yes | Not exposed | Not exposed |
| Verified purchase completion ingress | Invoice-paid webhook | Signed transaction completion | Not exposed |
| Provider notification handling | Stripe events | App Store server notifications | Not exposed |
| Store-expiry reconciliation | N/A | Yes | Existing rows only |
| Duplicate-card gate | Yes | No | No |
| Scheduled tier/cadence changes | Yes | No | No |

## Rules

### Subscription Selection and Derived State

1. A user MAY hold more than one Kilo Pass subscription row over time. General web state reads and KiloClaw
   pending-balance reads MUST select one effective subscription before applying read-time derivations.
2. Effective subscription selection MUST rank persisted statuses in this order: `active` without pending cancellation;
   `active` with pending cancellation; `trialing`; `past_due`; `paused`; `incomplete`; ended provider statuses; then any
   remaining status.
3. Within one status priority, selection MUST prefer the most recent valid subscription start timestamp, falling back to
   the creation timestamp. Current selection does not apply an explicit identifier tiebreak when recency values match.
4. The web state read path MUST derive store expiration and open-pause state only after one row is selected. If that
   selected row becomes derived `canceled` or `paused`, the path MUST return that row without selecting a different
   subscription row.
5. KiloClaw pending-balance reads MUST apply the same persisted-row ranking and MUST derive an open pause after
   selection. That path does not derive store expiration.
6. Store purchase completion MUST use its own active-row check: the first user subscription row with a null ended
   marker. It does not reuse the general effective-subscription selector or apply an explicit ordering.
7. Persisted subscription rows MUST contain one provider shape at a time: Stripe rows use matching provider and Stripe
   subscription identifiers; store rows use a provider subscription identifier and no Stripe subscription identifier.

### Base Credits and User-Global Threshold

8. A handled Stripe `invoice.paid` event MUST issue base credits equal to the tier's configured monthly price,
   independent of charged amount, tax, discount, or proration. A handled zero-dollar invoice still qualifies for base
   credits.
9. An accepted store purchase MUST issue base credits equal to the tier's configured monthly price, except for App Store
   same-period tier upgrades, which replace the current-period base grant through the upgrade-adjustment path.
10. Stripe yearly subscriptions MUST receive an initial monthly base grant from invoice handling and later monthly base
    grants from the yearly monthly-base cron. The cron processes Stripe rows only.
11. Base credits for a subscription and issue month MUST be issued at most once through the normal issuance path.
12. A successful qualifying base grant MUST overwrite the user-global threshold with cumulative user usage plus the
    configured monthly base amount. The threshold belongs to the user, not to one subscription or issuance. A later
    qualifying base grant MAY replace an earlier threshold.

### Monthly Ramp and Welcome Promo

13. For monthly cadence, the default bonus percent for streak month `n` MUST be `min(40%, 5% + 5% * (n - 1))`.
    Bonus-decision paths MUST clamp streak to at least `1` before applying the ramp.
14. Yearly cadence MUST use a flat monthly bonus of 50% of the monthly price and MUST NOT use the monthly ramp or
    welcome-promo branch.
15. An eligible first-time monthly subscriber MUST receive a 50% bonus in streak month 1 instead of the monthly ramp
    value.
16. An eligible first-time monthly subscriber whose subscription start is strictly before `2026-05-07T00:00:00Z` MUST
    receive a 50% bonus in streak month 2 instead of the monthly ramp value.
17. From streak month 3 onward, and in any month where the welcome promo does not apply, monthly cadence MUST use the
    monthly ramp value.
18. New welcome-promo grants MUST use the `bonus` issuance-item kind with a 50% applied percent.
    `promo_first_month_50pct` remains a recognized legacy kind only.

### Stripe Welcome-Promo Settlement Decision

19. Stripe monthly invoice handling MUST store the initial welcome-promo reason only on the earliest issuance. The
    earliest issuance owns the decision even when its invoice has no positive settlement.
20. When the earliest handled monthly invoice has a positive settlement, the system MUST resolve the settled payment
    method and record `first_payment_fingerprint_claim`, `fingerprint_previously_claimed`, `missing_fingerprint`,
    `no_supported_fingerprint`, or `settlement_unresolved`.
21. When the earliest handled monthly invoice has no positive settlement, the system MUST record
    `no_positive_settlement`. That reason is final. A later positive monthly invoice with a resolvable supported reusable
    fingerprint MUST attempt the permanent fingerprint claim used by welcome-promo, referral, and duplicate-card rules,
    but MUST NOT replace the earliest issuance reason or run duplicate-card cancellation enforcement.
22. A stored `settlement_unresolved` reason MAY be replaced only when the earliest issuance itself is processed again
    with resolvable payment details. A later-period invoice MUST NOT replace the earliest issuance reason.
23. Non-null reasons other than `settlement_unresolved` MUST remain unchanged.
24. A Stripe welcome promo MUST apply only when the user is a first-time subscriber and the stored reason is
    `first_payment_fingerprint_claim`, `missing_fingerprint`, or `no_supported_fingerprint`.
25. `fingerprint_previously_claimed`, `no_positive_settlement`, and `settlement_unresolved` MUST disqualify the Stripe
    welcome promo.
26. A Stripe subscription with no stored reason MUST use first-time subscriber status alone as a legacy fallback.
27. A store subscription MUST use first-time subscriber status alone; store flows do not record a payment-fingerprint
    eligibility reason.
28. Welcome-promo fingerprint uniqueness MUST apply to the pair `(payment-method type, fingerprint)`. Concurrent claims
    for the same pair MUST resolve atomically so that one source invoice wins the claim. The same fingerprint under
    different supported payment-method types is not one shared claim.

### Usage-Triggered Bonus

29. Usage-triggered bonus logic MUST run only when cumulative user usage reaches the stored user-global threshold minus
    $1, clamped to zero.
30. At trigger time, bonus logic MUST select the effective subscription. If no subscription exists or selected derived
    state is not `active`, it MUST clear the threshold and grant nothing.
31. Monthly bonus logic MUST use the latest issuance by issue month. Yearly bonus logic MUST derive the current
    subscription-month from the next monthly issue cursor or subscription start and MAY create an issuance header on
    demand.
32. Bonus logic MUST clear the threshold and grant nothing when current issuance is absent, its base issuance item is
    absent, or any bonus-like issuance item already exists.
33. Normal issuance helpers MUST grant at most one bonus-like item per issuance across `bonus`, legacy
    `promo_first_month_50pct`, and `referral_bonus`. The database uniqueness constraint is per issuance and kind;
    cross-kind exclusivity is enforced by application paths.
34. Bonus grant and threshold clearing MUST occur within one transaction. If the grant throws, rollback MUST leave the
    threshold available for retry.
35. Because threshold storage and subscription selection are user-wide, trigger ownership MUST NOT be treated as
    permanently bound to the subscription whose base grant wrote the threshold.

### Credit Amounts and Rounding

36. Canonical bonus issuance and Kilo Pass state projections MUST compute bonus dollars by rounding the base amount to
    whole cents, multiplying by the bonus percent, and rounding the result to whole cents using round-half-up.
37. The KiloClaw pending-balance projection and scheduled-change renewal UI use narrower direct-multiplication
    calculations. They MUST NOT be treated as canonical bonus computations.

### Projections and UI

38. The Kilo Pass state read path MUST compute current-period and next-period UI bonus projections from tier, cadence,
    streak, first-time-subscriber status, provider, and stored initial welcome-promo reason.
39. Current-period Kilo Pass state projection MUST use current streak. Next-period Kilo Pass state projection MUST use
    current streak plus one.
40. Current-period unlock state MUST report whether the latest issuance contains any bonus-like item. Current-period
    projected dollars remain formula-based and do not substitute an existing `referral_bonus` item's actual amount.
41. Renewal UI without a scheduled change MUST display the server-projected next-period bonus.
42. Renewal UI with a scheduled change MUST recompute bonus against the displayed refill's selected tier and cadence on
    the client. For monthly subscriptions it applies the target tier and cadence. For yearly subscriptions it applies
    the target only when the scheduled effective instant matches the displayed refill instant.
43. Scheduled-change client recomputation does not apply the stored Stripe welcome-promo reason. It MUST NOT be
    described as guaranteed equal to eventual issuance.
44. KiloClaw pending-balance projection MUST run only after effective threshold crossing and MUST return zero unless
    selected state is `active`. For monthly cadence it uses the monthly ramp only; for yearly cadence it uses flat 50%.
45. KiloClaw pending-balance projection does not inspect issuance headers, base issuance items, existing bonus-like
    items, first-time-subscriber status, subscription start, or welcome-promo reason. It MUST be treated as a read-only
    estimate, not an issuance-equivalent result.

### Streak Accounting

46. Monthly streak calculation MUST scan backward from current issue month through at most 36 calendar issue months. An
    issuance month increments streak. A month overlapping a pause event bridges the scan without incrementing streak.
    The first month with neither issuance nor pause stops the scan.
47. Pause months consume scan budget. Monthly streak MUST NOT be described as an unbounded lifetime tenure count.
48. Stripe monthly invoice handling MUST reset streak to `1` when previous persisted provider status was ended. Recovery
    from a non-ended transitional status such as `past_due` does not, by itself, reset streak.
49. Store monthly completion MUST recompute streak from the capped issuance-and-pause scan. It does not separately reset
    streak because a prior store row was ended. Reactivation under the same provider subscription MAY reconnect
    historical streak when issue months remain contiguous.
50. Stripe yearly invoice handling MUST store streak `0` and track the next monthly issue cursor instead. Generic store
    purchase completion accepts yearly input internally but sets initial streak `1`; exposed store products are monthly
    only and no store-yearly monthly-base cron exists.

### Duplicate-Card Gate

Rules 51-55 protect against rapid cross-account reuse of a recently first-used card. Allowed purchases do not restart the
24-hour restriction.

51. A first paid monthly or yearly Stripe subscription purchase MUST be checked after payment and before the purchaser
    receives Kilo Pass credits or other purchase benefits. Renewals, zero-value starts, later payments for the same
    subscription, non-card payments, and store-provider purchases MUST NOT be blocked. A later positive monthly payment
    remains subject to Rule 21 and MAY make its payment instrument count as previously used in future monthly
    welcome-promo and referral eligibility decisions.
52. Duplicate-card and monthly welcome-promo or referral decisions for the same purchase MUST be based on the same paid
    card settlement. The purchase MUST be allowed when that settlement does not identify exactly one paid card. A provider
    lookup failure MUST produce `settlement_unresolved` when a monthly welcome-promo decision is required. Unexpected
    evidence or attribution failures MUST be reported.
53. The first eligible purchase made with a card MUST establish that purchaser as the first claimant and MUST be allowed.
    A different user MUST be blocked only when the first use was less than 24 hours earlier. The first claimant and first-use
    time MUST NOT change. Same-user purchases and different-user purchases at or after 24 hours MUST be allowed, regardless
    of subscription status, cancellation, card attachment, or later allowed purchases. A card first used for a yearly
    purchase MUST count as previously used in later monthly welcome-promo and referral decisions, while the yearly
    purchase itself remains ineligible for those benefits. If the first claimant cannot be determined reliably, the
    purchase MUST be allowed and the failure MUST be reported.
54. Concurrent eligible purchases using the same card MUST produce one first claimant. Retried processing MUST preserve the
    original blocked or allowed outcome, including after the 24-hour restriction expires or card evidence becomes
    unavailable. A blocked outcome MUST take precedence over an allowed outcome. If no prior outcome can be established,
    the purchase MUST receive the standard duplicate-card decision. Conflicting purchaser, subscription, or payment
    identity MUST abort processing rather than trigger a new decision.
55. A blocked purchase or retry MUST create no Kilo Pass issuance, credits, referral conversion, referral reward, or
    affiliate sale. The Kilo Pass subscription MUST remain canceled, and the purchaser MUST receive the permanent
    `kilo_pass_duplicate_card` block unless another block reason already exists. The system MUST attempt to cancel the
    Stripe subscription, refund the settled payment, and send a cancellation email that reveals neither the 24-hour
    restriction nor the matched claimant. Missing refund evidence or provider failure MUST be reported but MUST NOT
    reverse the block or grant benefits. Duplicate-card audit evidence, errors, logs, email, and operational context MUST
    NOT contain the raw card fingerprint.

### Scheduled Changes (Stripe)

56. Scheduled tier and cadence changes MUST be Stripe-only. A Stripe subscription MUST have at most one active
    non-deleted scheduled-change row. Creating a replacement MUST release the existing tracked schedule first.
57. Downgrades, cadence changes, and monthly tier upgrades MUST take effect at current billing-cycle end. A yearly tier
    upgrade MUST take effect at the next monthly issue instant.
58. When a yearly subscription upgrades tier, invoice handling SHOULD issue remaining prior-tier base credits for
    unelapsed months of the prepaid year. The normal path derives elapsed months from the prior paid yearly invoice. If
    no matching prior invoice is found, current code falls back to the effective instant minus 12 months and MAY
    overcount.
59. Tracked schedule release MUST soft-delete the row before Stripe release. If Stripe release fails, it MUST restore
    the row, append a failed audit entry, and rethrow.
60. If scheduled-change creation fails after Stripe schedule creation, cleanup MUST attempt to release the new provider
    schedule. When missing-row cleanup release itself fails, that cleanup error MAY mask the original creation error and
    no failed cleanup audit is guaranteed.
61. Successful missing-row cleanup release MUST append a success audit entry. Current behavior MUST NOT be described as
    preserving the original error under every cleanup failure.

### Pause, Cancellation, and Store Expiry

62. An open pause event MUST derive the selected web state as `paused`, even when persisted provider status remains
    `active`. Derived pause MUST suppress active-only usage-triggered bonus issuance.
63. Paused profile and Subscription Center surfaces MUST suppress renewal rows. They continue to render current-period
    usage and bonus progress.
64. A pending cancellation MUST remain active until period end. UI MUST communicate active-until date. When pause and
    pending cancellation overlap, current renewal-row UI gives active-until display precedence.
65. On the web read path, a selected store subscription whose latest purchase expired at or before now MUST be returned
    as derived `canceled`, even if provider end notification was not received.
66. Store-expiry reconciliation MUST scan non-canceled App Store and Google Play rows, skip rows without purchases, and
    persist `canceled`, clear pending cancellation, and set ended marker when latest purchase expired.

### Bonus Expiry

67. Monthly bonus expiry MUST be derived, when possible, by anchoring issue month to subscription start and advancing by
    whole months.
68. Yearly bonus expiry MUST use the current next-monthly-issue cursor when present and valid.
69. Missing or invalid issuance, subscription, monthly start timestamp, issue month, or yearly cursor MUST produce
    nullable expiry. Bonus grant proceeds without expiry when expiry cannot be derived.
70. Monthly expiry MUST be treated as a subscription-start-anchor approximation, not a provider-confirmed
    billing-boundary value.

### Audit Scope

71. Audit logging MUST be described per path, not as a universal durable ledger guarantee.
72. Stripe invoice-paid mutations and their normal audit entries MUST run in one transaction. On failure, handler MUST
    attempt a separate failed audit write after rollback and report audit-write failure operationally.
73. Yearly monthly-base cron MUST append run and subscription audit entries. A per-subscription issuance failure MUST
    append a failed audit entry and rethrow.
74. Store-expiry reconciliation MUST append success audit after persisted cancellation. App Store expiry notifications
    also append success audit after persisting ended state.
75. Duplicate-card cancellation or refund failures MUST remain operational error reports only. A successful
    duplicate-card audit MUST remain authoritative blocked-replay evidence even when provider enforcement fails. It MUST
    identify the matched first fingerprint claim and fingerprint digest without recording the raw fingerprint.
76. Repeated base or bonus issuance handled by normal issuance helpers MUST append skipped-idempotent audit entries.
    Store-transaction replay and usage-triggered prechecks that find an existing bonus-like item return without an
    equivalent skipped-idempotent audit entry.
77. Usage-triggered bonus call sites do not share one failure-audit wrapper. Some callers append a failed audit entry,
    while others log or propagate the error only.

## Error Handling

1. When a recognizable Kilo Pass Stripe invoice has no resolvable subscription reference or metadata, invoice handling
   MUST throw. The transaction MUST roll back and the handler MUST attempt one failed audit write outside the
   transaction. An invoice with neither recognized Kilo Pass price nor Kilo Pass metadata is ignored because it cannot
   be classified as Kilo Pass.
2. Normal base issuance MUST abort when an idempotent top-up conflict has no matching credit transaction. Persisted
   issuance items cannot reference a missing credit transaction.
3. Bonus issuance MUST throw when promotional-credit grant fails. Because threshold clearing occurs later in the same
   transaction, rollback MUST leave threshold available for retry.
4. Threshold-trigger handling MUST clear threshold and return without issuing when selected subscription is absent or
   non-active, current issuance is absent, base item is absent, or bonus-like item already exists.
5. Duplicate-card provider cancellation and refund failures, and a missing refundable settlement identifier, MUST NOT
   abort the database-side block and MUST NOT permit credits. Such failures MUST be reported operationally and do not
   create persisted reconciliation records.
6. Missing or unsupported duplicate-card evidence and missing first-claimant attribution MUST fail open as described in
   Rules 52-54. Provider lookup failures, multiple paid settlements, and missing first-claimant attribution MUST be
   reported operationally but MUST NOT abort normal invoice processing. Matching blocked-audit or committed-issuance
   attribution conflicts MUST throw and roll back invoice handling. Replay authority MUST NOT be overridden by a later
   fail-open condition.
7. Tracked scheduled-change release failure MUST restore active row, append failed audit, and throw. Missing-row cleanup
   release failure MAY throw without audit and MAY mask originating schedule-creation error.
8. Audit logging MUST NOT be treated as universally independent of business transaction rollback.

## Not Yet Implemented

The following behavior or stronger guarantees are not implemented by current code:

1. Deterministic identifier tiebreak for equal-recency subscription rows.
2. Effective-subscription reselection after late-derived pause or store expiration.
3. Exposed verified Google Play purchase completion and provider notification handling.
4. Mobile-store yearly products and store-yearly monthly issuance lifecycle.
5. Persisted reconciliation state for duplicate-card cancellation or refund partial failures.
6. One canonical projection path that matches issuance eligibility, existing bonus-like item checks, scheduled-change
   target behavior, and stored Stripe promo reason across every consumer.
7. Unbounded or explicitly durable streak accounting beyond the 36-month scan cap.
8. Explicit ended-state streak reset for reactivated store subscriptions.
9. Guaranteed expiry for every granted bonus credit.
10. Independent durable audit recording for every failed provider or issuance operation.
11. Retirement of the grandfathered streak-month-2 promo branch after no eligible pre-cutoff subscriptions remain.
12. Store-provider welcome-promo anti-abuse signals equivalent to Stripe fingerprint claims.
13. Atomic prevention of concurrent or repeated active Kilo Pass purchases by the same user. Duplicate-card Rules 51-55
    intentionally exclude same-user purchases.

## Adjacent Spec Compatibility

The Kilo Pass implementation treats `unpaid` as an ended provider status. The Subscription Center currently treats Kilo
Pass `unpaid` as a visible non-terminal warning state. This produces different profile and Subscription Center
presentation behavior and should be resolved before the adjacent specs are treated as one unified lifecycle contract.

The first-fingerprint-claim cooldown reuses the permanent welcome-promo claim governed by `.specs/impact-referrals.md`.
Passing the cancellation cooldown after 24 hours does not make a previously claimed fingerprint eligible for a welcome
promo or Kilo Pass referral conversion.

## Changelog

### 2026-06-08 -- Yearly duplicate-card enforcement

- First paid yearly purchases are now subject to the same 24-hour cross-account card-reuse restriction as first paid
  monthly purchases.
- A payment instrument used for a first paid yearly purchase counts as previously used in future monthly welcome-promo and
  referral decisions, while yearly purchases remain ineligible for those benefits.

### 2026-06-05 -- First-fingerprint-claim cooldown implementation

- Replaced the rolling accepted-purchase window with a 24-hour cooldown anchored to the permanent first exact
  card fingerprint claim.
- Limited cancellation enforcement to rapid cross-user reuse on positive initial Stripe monthly invoices. Allowed later
  purchases do not refresh the first claim, and previously claimed fingerprints remain ineligible for welcome promos and
  Kilo Pass referral conversions.
- Defined blocked-audit and committed-issuance replay authority while preserving exact-settlement resolution,
  fail-open evidence handling, and the existing duplicate cancellation outcome.

### 2026-06-01 -- Initial spec

- Created retrospectively from current implementation behavior in the Kilo Pass libraries
  (`apps/web/src/lib/kilo-pass/*`), the `kiloPass` tRPC router, the shared bonus-projection utilities
  (`packages/worker-utils/src/kilo-pass-bonus-projection.ts`), and the Kilo Pass enums in
  `packages/db/src/schema-types.ts`.
- Related specs: `.specs/subscription-center.md` (Kilo Pass as a Subscription Center surface),
  `.specs/impact-referrals.md` (Kilo Pass referral bonuses), `.specs/stripe-early-fraud-warnings.md`, and
  `.specs/kiloclaw-billing.md` (shared billing platform).
