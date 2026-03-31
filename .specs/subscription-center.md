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
- **Subscription Group**: A category of subscriptions displayed as a
  visual section on the page. Current groups are Kilo Pass, KiloClaw,
  Coding Plans, and Teams/Enterprise Seats.
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
- **Price**: All prices are denominated in USD and MUST be displayed
  with a dollar sign and two decimal places (e.g. "$9.99/mo").

## Overview

The Subscription Center is a centralized page where users can see
every subscription they hold, grouped by product type: Kilo Pass,
KiloClaw, Coding Plans, and Teams/Enterprise Seats. Each group contains individual
subscription cards showing status, plan, pricing, and billing date at
a glance. Clicking a subscription card navigates to a detail page with
full management capabilities including plan changes, cancellation,
usage history, and invoice viewing.

The personal Subscription Center lives at `/subscriptions` and is
accessible from the sidebar. Organization subscriptions live at
`/organizations/[id]/subscriptions` and are restricted to billing
admins and org owners. The two routes are independent — the personal
page shows only individually-owned subscriptions; the org page shows
only org-owned subscriptions.

Subscription management UI may continue to appear in other parts of
the app (e.g. Kilo Pass cards on the profile page, billing controls
within the KiloClaw dashboard). The Subscription Center does not
replace those surfaces but serves as the canonical hub where all
subscriptions are consolidated.

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

6. The page MUST display subscriptions organized into groups by product
   type. The initial groups are:
   - **Kilo Pass** (personal route only)
   - **KiloClaw** (personal route only)
   - **Coding Plans** (personal route only)
   - **Teams/Enterprise Seats** (org route only)

7. A group MUST always appear on its respective route regardless of
   whether the user has a subscription of that type.

8. When a group contains no subscriptions in a non-terminal state, the
   system MUST display an Available Product Card with a call-to-action
   to subscribe.

9. When a group contains one or more subscriptions in a non-terminal
   state, the system MUST display a Subscription Card for each
   non-terminal subscription.

10. Subscriptions in a terminal state (Kilo Pass: `canceled`,
    `incomplete_expired`; KiloClaw: `canceled`; Coding Plans:
    `canceled`; Teams/Enterprise: `ended`) MUST be hidden by default.
    The page MUST provide a single page-level toggle that reveals or
    hides all terminal subscriptions across all groups simultaneously.

11. When revealed, terminal subscription cards MUST use a visually
    muted treatment — reduced opacity or desaturated color — and MUST
    display a status label indicating the terminal state (e.g.
    "Cancelled", "Ended").

### Subscription Cards

12. Each Subscription Card MUST display at minimum:
    - Subscription status (e.g. active, trialing, past_due, cancelled)
    - Plan or tier name
    - Next billing date (or end date for terminal subscriptions)
    - Price per billing period
    - Payment method summary (e.g. "Visa ending 4242" or "Credits")

13. Cards for subscriptions in a warning state MUST use a colored left
    border or background tint that differs from the default card style,
    using the application's existing warning/destructive color tokens.
    The system MUST NOT use badges or notification indicators in the
    navigation.

14. Each Subscription Card MUST be clickable and navigate to that
    subscription's detail page, regardless of subscription status.

15. Each subscription group MUST load independently. A failure or delay
    in loading one group MUST NOT prevent other groups from rendering.

16. While a group's data is loading, the system MUST display a
    placeholder skeleton for that group's cards.

### Kilo Pass Subscriptions (Personal Route)

17. The Kilo Pass group displays either one Subscription Card (when the
    user has a Kilo Pass subscription) or one Available Product Card
    (when they do not). The at-most-one constraint is enforced by the
    Kilo Pass billing system, not by the Subscription Center.

18. The Kilo Pass detail page MUST be served at
    `/subscriptions/kilo-pass`.

19. The Kilo Pass detail page MUST support the following management
    actions:
    - Change subscription tier
    - Change billing cadence (monthly / yearly)
    - Cancel subscription
    - Resume a subscription pending cancellation
    - View scheduled changes and cancel a pending scheduled change

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

### Coding Plans Subscriptions (Personal Route)

27. A user MAY have multiple Coding Plans subscriptions — one per
    upstream provider. The Coding Plans group MUST display one
    Subscription Card for each active coding plan subscription.

28. The Coding Plans detail page MUST be served at
    `/subscriptions/coding-plans/[subscriptionId]`.

29. Each Coding Plans detail page MUST support the following management
    actions:
    - View subscription status (active, cancelled)
    - Cancel subscription

30. Each Coding Plans detail page MUST display:
    - Provider name and status
    - Billing period and next renewal date
    - Cost in Kilo Credits per billing period
    - Payment source (Kilo Credits)
    - Traffic routing information (Kilo Gateway or direct)
    - The user's assigned API key with view and copy controls (see
      Coding Plans spec, rule 4.2.1)
    - Inline billing history showing credit transactions (see Billing
      History rules)

31. When a coding plan is cancelled or the user's credit balance is
    insufficient to renew, the system MUST remove the API key from the
    user's BYOK configuration within Kilo. The system MUST NOT revoke
    the key with the upstream provider — the key belongs to the user
    (see Coding Plans spec, rule 5.1). The cancel confirmation dialog
    MUST communicate this to the user.

32. When a group contains no active coding plans, the system MUST
    display the available provider catalog inline as Available Product
    Cards — one per upstream provider — showing the provider name,
    recurring cost in Kilo Credits, and billing period. Each card MUST
    have a subscribe action that initiates subscription creation.

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

45. When the user has no subscriptions of any type, the personal
    Subscription Center MUST display Available Product Cards for every
    group — it MUST NOT show an empty page.

### Billing History

46. Each subscription detail page MUST display an inline billing
    history section.

47. For subscriptions with Stripe-funded billing, the billing history
    MUST display invoices from Stripe: invoice date, amount, payment
    status, and a link to view or download the invoice.

48. For subscriptions funded entirely by credits (no Stripe billing),
    the billing history MUST display credit transaction history in
    place of invoices — showing date, amount, and description for each
    credit deduction.

49. The billing history MUST be scoped to the individual subscription
    being viewed — the system MUST NOT display entries from other
    subscriptions.

50. The billing history MUST be ordered by date descending (newest
    first). When there are more than 25 entries, the system MUST
    paginate or provide a "show more" mechanism.

### Payment Method Management

51. The system MUST provide a link to the Stripe customer portal from
    each subscription detail page that has Stripe-funded billing.

52. The user MUST manage payment methods through Stripe's hosted
    customer portal. The system MUST NOT build native payment method
    management UI.

### Responsiveness

53. The Subscription Center MUST be fully functional on mobile
    viewports. Subscription Cards MUST stack vertically on narrow
    screens.

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
   initial four. The group-based layout SHOULD accommodate new product
   types without structural changes to the page.

2. The system SHOULD support multiple KiloClaw instances per user,
   each with independent billing. (Currently the schema supports this
   but the UI has not been built.)

3. The system SHOULD surface upcoming renewals or billing events on
   the landing page (e.g. "renews in 3 days") to help users
   anticipate charges.

4. The system SHOULD allow org members (non-billing-admins) to view a
   read-only version of the organization Subscription Center showing
   the current plan and seat count without management actions.

## Changelog

### 2026-03-31 -- Initial spec

- Created from codebase analysis of existing Kilo Pass, KiloClaw,
  Coding Plans, and Teams/Enterprise Seats subscription systems.
