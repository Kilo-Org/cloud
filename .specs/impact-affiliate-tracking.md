# Impact.com Affiliate Tracking

## Role of This Document

This spec defines the business rules and invariants for affiliate conversion tracking via Impact.com for KiloClaw
subscriptions. It is the source of truth for _what_ the system must guarantee — which events are tracked, how
attribution is captured, what data is sent to Impact.com, and how the system behaves when tracking infrastructure is
unavailable. It deliberately does not prescribe _how_ to implement those guarantees: handler names, column layouts,
retry strategies, and other implementation choices belong in plan documents and code, not here.

## Status

Draft -- created 2026-03-31.
Updated 2026-04-01 -- aligned with revised Impact integration document and implementation review.
Updated 2026-04-06 -- clarify that conversion events require an affiliate attribution record.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED",
"NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119]
[RFC 8174] when, and only when, they appear in all capitals, as shown here.

## Definitions

- **Impact.com**: The third-party affiliate tracking platform used to attribute conversions to affiliate partners.
- **UTT (Universal Tracking Tag)**: A JavaScript snippet provided by Impact.com that enables client-side tracking and
  cross-domain identity bridging.
- **Click ID**: An opaque tracking identifier (`im_ref` query parameter) appended to landing page URLs by Impact.com
  when a visitor arrives via an affiliate tracking link.
- **Conversion**: An event reported to Impact.com's Conversions API representing a meaningful step in the customer
  lifecycle (visit, signup, trial, or subscription payment).
- **Lead event**: A conversion representing a visit or user signup. In Impact.com's parent-child model, the SIGNUP
  event is the parent action.
- **Sale event**: A conversion representing a trial or subscription payment. In Impact.com's parent-child model, these
  are child actions linked to the lead via the customer identifier.
- **Affiliate attribution**: A record associating a user with the affiliate tracking identifier that brought them to
  the platform.
- **First-touch attribution**: The attribution model used: only the first affiliate interaction per provider is recorded
  for a given user.
- **Affiliate provider**: A named affiliate tracking platform (e.g. `impact`). The system supports multiple providers,
  each storing one attribution per user.

## Overview

Affiliate tracking enables Impact.com to attribute KiloClaw conversions to the affiliate partners that referred them.
When a visitor arrives via an affiliate tracking link, the system captures and persists the tracking identifier. As the
visitor progresses through the customer lifecycle — signup, trial, subscription — the system reports each stage to
Impact.com as a conversion event, including the tracking identifier and customer details needed for attribution.

The system uses a hybrid tracking architecture: a client-side JavaScript tag (UTT) for cross-domain identity bridging,
and server-side API calls for reliable conversion reporting that is resistant to ad blockers and browser tracking
prevention.

This integration applies only to KiloClaw subscriptions.

## Rules

### Affiliate Attribution

1. The system MUST support multiple affiliate providers, identified by a provider enum. The initial provider is
   `impact`.

2. The system MUST store at most one attribution per user per provider.

3. When a user arrives with an affiliate tracking identifier (`im_ref` query parameter for Impact.com), the system MUST
   persist the identifier before or during user creation.

4. The system MUST preserve the tracking identifier across the authentication flow (e.g. through OAuth redirects) so it
   is available after the user is authenticated.

5. Attribution MUST use first-touch semantics: if a user already has an attribution record for a given provider,
   subsequent tracking identifiers for that provider MUST NOT overwrite it.

6. The tracking identifier MUST be treated as opaque. The system MUST NOT parse, validate the format of, or assign
   meaning to its contents.

7. When a user record is deleted (e.g. GDPR soft-delete), the system MUST delete all affiliated attribution records for
   that user.

### Conversion Events

8. The system MUST report the following conversion events to Impact.com, in order of the customer lifecycle:

   | Event       | ActionTrackerId | Impact.com Type | Trigger                                       |
   | ----------- | --------------- | --------------- | --------------------------------------------- |
   | VISIT       | 71668           | Lead            | Visitor lands on `kilo.ai` with `im_ref`      |
   | SIGNUP      | 71655           | Lead            | New user creation (with attribution)          |
   | TRIAL_START | 71656           | Sale            | KiloClaw trial subscription becomes active    |
   | TRIAL_END   | 71658           | Sale            | KiloClaw trial subscription ends (any reason) |
   | SALE        | 71659           | Sale            | Paid KiloClaw invoice settles                 |

9. Each conversion event sent to Impact.com MUST include:
   - An event timestamp
   - An order identifier
   - The user's affiliate tracking identifier, when available for that event
   - A stable customer identifier, when available for that event
   - The customer's email address, SHA-1 hashed, when available for that event

10. VISIT events MUST only include `EventDate`, `ClickId`, and `OrderId`. VISIT events MUST NOT include `CustomerId`,
    `CustomerEmail`, `IpAddress`, or `CustomerStatus`.

