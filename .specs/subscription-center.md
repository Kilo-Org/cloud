# Subscription Center

## Role of This Document

This spec defines the business rules and invariants for the
Subscription Center. It is the source of truth for _what_ the system
must guarantee — valid states, ownership boundaries, correctness
properties, and user-facing behavior. It deliberately does not
prescribe _how_ to implement those guarantees: handler names, column
layouts, conflict-resolution strategies, and other implementation
choices belong in plan documents and code, not here.

## Status

Draft -- created 2026-03-31.
Updated 2026-05-12 -- KiloClaw price-version display behavior.
Updated 2026-05-26 -- Coding Plans managed-credential and catalog behavior.
Updated 2026-05-27 -- Coding Plans ordinary MiniMax BYOK setup and billing separation.
Updated 2026-05-27 -- Coding Plans manual MiniMax revocation handling.
Updated 2026-05-27 -- Token Plan Plus pilot operations and UI behavior.
Updated 2026-05-28 -- Personal product navigation and return context.
Updated 2026-05-28 -- USD price display independent of payment source.
Updated 2026-05-28 -- Coding Plans sold-out availability notification intent.
Updated 2026-05-28 -- Credit-funded payment source label.
Updated 2026-05-28 -- Coding Plans API key configuration summary.
Updated 2026-05-28 -- Coding Plans billing history USD amount display.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Subscription Center**: A unified page where users view and manage
  all of their subscriptions in one place. It exists at both a personal
  and organizational level.
- **Subscription Group**: A product category within the Subscription
  Center. Current groups are Kilo Pass, KiloClaw, Coding Plans, and
  Teams/Enterprise Seats.
- **Subscription Card**: A summary element within a group that
  represents a single subscription instance and its current state.
- **Available Product Card**: A card shown within a subscription group
  when the user has no non-terminal subscription of that type,
  presenting a call-to-action to subscribe.
- **Detail Page**: A dedicated sub-page for a single subscription
  instance, providing full management capabilities and billing history.
- **Billing Admin**: An organization member with the `billing_manager`
  role. Throughout this spec, "billing admin" refers to this role.
- **Terminal state**: A subscription status that indicates the
  subscription is definitively over and cannot be recovered without
  creating a new subscription. Terminal statuses are: Kilo Pass —
  `canceled`, `incomplete_expired`; KiloClaw — `canceled`; Coding
  Plans — `canceled`; Teams/Enterprise — `ended`.
- **Non-terminal state**: Any subscription status that is not a
  terminal state. This includes active, trialing, past-due, unpaid,
  incomplete, paused, and suspended states. A subscription in a
  non-terminal state still represents an ongoing relationship between
  the user and the product.
- **Warning state**: A subscription requires attention when any of
  the following is true: (a) its status is past-due, unpaid, or
  suspended; (b) it is marked for cancellation at the end of the
  current period; (c) it is trialing and the trial end date is
  approaching. The exact threshold for "approaching" is an
  implementation choice that MAY vary by subscription type.
- **Price**: Prices MUST be displayed in USD regardless of payment
  source. Price labels MUST use a dollar sign and billing cadence (e.g.
  "$20 /month"). Credit-funded products MUST display "Credits" as their
  payment source separately from their USD price.

## Overview

The Subscription Center is a centralized page where users manage
subscriptions by product type: Kilo Pass, KiloClaw, Coding Plans, and
Teams/Enterprise Seats. The personal route provides access to each
personal product while preserving product context when users return from
its detail page. Each visible group contains subscription cards showing
status, plan, pricing, and billing date at a glance. Clicking a
subscription card navigates to a detail page with management capabilities
including plan changes, cancellation, usage history, and invoice viewing.

The personal Subscription Center lives at `/subscriptions` and is
accessible from the sidebar. Organization subscriptions live at
`/organizations/[id]/subscriptions` and are restricted to billing
admins and org owners. The two routes are independent — the personal
page shows only individually-owned subscriptions; the org page shows
only org-owned subscriptions.

Subscription management UI may continue to appear in other parts of
the app (e.g. Kilo Pass cards on the profile page, billing controls
within the KiloClaw dashboard). The Subscription Center does not
replace those surfaces but is the canonical hub for moving between and
managing each subscription product.

These routes form a stable URL contract. If any path changes in the
future, the system MUST redirect from the old path to the new one.

## Rules

### Routes and Navigation

1. The system MUST serve the personal Subscription Center at the route
   `/subscriptions`.

2. The system MUST serve the organization Subscription Center at the
   route `/organizations/[id]/subscriptions`.

3. The personal Subscription Center MUST appear as the topmost item
   under the "Account" section in the application sidebar.

