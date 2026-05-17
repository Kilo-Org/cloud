# Impact.com Affiliate Tracking

## Role of This Document

This spec defines business rules and invariants for Impact.com affiliate conversion tracking for KiloClaw
subscriptions. It is the source of truth for what the system must guarantee: tracked events, attribution capture, data
sent to Impact.com, and behavior when tracking infrastructure is unavailable. It does not prescribe implementation:
handler names, column layouts, retry strategies, and other implementation choices belong in plans and code.

## Status

Draft -- created 2026-03-31.
Updated 2026-04-01 -- aligned with revised Impact integration document and implementation review.
Updated 2026-04-06 -- clarify that conversion events require an affiliate attribution record.
Updated 2026-04-09 -- treat pure-credit KiloClaw periods as sale events and exclude admin/org flows.
Updated 2026-04-09 -- require a 5-minute delay after SIGNUP delivery before child dispatch.
Updated 2026-04-17 -- define dispute-triggered sale reversals.
Updated 2026-05-12 -- note price-versioned billing preserves affiliate semantics.

## Conventions

BCP 14 [RFC 2119] [RFC 8174] keywords apply only when they appear in all capitals: "MUST", "MUST NOT",
"REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL".

## Definitions

- **Impact.com**: Third-party affiliate tracking platform that attributes conversions to affiliate partners.
- **UTT (Universal Tracking Tag)**: Impact.com JavaScript snippet for client-side tracking and cross-domain identity
  bridging.
- **Click ID**: Opaque tracking identifier (`im_ref` query parameter) that Impact.com appends to landing page URLs
  when a visitor arrives via an affiliate tracking link.
- **Conversion**: Event reported to Impact.com's Conversions API for a meaningful customer lifecycle step: visit,
  signup, trial, or subscription payment.
- **Lead event**: Conversion representing a visit or user signup. In Impact.com's parent-child model, SIGNUP is the
  parent action.
- **Sale event**: Conversion representing a trial or subscription payment. In Impact.com's parent-child model, these
  child actions link to the lead via the customer identifier.
- **Affiliate attribution**: Record associating a user with the affiliate tracking identifier that brought them to the
  platform.
- **First-touch attribution**: Attribution model where only the first affiliate interaction per provider is recorded for
  a user.
- **Affiliate provider**: Named affiliate tracking platform (e.g. `impact`). The system supports multiple providers,
  each storing one attribution per user.

## Overview

Affiliate tracking lets Impact.com attribute KiloClaw conversions to referring partners. When a visitor arrives via an
affiliate tracking link, the system captures and persists the tracking identifier. As the visitor progresses through the
customer lifecycle -- signup, trial, subscription -- the system reports each stage to Impact.com as a conversion event,
including the tracking identifier and customer details needed for attribution.

Architecture is hybrid: client-side UTT for cross-domain identity bridging, plus server-side API calls for reliable
conversion reporting resistant to ad blockers and browser tracking prevention.

This integration applies only to personal KiloClaw subscriptions. Organization-scoped KiloClaw instances are not
eligible for affiliate tracking.

Price-versioned KiloClaw billing does not change affiliate eligibility, attribution, event ordering, or conversion
triggers. SALE amounts continue to use the monetized amount reported by KiloClaw billing, and plan/category values may
include billing's version-aware classification without changing this spec's attribution semantics.

For KiloClaw conversions also governed by `.specs/kiloclaw-referrals.md`, that referral spec's conversion-time
referral-priority rules override this document's default first-touch affiliate behavior for the initial paid conversion
decision. This document remains authoritative for Impact Performance event shapes, delivery sequencing, and affiliate
renewal reporting after the winning attribution is established.

## Rules

### Affiliate Attribution

1. The system MUST support multiple affiliate providers identified by a provider enum. The initial provider is `impact`.

2. The system MUST store at most one attribution per user per provider.

