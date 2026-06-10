# Impact.com Affiliate Tracking

## Role of This Document

This spec defines business rules and invariants for Impact.com affiliate conversion tracking for eligible KiloClaw
and Kilo Pass monetization. It is the source of truth for what the system must guarantee: attribution capture,
conversion eligibility, provider-facing business facts, reversal behavior, and isolation from unavailable tracking
infrastructure. It does not prescribe implementation mechanics such as handler names, persistence layout, request
formats, retry scheduling, or provider configuration constants.

## Status

Draft -- created 2026-03-31.
Updated 2026-04-01 -- aligned with revised Impact integration document and implementation review.
Updated 2026-04-06 -- clarify that conversion events require an affiliate attribution record.
Updated 2026-04-09 -- treat pure-credit KiloClaw periods as sale events and exclude admin/org flows.
Updated 2026-04-09 -- require a 5-minute delay after SIGNUP delivery before child dispatch.
Updated 2026-04-17 -- define dispute-triggered sale reversals.
Updated 2026-05-12 -- note price-versioned billing preserves affiliate semantics.
Updated 2026-05-20 -- broaden tracking to Kilo Pass SALE conversions and rename the affiliate spec.
Updated 2026-05-20 -- tighten attribution boundaries, SALE uniqueness, Kilo Pass eligibility, reversal scope, and
provider-contract ownership after audit.
Updated 2026-05-28 -- allow full SALE reversal for enforced Stripe EFW refunds.

## Conventions

BCP 14 [RFC 2119] [RFC 8174] keywords apply only when they appear in all capitals: "MUST", "MUST NOT",
"REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL".

## Definitions

- **Impact.com**: Third-party affiliate tracking platform that attributes conversions to affiliate partners.
- **UTT (Universal Tracking Tag)**: Impact.com client-side identity bridge for affiliate tracking contexts.
- **Click ID**: Opaque affiliate tracking identifier conveyed from an Impact affiliate link, such as an `im_ref`
  query value.
- **Accepted affiliate tracking identifier**: Incoming Click ID value that is present and contains at least one
  non-whitespace character. This spec does not define provider- or implementation-owned storage length limits.
- **Affiliate attribution**: Durable record associating a user with the affiliate provider that first attributed that
  user. The record may have no usable Click ID because historical or degraded data must not invalidate an already
  established attribution relationship.
- **First-touch attribution**: Attribution model where only the first affiliate attribution per user/provider is kept.
- **Affiliate provider**: Named affiliate tracking program. The initial provider governed by this spec is `impact`.
- **Conversion event**: Provider-reported affiliate lifecycle fact governed by this spec: SIGNUP, TRIAL_START,
  TRIAL_END, or SALE.
- **SIGNUP delivery**: Provider acceptance of the parent SIGNUP conversion for the attributed user/provider pair.
- **Child conversion event**: TRIAL_START, TRIAL_END, or SALE conversion that depends on prior SIGNUP delivery.
- **Conversion occurrence time**: UTC instant when the business event occurred. When the source system supplies that
  instant, it is authoritative; otherwise the first reliable system observation of the business event is used.
- **Affiliate-eligible KiloClaw payment period**: Personal KiloClaw payment period with a positive monetized amount
  governed by KiloClaw billing. Zero-dollar periods, fully comped periods, organization-scoped KiloClaw activity, and
  admin-only interventions are excluded.
- **Affiliate-eligible Kilo Pass invoice settlement**: Kilo Pass Stripe invoice settlement for an attributed user with
  positive paid amount and resolvable Kilo Pass tier and cadence. Initial purchases and renewals can qualify.
- **Reported amount**: Monetary amount represented in the payment currency's major units from the authoritative
  monetized amount for the eligible event. Catalog/list price and Kilo Pass credit issuance amounts are not substitutes.
- **Kilo Pass tier**: Eligible package level `19`, `49`, or `199`.
- **Kilo Pass cadence**: Eligible billing cadence `monthly` or `yearly`.
- **Promo code**: Provider- or checkout-applied purchase code that is available as a discrete reportable value for an
  eligible SALE.
- **Adverse eligible sale**: Eligible payment-provider-backed SALE whose underlying payment later receives a provider
  dispute notification or is refunded under enforced Stripe Early Fraud Warning handling.
- **Commission reversal**: Provider-facing rejection of an affiliate SALE commission for an adverse eligible sale.
- **Reversal identity**: Provider-retained reference needed to reverse a prior SALE without guessing which reported
  action to reject.
- **Primary operation**: User creation, authentication, subscription settlement, billing progression, or another
  product action that affiliate tracking observes but MUST NOT block.