4. The `/subscriptions` route MUST require authentication. Unauthenticated
   users MUST be redirected to the sign-in flow.

5. The `/organizations/[id]/subscriptions` route MUST require that the
   current user is the org owner or a billing admin of that
   organization. Users without sufficient permissions MUST NOT see the
   route in navigation and MUST receive an authorization error if they
   access the route directly.

### Subscription Groups

6. The page MUST organize subscriptions into groups by product type. The
   initial groups are:
   - **Kilo Pass** (personal route only)
   - **KiloClaw** (personal route only)
   - **Coding Plans** (personal route only)
   - **Teams/Enterprise Seats** (org route only)

7. The personal route MUST provide access to each personal Subscription
   Group regardless of whether the user has a subscription of that type.
   The route MAY show only one group's content at a time. Returning from a
   personal subscription detail page MUST restore the user's product
   context.

8. When a user views a group with no subscriptions in a non-terminal
   state, the system MUST display an Available Product Card with a
   call-to-action to subscribe.

9. When a user views a group with one or more subscriptions in a
   non-terminal state, the system MUST display a Subscription Card for
   each non-terminal subscription.

10. Subscriptions in a terminal state (Kilo Pass: `canceled`,
    `incomplete_expired`; KiloClaw: `canceled`; Coding Plans:
    `canceled`; Teams/Enterprise: `ended`) MUST be hidden by default.
    Users MUST be able to reveal terminal subscriptions for each
    applicable product.

11. When revealed, terminal subscriptions MUST be clearly distinguished
    from non-terminal subscriptions and MUST display their terminal
    status (e.g. "Cancelled", "Ended").

### Subscription Cards

12. Each Subscription Card MUST display at minimum:
    - Subscription status (e.g. active, trialing, past_due, cancelled)
    - Plan or tier name
    - Next billing date (or end date for terminal subscriptions)
    - Price per billing period
    - Payment method summary (e.g. "Visa ending 4242" or "Credits")

13. Cards for subscriptions in a warning state MUST communicate
    prominently and accessibly that the subscription requires attention.

14. Each Subscription Card MUST be clickable and navigate to that
    subscription's detail page, regardless of subscription status.

15. Each subscription group MUST load independently. A failure or delay
    in one group MUST NOT prevent the user from viewing another group.

16. While the requested group's data is loading, the system MUST provide
    visible loading feedback for that group.

### Kilo Pass Subscriptions (Personal Route)

17. The Kilo Pass group displays either one Subscription Card (when the
    user has a Kilo Pass subscription) or one Available Product Card
    (when they do not). The at-most-one constraint is enforced by the
    Kilo Pass billing system, not by the Subscription Center.

18. The Kilo Pass detail page MUST be served at
    `/subscriptions/kilo-pass`.

19. The Kilo Pass detail page MUST support the following management
    actions, using the same canonical Kilo Pass management flows as
    other Kilo Pass surfaces:
    - Change subscription tier
    - Change billing cadence (monthly / yearly)
    - Cancel subscription through the canonical cancellation flow
    - Resume a subscription pending cancellation
    - View scheduled changes and cancel a pending scheduled change

    Cancellation flow completion MUST be explicit: abandoning or
    dismissing the flow MUST NOT schedule cancellation. If the canonical
    flow is unavailable, the system MAY fall back to direct cancellation
    confirmation before scheduling cancellation.

20. The Kilo Pass detail page MUST display:
    - Current tier and cadence
    - Current billing period and next billing date
    - Credit issuance history (base, bonus, promo line items)
    - Bonus credit progression and current streak
    - Inline billing history for this subscription (see Billing
      History rules)
    - Link to the Stripe customer portal for payment method management

### KiloClaw Subscriptions (Personal Route)

21. A user MAY have multiple KiloClaw subscriptions — one per KiloClaw
    instance. The KiloClaw group MUST display one Subscription Card for
    each instance that has an associated subscription.

22. KiloClaw instances that have no associated subscription record
    (e.g. destroyed instances with no billing relationship) MUST NOT
    appear in the KiloClaw group.

23. KiloClaw instances with a non-null organization identifier MUST NOT
    appear on the personal `/subscriptions` route. They are managed
    through the organization's context.

24. KiloClaw instance detail pages MUST be served at
    `/subscriptions/kiloclaw/[instanceId]`.

25. Each KiloClaw detail page MUST support the following management
    actions:
    - View subscription status (active, trialing, past_due, suspended,
      cancelled)
    - Switch between hosting plans (standard / commit)
    - Cancel subscription
    - Switch payment source (Stripe / credits) where applicable