3. When a user arrives with an affiliate tracking identifier (`im_ref` query parameter for Impact.com), the system MUST
   persist the identifier before or during user creation.

4. The system MUST preserve the tracking identifier across the authentication flow (e.g. through OAuth redirects) so it
   is available after authentication.

5. Attribution MUST use first-touch semantics: if a user already has an attribution record for a provider, subsequent
   tracking identifiers for that provider MUST NOT overwrite it.

6. The tracking identifier MUST be opaque. The system MUST NOT parse it, validate its format, or assign meaning to its
   contents.

7. When a user record is deleted (e.g. GDPR soft-delete), the system MUST delete all affiliate attribution records for
   that user.

### Conversion Events

8. The system MUST report these conversion events to Impact.com, in customer lifecycle order:

   | Event       | ActionTrackerId | Impact.com Type | Trigger                                       |
   | ----------- | --------------- | --------------- | --------------------------------------------- |
   | VISIT       | 71668           | Lead            | Visitor lands on `kilo.ai` with `im_ref`      |
   | SIGNUP      | 71655           | Lead            | New user creation (with attribution)          |
   | TRIAL_START | 71656           | Sale            | KiloClaw trial subscription becomes active    |
   | TRIAL_END   | 71658           | Sale            | KiloClaw trial subscription ends (any reason) |
   | SALE        | 71659           | Sale            | Monetized KiloClaw payment period is funded   |

9. Each conversion event sent to Impact.com MUST include:
   - Event timestamp
   - Order identifier
   - User affiliate tracking identifier, when available
   - Stable customer identifier, when available
   - Customer email address, SHA-1 hashed, when available

10. VISIT events MUST include only `EventDate`, `ClickId`, and `OrderId`. VISIT events MUST NOT include `CustomerId`,
    `CustomerEmail`, `IpAddress`, or `CustomerStatus`.

11. VISIT events MUST fire on the marketing site (`kilo.ai`) before a user account exists. VISIT events MUST NOT create
    a `user_affiliate_attributions` row.

12. When no meaningful internal order identifier is available, the system MUST send `IR_AN_64_TS` as `OrderId`.
    Impact.com generates a unique alphanumeric order identifier from this macro. This applies to VISIT, SIGNUP,
    TRIAL_START, and TRIAL_END events. These generated identifiers MUST NOT be used for internal reconciliation.

13. SIGNUP and TRIAL_START events MUST include `ClickId` alongside `CustomerId` as an attribution fallback. This covers
    child events processed before the parent SIGNUP event finishes processing. For later sale events, including
    `ClickId` is RECOMMENDED but not REQUIRED.

14. VISIT events MUST NOT include `CustomerId` because the user does not yet exist.

15. SALE events MUST include the monetized amount and currency for the funded KiloClaw period.

16. SALE events MUST include the subscription plan identifier (e.g. `kiloclaw-standard`, `kiloclaw-commit`) as the item
    category.

17. SALE events MUST be reported for every monetized KiloClaw payment period (initial and renewal), including Stripe
    invoice settlements and pure-credit deductions.

18. Conversion events SHOULD include a promo code when one was applied to the transaction.

19. The SIGNUP event MUST be sent at most once per user per provider, on that user's first attributed association for
    the provider. This MAY occur during new user creation or a later sign-in when an existing user first gains affiliate
    attribution.

20. Child conversion events (TRIAL_START, TRIAL_END, SALE) MUST NOT be sent before the parent SIGNUP event has been
    successfully delivered. For Impact.com, child conversion events MUST NOT be dispatched until at least 5 minutes
    after SIGNUP delivery.

21. Admin-only subscription interventions (for example admin trial resets, admin cancellations, or manual trial-date
    edits) MUST NOT emit affiliate conversion events. These are internal overrides, not customer lifecycle events.

22. When a Stripe-backed personal KiloClaw SALE later receives a `charge.dispute.created` event, the system MUST submit
    a reversal for the full associated Impact.com commission.

