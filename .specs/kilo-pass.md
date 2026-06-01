# Kilo Pass

## Role of This Document

This spec records the Kilo Pass behavior implemented in the current codebase: valid states, provider support, credit
amounts, eligibility rules, lifecycle behavior, and known limits. It is intended to become the source of truth for
future work. While this draft is being aligned retrospectively, code remains authoritative when this document and the
implementation disagree.

Billing-platform behavior shared with other products (Stripe webhook processing, fraud warnings, the Subscription Center
surface, affiliate/referral attribution) is governed by the adjacent specs listed in the Changelog and is summarized
here only where Kilo Pass adds product-specific behavior.

## Status

Draft -- current-code alignment revision created 2026-06-01.

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
- **Welcome-promo fingerprint claim**: An atomic Stripe claim keyed by payment-method type plus fingerprint. Supported
  reusable types are `card`, `sepa_debit`, `us_bank_account`, `bacs_debit`, and `au_becs_debit`.
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
    `no_positive_settlement`. Under current behavior that reason is final: a later paid invoice MAY claim a fingerprint
    but MUST NOT replace the earliest issuance reason.
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

51. Duplicate-card gate MUST run for every handled Stripe `invoice.paid` event before credit issuance, not only for an
    explicitly identified first invoice.
52. Gate MUST inspect card fingerprint only. It MUST first attempt to resolve fingerprint from invoice payment intent
    and MAY fall back to one locally stored payment-method fingerprint for the charged user.
53. Gate MUST block when a different user has the same locally stored card fingerprint and any non-ended Kilo Pass row
    with a null ended marker. It does not prove that the other user's Kilo Pass row was paid with the matching card.
    Same-user subscriptions MUST NOT trigger the gate.
54. Blocking MUST suppress credit issuance and affiliate sale processing, persist the newly handled subscription row as
    canceled, set the duplicate-card blocked reason when the user is not already blocked, and attempt to send the
    duplicate-card cancellation email.
55. Stripe cancellation and refund attempts MUST be best effort. Their failures are captured operationally but do not
    prevent the database block and do not create persisted reconciliation state. The gate does not provide an atomic
    exactly-one-winner guarantee across concurrent new subscriptions.

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
75. Duplicate-card cancellation or refund failures MUST remain operational error reports only. The duplicate-card audit
    MAY still record a successful database-side block.
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
5. Duplicate-card provider cancellation and refund failures MUST NOT abort the database-side block and MUST NOT permit
   credits. Such failures do not create persisted reconciliation records.
6. Tracked scheduled-change release failure MUST restore active row, append failed audit, and throw. Missing-row cleanup
   release failure MAY throw without audit and MAY mask originating schedule-creation error.
7. Audit logging MUST NOT be treated as universally independent of business transaction rollback.

## Not Yet Implemented

The following stronger guarantees are not implemented by current code:

1. Deterministic identifier tiebreak for equal-recency subscription rows.
2. Effective-subscription reselection after late-derived pause or store expiration.
3. Exposed verified Google Play purchase completion and provider notification handling.
4. Mobile-store yearly products and store-yearly monthly issuance lifecycle.
5. Atomic duplicate-card arbitration across concurrent Stripe subscriptions.
6. Persisted reconciliation state for duplicate-card cancellation or refund partial failures.
7. One canonical projection path that matches issuance eligibility, existing bonus-like item checks, scheduled-change
   target behavior, and stored Stripe promo reason across every consumer.
8. Unbounded or explicitly durable streak accounting beyond the 36-month scan cap.
9. Explicit ended-state streak reset for reactivated store subscriptions.
10. Guaranteed expiry for every granted bonus credit.
11. Independent durable audit recording for every failed provider or issuance operation.
12. Retirement of the grandfathered streak-month-2 promo branch after no eligible pre-cutoff subscriptions remain.
13. Store-provider welcome-promo anti-abuse signals equivalent to Stripe fingerprint claims.

## Adjacent Spec Compatibility

The Kilo Pass implementation treats `unpaid` as an ended provider status. The Subscription Center currently treats Kilo
Pass `unpaid` as a visible non-terminal warning state. This produces different profile and Subscription Center
presentation behavior and should be resolved before the adjacent specs are treated as one unified lifecycle contract.

## Changelog

### 2026-06-01 -- Initial spec

- Created retrospectively from current implementation behavior in the Kilo Pass libraries
  (`apps/web/src/lib/kilo-pass/*`), the `kiloPass` tRPC router, the shared bonus-projection utilities
  (`packages/worker-utils/src/kilo-pass-bonus-projection.ts`), and the Kilo Pass enums in
  `packages/db/src/schema-types.ts`.
- Related specs: `.specs/subscription-center.md` (Kilo Pass as a Subscription Center surface),
  `.specs/impact-referrals.md` (Kilo Pass referral bonuses), `.specs/stripe-early-fraud-warnings.md`, and
  `.specs/kiloclaw-billing.md` (shared billing platform).