## Overview

Affiliate tracking lets Impact.com attribute eligible KiloClaw and Kilo Pass conversions to referring partners. When a
visitor reaches Kilo through an accepted affiliate tracking identifier, the system preserves first-touch attribution
and later reports applicable conversion facts to Impact.com at covered lifecycle points.

Architecture remains hybrid: client-side Impact identity bridging plus server-side conversion reporting. Exact provider
request formats, action identifiers, and transport choices belong in integration contracts and code, not this spec.

This integration applies to personal KiloClaw subscriptions and eligible Kilo Pass Stripe invoice settlements.
Organization-scoped KiloClaw instances are not eligible. Kilo Pass inclusion adds SALE conversions only; it does not add
Kilo Pass TRIAL_START or TRIAL_END conversions.

Price-versioned KiloClaw billing does not change affiliate eligibility, attribution, event ordering, or conversion
triggers. SALE amounts continue to use the monetized amount reported by KiloClaw billing. Product reporting values must
stay stable enough to distinguish KiloClaw plan family and Kilo Pass tier/cadence without relying on invoice display text.

For conversions also governed by `.specs/impact-referrals.md`, that referral spec's conversion-time referral-priority
rules override this document's default first-touch affiliate behavior for the initial paid conversion decision. This
document remains authoritative for affiliate event eligibility, delivery sequencing, and affiliate renewal reporting
after the winning attribution is established.

## Rules

### Affiliate Attribution

1. The system MUST support affiliate attribution by provider. The initial provider governed by this spec is `impact`.

2. The system MUST keep at most one affiliate attribution per user/provider pair.

3. When a new user arrives with an accepted affiliate tracking identifier, the system MUST make that attribution durable
   no later than successful account-creation completion.

4. The system MUST preserve an accepted affiliate tracking identifier through authentication redirects and callback
   handling until attribution can be associated with the authenticated user.

5. When an existing user first gains an affiliate attribution during a later authenticated interaction, that association
   MUST follow the same first-touch rules as signup-time attribution and MAY create the user's first SIGNUP conversion.

6. Attribution MUST use first-touch semantics. Once a user/provider attribution exists, later identifiers for that
   provider MUST NOT replace it.

7. If concurrent accepted identifiers race before a user/provider attribution exists, the system MUST retain exactly one
   resulting attribution and MUST NOT overwrite that attribution afterward. Which racing identifier wins is not a
   business guarantee.

8. Click IDs are opaque. The system MUST NOT parse them for meaning, validate their business format, or infer affiliate
   semantics from their contents.

9. Empty or whitespace-only tracking identifier values MUST NOT create a new affiliate attribution.

10. If attribution capture fails, the primary operation MUST remain available and the failure MUST become operationally
    observable.

11. When a user record is deleted through a privacy deletion flow, the system MUST delete affiliate attribution records
    and affiliate event records tied to that user.

### Conversion Events

12. The system MUST report only these conversion event types under this spec:

    | Event | Trigger |
    |---|---|
    | SIGNUP | User's first attributed association for a provider |
    | TRIAL_START | Attributed personal KiloClaw trial subscription becomes active |
    | TRIAL_END | Attributed personal KiloClaw trial subscription ends by product flow |
    | SALE | Affiliate-eligible KiloClaw payment period or Kilo Pass invoice settles |

13. Every conversion event MUST carry its conversion occurrence time as a UTC instant.

14. Every conversion event MUST identify the attributed user with a stable customer identifier. When that user has a
    reportable email address, the event MUST use a normalized one-way email hash rather than raw email.

15. When stored affiliate attribution includes a non-empty Click ID, conversion events MUST report it. When attribution
    exists but its Click ID is absent, empty, or whitespace-only, the event MUST still be reported and MUST omit the
    Click ID fact.

16. SIGNUP, TRIAL_START, and TRIAL_END do not require a commercial payment identifier. Their provider integration MAY
    use provider-generated order identity. SALE events MUST use a durable reconciliation identifier for the eligible
    payment period or invoice they represent.

17. SALE events MUST report the eligible event's reported amount and payment currency. KiloClaw SALE amounts MUST use
    the monetized KiloClaw payment-period amount. Kilo Pass SALE amounts MUST use the positive settled invoice paid
    amount, not catalog price or credit issuance value.

18. The reported amount MUST be normalized to the payment currency's major units without changing the authoritative
    settled or monetized value. Any rounding needed by a provider integration must preserve that business amount.

19. KiloClaw SALE reporting MUST distinguish Standard from Commit using the KiloClaw billing reporting classification.
    If KiloClaw billing exposes a version-aware classification, affiliate SALE reporting MUST preserve that
    classification rather than collapsing it to a less specific plan label.