23. Partial Stripe disputes MUST still reverse the full associated Impact.com commission.

24. The system MUST trigger the reversal on `charge.dispute.created`. The system MUST NOT automatically restore the
    commission later if the dispute is resolved in the brand's favor.

25. Automatic reversal is only guaranteed for SALE events created after rollout that persisted an Impact action mapping
    for the disputed Stripe charge. Earlier SALE events without stored mapping are out of scope for automatic reversal
    and require manual follow-up.

### Client-Side Tracking (UTT)

22. The system MUST load the Impact.com UTT script on all pages when the UTT identifier is configured.

23. The system MUST NOT load the UTT script when the UTT identifier is not configured.

24. After a user authenticates, the system MUST call the UTT `identify` function with the user's internal ID and SHA-1
    hashed email to enable cross-device attribution.

### Reliability and Isolation

25. Conversion reporting MUST NOT block or delay the primary operation it is attached to (user creation, subscription
    settlement, etc.). Failures in conversion reporting MUST be handled asynchronously.

26. If Impact.com credentials are not configured, all tracking operations MUST be no-ops. The application MUST function
    normally without Impact.com configuration.

27. The system SHOULD retry conversion API calls that receive a server error (5xx) response.

28. The system MUST log conversion reporting failures for observability.

### Rewardful Removal

29. The existing Rewardful integration MUST be fully removed, including the client-side script, server-side cookie
    reading, and checkout session metadata populated by Rewardful.

### Checkout Metadata

30. The KiloClaw checkout session MUST include the user's affiliate tracking identifier (if any) in Stripe subscription
    metadata, so webhook handlers can access it without a database lookup.

### API Contract

31. Conversion API requests MUST use JSON request bodies, not form-encoded bodies.

32. Conversion API requests MUST use `ActionTrackerId` to identify the configured event, not `EventTypeId`.

### Reference Values

33. The implementation MUST treat these program identifiers as configuration constants for this integration:
    - CampaignId: `50754`
    - UTT UUID: `A7138521-9724-4b8f-95f4-1db2fbae81141`
    - ActionTrackerIds: `71655`, `71656`, `71658`, `71659`, `71668`

## Error Handling

1. When a conversion API call fails with a client error (4xx), the system MUST log the error and MUST NOT retry.

2. When a conversion API call fails with a server error (5xx), the system SHOULD retry with backoff.

3. When a conversion API call fails for any reason, the primary operation (user creation, invoice settlement, etc.) MUST
   NOT be affected.

4. Conversion events (SIGNUP, TRIAL_START, TRIAL_END, SALE) MUST only be sent for users with an affiliate attribution
   record. Users who did not arrive via an affiliate link MUST NOT generate conversion events. When an attribution
   record exists but its stored click ID is empty or null, the event MUST still be sent with an empty or null click ID.

## Changelog

### 2026-05-12 -- Price-versioned billing preserves affiliate semantics

Reviewed against KiloClaw price-versioned billing. Eligibility, attribution, event ordering, and conversion triggers are
unchanged; SALE reporting continues to use the monetized amount supplied by billing.

### 2026-03-31 -- Initial spec

### 2026-03-31 -- Rename SUBSCRIPTION_START to SALE

Renamed SUBSCRIPTION_START to SALE because it covers all KiloClaw payments (initial purchase and renewals), not just
subscription creation. Clarified that SALE events fire for every paid invoice.

### 2026-04-01 -- Align spec with revised Impact integration guide

Added VISIT and RE_SUBSCRIPTION events; switched API terminology to `ActionTrackerId`; documented JSON request bodies;
clarified `IR_AN_64_TS` order ID usage; required `ClickId` fallback on early events; added `Numeric1` month tracking
for renewals; recorded the concrete Campaign/UTT/ActionTracker identifiers from the latest implementation guide.

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
reversals happen when `charge.dispute.created` arrives, won disputes do not auto-restore commission, and legacy sales
without stored Impact action mapping require manual follow-up.