11. VISIT events MUST fire on the marketing site (`kilo.ai`) before a user account exists. VISIT events MUST NOT create
    a `user_affiliate_attributions` row.

12. When a meaningful internal order identifier is not available, the system MUST send `IR_AN_64_TS` as `OrderId`.
    Impact.com generates a unique alphanumeric order identifier from this macro. This applies to VISIT, SIGNUP,
    TRIAL_START, and TRIAL_END events. These generated identifiers MUST NOT be relied on for internal reconciliation.

13. SIGNUP and TRIAL_START events MUST include `ClickId` alongside `CustomerId` as an attribution fallback. This covers
    the case where a child event is processed before the parent SIGNUP event finishes processing. For later sale events,
    including `ClickId` is RECOMMENDED but not REQUIRED.

14. VISIT events MUST NOT include `CustomerId` because the user does not yet exist.

15. SALE events MUST include the invoice amount and currency.

16. SALE events MUST include the subscription plan identifier (e.g. `kiloclaw-standard`,
    `kiloclaw-commit`) as the item category.

17. SALE events MUST be reported for every paid KiloClaw invoice on a subscription (both initial and renewal).

18. Conversion events SHOULD include a promo code when one was applied to the transaction.

19. The SIGNUP event MUST be sent at most once per user per provider, on that user's first attributed association for
    the provider. This MAY occur during new user creation or during a later sign-in when an existing user first gains
    affiliate attribution.

20. Child conversion events (TRIAL_START, TRIAL_END, SALE) MUST NOT be sent before the parent SIGNUP event has been
    successfully delivered.

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

29. The existing Rewardful integration MUST be fully removed. This includes the client-side script, server-side cookie
    reading, and any checkout session metadata populated by Rewardful.

### Checkout Metadata

30. The KiloClaw checkout session MUST include the user's affiliate tracking identifier (if any) in Stripe subscription
    metadata, so it is available to webhook handlers independently of a database lookup.

### API Contract

31. Conversion API requests MUST use JSON request bodies, not form-encoded bodies.

32. Conversion API requests MUST use `ActionTrackerId` to identify the configured event, not `EventTypeId`.

### Reference Values

33. The implementation MUST treat the following program identifiers as configuration constants for this integration:
    - CampaignId: `50754`
    - UTT UUID: `A7138521-9724-4b8f-95f4-1db2fbae81141`
    - ActionTrackerIds: `71655`, `71656`, `71658`, `71659`, `71668`

## Error Handling

1. When a conversion API call fails with a client error (4xx), the system MUST log the error and MUST NOT retry.

2. When a conversion API call fails with a server error (5xx), the system SHOULD retry with backoff.

3. When a conversion API call fails for any reason, the primary operation (user creation, invoice settlement, etc.) MUST
   NOT be affected.

4. Conversion events (SIGNUP, TRIAL_START, TRIAL_END, SALE) MUST only be sent for users who have an affiliate
   attribution record. Users who did not arrive via an affiliate link MUST NOT generate conversion events. When an
   attribution record exists but the click ID stored in it is empty or null, the event MUST still be sent with an
   empty or null click ID.

## Changelog

### 2026-03-31 -- Initial spec

### 2026-03-31 -- Rename SUBSCRIPTION_START to SALE

Renamed the SUBSCRIPTION_START event to SALE to reflect that it covers all KiloClaw payments (initial purchase and
renewals), not just subscription creation. Clarified that SALE events fire for every paid invoice.

### 2026-04-01 -- Align spec with revised Impact integration guide

Added the VISIT and RE_SUBSCRIPTION events, switched API terminology to `ActionTrackerId`, documented JSON request
bodies, clarified `IR_AN_64_TS` order ID usage, required `ClickId` fallback on early events, added `Numeric1` month
tracking for renewals, and recorded the concrete Campaign/UTT/ActionTracker identifiers from the latest implementation
guide.

### 2026-04-02 -- Remove RE_SUBSCRIPTION event, use SALE for all paid invoices

The RE_SUBSCRIPTION action tracker (71660) no longer exists in Impact.com. Removed the RE_SUBSCRIPTION event and
consolidated all paid KiloClaw invoice tracking under the SALE event (71659). The `Numeric1` month number field is no
longer sent. Both initial and renewal invoices now fire the same SALE conversion.

### 2026-04-06 -- Clarify attribution-gated conversion events

Error-handling rule 4 previously required sending conversion events for all users, even those without an affiliate
attribution record. Updated to clarify that conversion events MUST only be sent for users with an attribution record
(i.e., users who arrived via an affiliate link). Sending events for non-affiliate users inflates Impact conversion
volume with unattributable data. The click ID within the attribution record may still be empty/null — the attribution
record itself is the gate, not the click ID value.

### 2026-04-09 -- Queue parent-child delivery by attributed association

Updated the SIGNUP rule to trigger once per user/provider on the first attributed association rather than only on new
account creation. Added an invariant that child conversion events must not be sent before the parent SIGNUP event has
been successfully delivered.