20. Kilo Pass SALE reporting MUST use this tier/cadence classification and MUST NOT derive classification from invoice
    display text:

    | Tier | Cadence | Reporting category | Reporting name |
    |---|---|---|---|
    | 19 | monthly | `kilo-pass-tier-19-monthly` | `Kilo Pass Tier 19 Monthly` |
    | 19 | yearly | `kilo-pass-tier-19-yearly` | `Kilo Pass Tier 19 Yearly` |
    | 49 | monthly | `kilo-pass-tier-49-monthly` | `Kilo Pass Tier 49 Monthly` |
    | 49 | yearly | `kilo-pass-tier-49-yearly` | `Kilo Pass Tier 49 Yearly` |
    | 199 | monthly | `kilo-pass-tier-199-monthly` | `Kilo Pass Tier 199 Monthly` |
    | 199 | yearly | `kilo-pass-tier-199-yearly` | `Kilo Pass Tier 199 Yearly` |

21. Kilo Pass SALE reporting SHOULD include the resolved Stripe price identifier as the provider SKU when it is
    available. If tier and cadence are resolved but the SKU is unavailable, the SALE MUST still be reported without a
    synthesized SKU. If tier or cadence cannot be resolved, the Kilo Pass invoice is not affiliate-eligible under this
    spec.

22. SALE reporting MUST be idempotent at the business-event level. Each eligible KiloClaw payment period or Kilo Pass
    invoice settlement MAY produce at most one affiliate SALE per provider, even under retries, replays, concurrent
    handling, or duplicate upstream notifications.

23. SALE events SHOULD include promo code reporting when a discrete applied promo code is available. This is not a MUST:
    some discounts or negotiated pricing have no reportable promo code, and omission MUST NOT suppress SALE eligibility.

24. The SIGNUP conversion MUST be reported at most once per user/provider pair, on that pair's first attributed
    association.

25. Child conversion events MUST NOT be submitted before SIGNUP delivery for the same user/provider pair. Child dispatch
    is permitted only when `dispatch_time >= signup_delivery_time + 5 minutes`.

26. If SIGNUP delivery has not occurred, child conversion events MUST remain unsent. This MUST NOT delay or roll back the
    primary operation that produced the child event.

27. Admin-only subscription interventions, such as admin trial resets, admin cancellations, or manual trial-date edits,
    MUST NOT emit affiliate conversion events.

### Adverse Payment Reversals

28. When the payment provider reports creation of a dispute for an adverse eligible sale, or Kilo refunds that sale under
    enforced Stripe Early Fraud Warning handling, the system MUST submit a full commission reversal. This covers
    payment-provider-backed personal KiloClaw SALE events and eligible Kilo Pass SALE events.

29. Partial payment disputes and an enforced EFW refund of only the remaining refundable amount MUST still reverse the
    full associated affiliate commission.

30. The system MUST NOT automatically restore reversed commission if the dispute is later resolved in the brand's favor
    or an EFW-enforced account later receives legitimate-user remediation.

31. Reversal handling MUST preserve intent when a dispute or enforced EFW refund arrives before the corresponding SALE is
    reversal-ready. Once the relevant SALE and reversal identity become resolvable, the pending adverse payment MUST be
    eligible for reversal submission.

32. Automatic reversal is REQUIRED only when a reversal identity exists or can be recovered without guessing. If an
    earlier eligible sale lacks recoverable reversal identity, the system MUST make that gap operationally observable for
    non-automated follow-up.

33. Reversal processing MUST be idempotent. Duplicate dispute notifications, duplicate EFW processing, or a later
    dispute for an already EFW-reversed eligible sale MUST NOT produce multiple commission reversals.

### Client-Side Identity Bridging

34. When Impact client-side identity bridging is configured, the system MUST load it on pages covered by affiliate
    tracking.

35. When Impact client-side identity bridging is not configured, the system MUST NOT attempt to load it.

36. After a user authenticates, the system MUST associate the client-side Impact identity context with the user's stable
    internal customer identifier and normalized one-way email hash.

### Reliability and Isolation

37. Affiliate attribution capture, conversion reporting, and reversal reporting MUST NOT block or delay the primary
    operation they observe.

38. If Impact outbound credentials are not configured, the system MUST still preserve local attribution and conversion or
    reversal intent required by this spec, MUST skip outbound Impact delivery, and MUST allow primary product flows to
    continue normally. This spec does not require later replay of outbound delivery skipped solely for missing credentials.

39. Transient provider or infrastructure delivery failures MUST leave the affected conversion or reversal eligible for
    later delivery unless a separate explicit terminal condition applies.