26. Each KiloClaw detail page MUST display:
    - Instance identifier and status
    - Current plan and billing period
    - Payment source
    - Trial status and expiration date (if trialing)
    - Suspension/destruction deadlines (if applicable)
    - Inline billing history for this instance's subscription (see
      Billing History rules)
    - Link to the Stripe customer portal for payment method management
      (if Stripe-funded)

KiloClaw summary and detail views MUST display the pricing applicable
to the subscription, including subscriptions enrolled under earlier
pricing. Scheduled or requested plan changes MUST display pricing that
will apply if the change completes.

When the user has no non-terminal KiloClaw subscription, the enrollment
view MUST display the currently available offer and price. Canceled
KiloClaw history MUST NOT cause an earlier price or entitlement to
appear as the available offer. Stripe-funded enrollment awaiting invoice
settlement MUST be presented as pending rather than active.

### Coding Plans Subscriptions (Personal Route)

27. A user MAY have multiple Coding Plans subscriptions — one per
    configured Plan ID. The Coding Plans group MUST display one
    Subscription Card for each non-terminal coding plan subscription,
    including a `past_due` subscription in its warning state.

28. The Coding Plans detail page MUST be served at
    `/subscriptions/coding-plans/[subscriptionId]`.

29. Each Coding Plans detail page MUST support the following management
    actions:
    - View subscription status (`active`, `past_due`, or `canceled`)
    - Cancel an active subscription at the end of its paid period

30. Each Coding Plans detail page MUST display:
    - Provider name, plan name, and status
    - Billing period and next renewal date, paid-through date, or grace
      deadline as appropriate for its status; a grace deadline MUST include
      local date and time
    - Price in USD per billing period
    - Payment source (Credits)
    - API Key Configuration summary identifying configuration in BYOK and
      linking to `/byok` when a managed key is installed
    - Traffic routing information (Kilo Gateway through the ordinary
      MiniMax BYOK provider setup)
    - Inline billing history showing credit transactions with amounts in USD
      (see Billing History rules)

    Before update, disable, or delete, `/byok` MUST warn that routing changes
    do not cancel or pause Token Plan Plus billing and cancellation is managed
    in Subscription Center; customer surfaces MUST NOT include saved raw-key
    view or copy controls.

31. Coding Plan cancellation, installed MiniMax configuration cleanup,
    and issued-credential revocation MUST follow `.specs/coding-plans.md`.
    Cancellation messaging MUST communicate the paid-through date, that
    only Kilo's unchanged installed configuration is removed, and that
    Kilo revokes its issued credential when plan access ends.

32. When the user views Coding Plans with no non-terminal subscription,
    the system MUST show each configured offering with provider name,
    plan name, recurring USD price, billing period, and payment source.
    An offering with assignable credential capacity MUST show a subscribe
    action. For MiniMax Token Plan Plus, purchase messaging MUST explain
    automatic MiniMax BYOK setup and purchase MUST be blocked when any
    personal MiniMax BYOK key exists, including a disabled key. In that
    state, the system MUST direct the user to delete the existing key in
    `/byok` first. An offering without assignable credential capacity MUST
    display a sold-out state and a `Notify me when available` action. The
    action MUST persist one notification intent per user and Plan ID without
    charging credits or reserving inventory, and the surface MUST indicate
    once that intent has been saved.

### Teams/Enterprise Seats Subscriptions (Org Route)

33. The organization Subscription Center MUST display the
    Teams/Enterprise Seats group.

34. An organization has at most one active or pending-cancel seats
    purchase at a time. The Teams/Enterprise Seats detail page MUST
    display the most recent non-ended purchase. Past ended records are
    visible only through billing history.

35. The Teams/Enterprise Seats detail page MUST be served at
    `/organizations/[id]/subscriptions/seats`.

36. The Teams/Enterprise Seats detail page MUST support the following
    management actions:
    - View current plan (teams / enterprise) and seat count
    - Change seat count
    - Change billing cycle (monthly / yearly)
    - Cancel subscription
    - Resume a subscription pending cancellation

37. The Teams/Enterprise Seats detail page MUST display:
    - Current plan and billing cycle
    - Seat count and seat utilization
    - Price per billing period
    - Next billing date
    - Inline billing history for this subscription (see Billing
      History rules)
    - Link to the Stripe customer portal for payment method management

### Authorization

38. The personal `/subscriptions` route and its sub-pages MUST only
    display subscriptions owned by the authenticated user.

39. A user MUST NOT be able to view or manage another user's personal
    subscriptions.

40. The organization `/organizations/[id]/subscriptions` route MUST
    only be accessible to the organization owner or a billing admin.

41. Organization members who are not owners or billing admins MUST NOT
    see the organization Subscription Center in navigation and MUST
    receive a 403 error if accessing the route directly.

### Available Product Cards

42. An Available Product Card MUST communicate what the product is and
    provide a clear call-to-action to start a subscription.

