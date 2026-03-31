# Impact.com Affiliate Tracking

## Role of This Document

This spec defines the business rules and invariants for affiliate conversion tracking via Impact.com for KiloClaw
subscriptions. It is the source of truth for _what_ the system must guarantee — which events are tracked, how
attribution is captured, what data is sent to Impact.com, and how the system behaves when tracking infrastructure is
unavailable. It deliberately does not prescribe _how_ to implement those guarantees: handler names, column layouts,
retry strategies, and other implementation choices belong in plan documents and code, not here.

## Status

Draft -- created 2026-03-31.

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
  lifecycle (signup, trial, or subscription payment).
- **Lead event**: A conversion representing a user signup. In Impact.com's parent-child model, this is the parent
  action.
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

   | Event       | Impact.com Type | Trigger                                       |
   | ----------- | --------------- | --------------------------------------------- |
   | SIGNUP      | Lead            | New user creation (with attribution)          |
   | TRIAL_START | Sale            | KiloClaw trial subscription becomes active    |
   | TRIAL_END   | Sale            | KiloClaw trial subscription ends (any reason) |
   | SALE        | Sale            | KiloClaw subscription invoice is paid         |

9. Each conversion event sent to Impact.com MUST include:
   - The user's affiliate tracking identifier (if available)
   - A stable customer identifier (the user's internal ID)
   - The customer's email address, SHA-1 hashed
   - An event timestamp
   - A unique order identifier (for sale events)

10. SALE events MUST include the invoice amount and currency.

11. SALE events MUST be reported for every paid KiloClaw invoice (initial purchase and renewals), not only the first.
    Impact.com determines commission eligibility based on its own contract rules.

12. SALE events MUST include the subscription plan identifier (e.g. `kiloclaw-standard`, `kiloclaw-commit`) as the item
    category.

13. Conversion events SHOULD include a promo code when one was applied to the transaction.

14. The SIGNUP event MUST only be sent for new user creation, not for returning users who sign in.

### Client-Side Tracking (UTT)

15. The system MUST load the Impact.com UTT script on all pages when the UTT identifier is configured.

16. The system MUST NOT load the UTT script when the UTT identifier is not configured.

17. After a user authenticates, the system MUST call the UTT `identify` function with the user's internal ID and SHA-1
    hashed email to enable cross-device attribution.

### Reliability and Isolation

18. Conversion reporting MUST NOT block or delay the primary operation it is attached to (user creation, subscription
    settlement, etc.). Failures in conversion reporting MUST be handled asynchronously.

19. If Impact.com credentials are not configured, all tracking operations MUST be no-ops. The application MUST function
    normally without Impact.com configuration.

20. The system SHOULD retry conversion API calls that receive a server error (5xx) response.

21. The system MUST log conversion reporting failures for observability.

### Rewardful Removal

22. The existing Rewardful integration MUST be fully removed. This includes the client-side script, server-side cookie
    reading, and any checkout session metadata populated by Rewardful.

### Checkout Metadata

23. The KiloClaw checkout session MUST include the user's affiliate tracking identifier (if any) in Stripe subscription
    metadata, so it is available to webhook handlers independently of a database lookup.

## Error Handling

1. When a conversion API call fails with a client error (4xx), the system MUST log the error and MUST NOT retry.

2. When a conversion API call fails with a server error (5xx), the system SHOULD retry with backoff.

3. When a conversion API call fails for any reason, the primary operation (user creation, invoice settlement, etc.) MUST
   NOT be affected.

4. When the affiliate tracking identifier is not available for a user (no attribution record exists), conversion events
   MUST still be sent with an empty or null click ID. Impact.com will not attribute these but may use them for
   reporting.

## Changelog

### 2026-03-31 -- Initial spec

### 2026-03-31 -- Rename SUBSCRIPTION_START to SALE

Renamed the SUBSCRIPTION_START event to SALE to reflect that it covers all KiloClaw payments (initial purchase and
renewals), not just subscription creation. Clarified that SALE events fire for every paid invoice.