40. Provider rejections that cannot succeed unchanged MAY become terminal, but they MUST remain operationally observable
    and MUST NOT affect the primary operation.

41. Tracking and reporting failures MUST be observable without exposing raw Click IDs, unhashed customer email, auth
    material, or other sensitive tracking data in logs.

### Rewardful Removal

42. Rewardful MUST NOT participate in affiliate attribution, conversion reporting, checkout eligibility, or affiliate
    commission behavior governed by this spec.

## Changelog

### 2026-05-28 -- Enforced EFW refund reversals

Expanded adverse SALE reversal to enforced Stripe Early Fraud Warning refunds so proactive refunds can reverse a full eligible affiliate commission without waiting for a dispute, while preserving reversal identity and deduplication requirements.

### 2026-05-20 -- Audit clarifications after Kilo Pass expansion

Removed VISIT reporting from this spec, clarified that Kilo Pass affiliate SALE requires a positive paid invoice amount,
kept SALE reporting active when Kilo Pass SKU is missing but tier/cadence are known, and confirmed that Kilo Pass disputes
reverse affiliate commissions. Tightened first-touch timing, Click ID omission behavior for blank historical attribution,
SALE and reversal idempotency, child dispatch timing, dispute ordering, missing-credential behavior, and the boundary
between business invariants and provider wire/configuration details.

### 2026-05-20 -- Expand Impact affiliate tracking to Kilo Pass

Renamed this spec to `.specs/impact-affiliate-tracking.md` and broadened its scope from KiloClaw-only tracking to
eligible KiloClaw and Kilo Pass monetization. Kilo Pass SALE events report attributed paid Stripe invoice settlements
with tier/cadence product classification and resolved Stripe price identity when available. Dispute-triggered reversals
apply to eligible Kilo Pass SALE events.

### 2026-05-12 -- Price-versioned billing preserves affiliate semantics

Reviewed against KiloClaw price-versioned billing. Eligibility, attribution, event ordering, and conversion triggers are
unchanged; SALE reporting continues to use the monetized amount supplied by billing.

### 2026-03-31 -- Initial spec

### 2026-03-31 -- Rename SUBSCRIPTION_START to SALE

Renamed SUBSCRIPTION_START to SALE because it covers all KiloClaw payments (initial purchase and renewals), not just
subscription creation. Clarified that SALE events fire for every paid invoice.

### 2026-04-01 -- Align spec with revised Impact integration guide

Recorded then-current provider integration expansion for visit and renewal reporting. Later changelog entries supersede
parts of that integration shape as event scope and reporting ownership changed.

### 2026-04-02 -- Remove RE_SUBSCRIPTION event, use SALE for all paid invoices

The RE_SUBSCRIPTION action tracker (71660) no longer exists in Impact.com. Removed RE_SUBSCRIPTION and consolidated all
paid KiloClaw invoice tracking under SALE (71659). The `Numeric1` month number field is no longer sent. Initial and
renewal invoices now fire the same SALE conversion.

### 2026-04-06 -- Clarify attribution-gated conversion events

Error-handling rule 4 previously required sending conversion events for all users, including those without an affiliate
attribution record. Updated it to require conversion events only for users with an attribution record (i.e. users who
arrived via an affiliate link). Sending events for non-affiliate users inflates Impact conversion volume with
unattributable data. The click ID within the attribution record may still be empty/null; the attribution record itself
is the gate, not the click ID value.

### 2026-04-09 -- Queue parent-child delivery by attributed association

Updated the SIGNUP rule to trigger once per user/provider on the first attributed association, not only on new account
creation. Added an invariant that child conversion events must not be sent before successful parent SIGNUP delivery.

### 2026-04-09 -- Count pure-credit periods as sale events and exclude admin/org flows

Clarified that SALE covers every monetized KiloClaw payment period, including pure-credit funding and Stripe invoice
settlements. Explicitly excluded organization-scoped KiloClaw instances and admin-only subscription interventions from
affiliate tracking.

### 2026-04-09 -- Delay child dispatch after SIGNUP delivery

Added a required 5-minute gap between Impact SIGNUP delivery and child conversion event dispatch, giving Impact.com
time to process the parent event before TRIAL_START, TRIAL_END, or SALE requests arrive.

### 2026-04-17 -- Reverse disputed Stripe-backed sales

Added rules requiring full SALE reversals for Stripe disputes on personal KiloClaw subscriptions. Clarified that
reversals happen when the provider reports the dispute, won disputes do not auto-restore commission, and legacy sales
without recoverable reversal identity require manual follow-up.