43. Clicking the call-to-action on an Available Product Card MUST
    initiate the appropriate subscription checkout flow for that
    product type.

44. Until a checkout flow results in a confirmed subscription, the
    group's displayed state MUST NOT change. An abandoned or failed
    checkout MUST NOT alter what the page displays.

45. When the user has no subscriptions of any type, each personal
    product MUST remain accessible and MUST present its subscribe
    opportunity when viewed; the visible product view MUST NOT be empty.

### Billing History

46. Each subscription detail page MUST display an inline billing
    history section.

47. For subscriptions with Stripe-funded billing, the billing history
    MUST display invoices from Stripe: invoice date, amount, payment
    status, and a link to view or download the invoice.

48. For subscriptions funded entirely by credits (no Stripe billing),
    the billing history MUST display credit transaction history in
    place of invoices, showing date, USD-denominated amount, and description
    for each credit deduction.

49. The billing history MUST be scoped to the individual subscription
    being viewed — the system MUST NOT display entries from other
    subscriptions.

50. The billing history MUST be ordered by date descending (newest
    first). Users MUST be able to access additional entries when the
    complete history is not shown initially.

### Payment Method Management

51. The system MUST provide a link to the Stripe customer portal from
    each subscription detail page that has Stripe-funded billing.

52. The user MUST manage payment methods through Stripe's hosted
    customer portal. The system MUST NOT build native payment method
    management UI.

### Responsiveness

53. The Subscription Center MUST be fully functional on mobile
    viewports without hiding subscription information or management
    actions required by this spec.

54. All management actions on detail pages MUST be accessible and
    usable on mobile viewports.

## Error Handling

1. When subscription data fails to load for a group, the system MUST
   display an error state within that group with a retry action. Other
   groups MUST continue to function normally.

2. When a management action fails (e.g. cancellation, plan change),
   the system MUST display an error message describing the failure and
   MUST NOT leave the subscription in an inconsistent visual state.

3. When an unauthorized user attempts to access an organization
   Subscription Center, the system MUST return an authorization error
   and MUST NOT reveal any subscription data.

4. When a user navigates to a subscription detail page for a
   subscription that does not exist or that they do not own, the
   system MUST display a not-found error.

5. When the Stripe customer portal link cannot be generated, the
   system MUST display an error message and MUST NOT silently fail.

## Not Yet Implemented

The following rules use SHOULD and reflect intended behavior that is
not yet enforced in the current codebase:

1. The system SHOULD support additional subscription types beyond the
   initial four without disrupting access to existing products.

2. The system SHOULD surface upcoming renewals or billing events on
   the landing page (e.g. "renews in 3 days") to help users
   anticipate charges.

3. The system SHOULD allow org members (non-billing-admins) to view a
   read-only version of the organization Subscription Center showing
   the current plan and seat count without management actions.

## Changelog

### 2026-05-28 -- Personal product navigation and return context

- Defined access to each personal product and restoration of product context after detail-page navigation.
- Kept independent loading, terminal history, and available-product behavior within each product view.

### 2026-05-27 -- Token Plan Plus pilot operations and UI behavior

- Accepted billing-sweep local cleanup timing for the pilot and defined admin-console manual credential revocation.
- Added admin-only explicit key reveal, validate-on-upload inventory, mutation-time BYOK warnings, no prepaid extensions, and local-time grace display.
- Dropped Coding Plans admin-action audit history for the initial pilot while retaining secret-handling restrictions and inventory disposition state.

### 2026-05-27 -- Coding Plans manual MiniMax revocation handling

- Recorded manual provider revocation as the initial MiniMax operational workflow.
- Kept local cleanup separate from upstream revocation processing by authorized support.

### 2026-05-27 -- Coding Plans ordinary MiniMax BYOK setup

- Replaced read-only managed-key behavior with automatic ordinary MiniMax BYOK setup and normal key management.
- Defined occupied-MiniMax purchase blocking, billing separation, and conditional installed-key cleanup.

### 2026-05-12 -- KiloClaw price-version display behavior

- Added KiloClaw Subscription Card, detail, plan-switch, and Available
  Product Card display rules for price-versioned billing.
- Removed stale not-yet-implemented text for multiple personal
  KiloClaw subscriptions now covered by KiloClaw group behavior.

### 2026-04-10 -- Kilo Pass cancellation flow

- Clarified that the Subscription Center uses the canonical Kilo Pass
  cancellation flow and leaves subscriptions unchanged when that flow is
  dismissed.

### 2026-03-31 -- Initial spec

- Created from codebase analysis of existing Kilo Pass, KiloClaw,
  Coding Plans, and Teams/Enterprise Seats subscription systems.
