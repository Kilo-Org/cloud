# Team and Enterprise Seat Billing

## Role of This Document

This spec defines the business rules and invariants for Team and
Enterprise seat billing. It is the source of truth for _what_ the
system must guarantee — valid states, pricing, seat counting,
subscription lifecycle, and user-facing behavior. It deliberately
does not prescribe _how_ to implement those guarantees: handler
names, column layouts, Stripe API call patterns, and other
implementation choices belong in plan documents and code, not here.

## Status

Active.

- Reverse-engineered from existing code on 2026-03-26.
- Updated 2026-03-26 to add monthly billing cycle option.
- Updated 2026-03-28 to document billing cycle change hardening.
- Updated 2026-03-28/29 with spec audit fixes, definitions, and billing compliance implementation.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

All monetary amounts in this spec are in USD. The system currently
supports only USD for seat billing.

## Definitions

- **Active member**: A user who has a current organization
  membership record and is not a bot user. This is the set of
  users counted toward seat usage (after excluding billing
  managers).
- **Seat**: A unit of access purchased by an organization. Each
  active member (except billing managers) and each pending invitation
  (except for the billing manager role) consumes one seat.
- **Billing cycle**: The recurrence interval for a subscription —
  either monthly or annual.
- **Billing period**: A single interval within a billing cycle (one
  month for monthly, one year for annual). Renewal and proration
  boundaries align to billing period edges.
- **Purchase record**: A persistent record of a subscription event,
  containing: subscription ID, organization ID, seat count, amount,
  start date, expiration date, idempotency key, and status.
- **Billing manager**: An organization role that grants access to
  billing operations (checkout, cancellation, seat changes, portal)
  without consuming a seat.
- **Seat usage**: The count of active members plus qualifying pending
  invitations, excluding billing managers and expired/accepted
  invitations.
- **Non-ended subscription**: A subscription for which the payment
  processor has not set a termination timestamp. All subscription
  statuses other than canceled and incomplete-expired are non-ended.
- **Active subscription**: A subscription whose payment processor
  status is specifically `active`. Distinguished from "non-ended
  subscription," which includes additional statuses such as
  past-due or incomplete.
- **Active subscription purchase**: A purchase record whose
  `subscription_status` is not `ended`. Used for access checks and
  trial enforcement — an organization with at least one active
  subscription purchase is considered subscribed.
- **Known paid seat prices**: The set of payment processor price
  identifiers corresponding to the four seat pricing tiers (Teams
  monthly, Teams annual, Enterprise monthly, Enterprise annual).
  This set is maintained in configuration and MUST be updated
  whenever pricing tiers are added or removed.
- **Free-seat line item**: A subscription line item whose price is
  not one of the known paid seat prices. These represent
  promotional or complimentary seats and are excluded when
  determining the resubscribe quantity.
- **Seat metadata**: A subscription line item is considered a seat
  line item when the associated subscription's metadata `type`
  field equals `seats`, or when the line item's price ID is one of
  the known paid seat prices.
- **Self-service creation flow**: The user-initiated flow for
  creating a new organization through the standard web UI, as
  opposed to administrative creation (admin panel, scripts, or
  API).
- **Require-seats flag**: A per-organization boolean that, when
  false, bypasses all trial and subscription enforcement — used for
  design partners, internal testing, and enterprise contracts.
- **Subscription event**: A notification about a subscription state
  change, originating either from the payment processor (via
  webhook) or recorded locally after a direct API call (see
  Subscription Lifecycle rules 7-8). Both sources produce the same
  processing flow.
- **Subscription metadata user**: The user identified by the
  `kiloUserId` field in the payment processor subscription's
  metadata object. This is typically the user who initiated the
  checkout.
- **Subscription metadata type**: A string field in the payment
  processor subscription metadata that identifies the subscription
  category (e.g., `seats`). Used to dispatch subscription events
  to the appropriate handler.
- **Bot user**: A system or service account (flagged `is_bot` in
  the user record) that is excluded from seat counting and
  organization member lists.
- **OSS sponsorship program**: An organization-level enrollment
  (indicated by a non-null `oss_sponsorship_tier` setting) managed
  through an administrative workflow. Participating organizations
  are exempt from trial expiration.
- **Suppressed trial messaging**: An organization setting
  (`suppress_trial_messaging`) that, when enabled, treats the
  organization as if it has an active subscription for trial
  enforcement purposes.
- **Trial stages**: Progressive classifications of an
  organization's trial status based on the floored `daysRemaining`
  value (see Free Trial rule 3):
  - **Active**: `daysRemaining >= 8`
  - **Ending soon**: `daysRemaining` 4 through 7 (inclusive)
  - **Ending very soon**: `daysRemaining` 1 through 3 (inclusive)
  - **Expires today**: `daysRemaining == 0`
  - **Soft-expired**: `daysRemaining` −1 through −3 (inclusive)
  - **Hard-expired**: `daysRemaining <= −4`

## Overview

Organizations purchase seats through recurring subscriptions to grant
their members access to the platform. Two plan tiers exist -- Teams
and Enterprise -- each with distinct per-seat pricing. Both monthly
and annual billing cycles are available for each tier, with annual
billing discounted to 10 months' worth of the monthly rate (12 months
for the price of 10). All self-service signups begin on the Enterprise
plan with a 14-day free trial; users choose their plan tier (Teams or
Enterprise) and billing cycle (monthly or annual) when converting to a
paid subscription. Seat counts are tracked per organization and
enforced against active members and pending invitations. Organizations
without an active subscription operate under a time-limited free trial
with escalating restrictions: informational banners, then a
dismissible read-only lock, then a non-dismissible hard lock that
blocks all server-side mutations. A "billing manager" role exists that
grants billing access without consuming a seat.

## Rules

### Organization Plans

1. The system MUST support exactly two plan types: Teams and
   Enterprise.
2. The system MUST default the organization plan to Teams at the
   data layer when no plan is explicitly provided by the creation
   flow. (Self-service creation always provides Enterprise; see
   rule 3.)
3. The self-service creation flow MUST create all new organizations
   on the Enterprise plan with a 14-day free trial.
4. The user MUST NOT be offered a choice of plan or billing cycle
   during trial creation; plan tier and billing cycle selection
   occurs only when converting to a paid subscription.
5. When processing any subscription event (whether from a webhook
   or a local API call), the system MUST update the organization's
   plan type if the subscription metadata includes a valid plan
   type value.
6. The system MUST NOT change the organization's plan type when the
   subscription metadata omits the plan type field.
7. The system MUST silently ignore (log and discard) invalid plan
   type values in subscription metadata.
8. When an organization transitions from Enterprise to Teams, the
   system MUST persist Enterprise-only settings (e.g., model deny
   lists, provider deny lists) in storage, MUST exclude them from
   enforcement logic, and MUST NOT expose them in the organization
   settings UI while the plan is Teams.
9. If the organization later transitions back to Enterprise, the
   system MUST reactivate the previously stored Enterprise-only
   settings without requiring reconfiguration.

### Seat Pricing

1. The system MUST price Teams seats at $18 per seat per month on
   the monthly billing cycle.
2. The system MUST price Teams seats at $180 per seat per year on
   the annual billing cycle (equivalent to $15 per seat per month).
3. The system MUST price Enterprise seats at $72 per seat per month
   on the monthly billing cycle.
4. The system MUST price Enterprise seats at $720 per seat per year
   on the annual billing cycle (equivalent to $60 per seat per
   month).
5. Annual pricing MUST equal 10 times the monthly rate for each
   plan tier (12 months for the price of 10).
6. Both monthly and annual billing cycles MUST be available for
   both plan tiers.

### Seat Purchase and Checkout

1. The system MUST allow purchasing between 1 and 100 seats
   (inclusive) per checkout.
2. The system MUST require the user to select a billing cycle
   (monthly or annual) during checkout.
3. The system MUST use the billing-cycle-specific price for the
   selected plan tier when creating the checkout session.
4. The system MUST require a payment processor customer record for
   the organization before creating a checkout session.
5. The system MUST lazily create the payment processor customer
   record when one does not yet exist.
6. The system MUST NOT allow creating a second subscription if the
   organization already has a non-ended subscription. Seat changes
   on an existing subscription MUST use the mid-subscription
   modification flow defined in the Seat Count Modification section.
7. The system MUST record each subscription event as a seat purchase
   record with: subscription ID, organization ID, seat count, amount
   in USD, start date, expiration date, idempotency key, and
   subscription status. The amount MUST reflect the actual
   cycle-specific price charged.
8. When resubscribing after an ended subscription, the system MUST
   use only the paid seat quantity from the most recently ended
   subscription (by termination timestamp), excluding free-seat
   line items, as the checkout quantity.
9. The system MUST require billing address collection during
   checkout.

### Seat Usage Counting

1. The system MUST count each active organization member toward
   seat usage, except members with the billing manager role.
2. The system MUST count each pending invitation toward seat usage,
   except invitations for the billing manager role.
3. The system MUST NOT count expired invitations toward seat usage.
4. The system MUST NOT count accepted invitations toward seat usage
   (accepted invitees are counted as active members instead).
5. The system MUST NOT count bot users (see Definitions) toward
   seat usage.
6. The system MUST report seat usage as a pair: seats used (members
   plus qualifying pending invitations) and total seats purchased.
7. The system MUST allow seat usage to exceed total purchased seats
   (no hard block on over-usage at the counting layer).
8. For Teams-plan organizations, the system MUST disable the
   invitation UI when seat usage equals or exceeds the purchased
   seat count.
9. For Enterprise-plan organizations, the system MUST NOT restrict
   invitations based on seat usage.
10. The server MUST NOT enforce seat limits when processing
    invitations or when members accept invitations; seat-limit
    enforcement on invitations is a UI-layer-only control.
11. When a billing period begins with a lower seat count than
    current usage (e.g., an end-of-period downgrade takes effect),
    the system MUST NOT remove existing members. The over-usage
    state persists until resolved by the organization (by removing
    members or purchasing additional seats). The system SHOULD
    display a warning to organization owners indicating over-usage.

### Seat Count Updates from Subscription Events

1. The system MUST update the organization's seat count when
   processing an active subscription event.
2. The organization's effective seat count MUST equal the highest
   seat count among all purchase records that share the most recent
   billing-period start date for that organization.
3. The system MUST apply seat upgrades (higher count with a more
   recent start date) within the same transaction that records
   the purchase.
4. The system MUST NOT apply seat downgrades within the same billing
   period; the current higher seat count MUST be retained until a
   new billing period begins.
5. The system MUST apply seat downgrades when a subscription event
   arrives with a more recent start date (new billing period).
6. The system MUST handle out-of-order subscription events correctly
   by always resolving to the seat count from the most recent start
   date, regardless of processing order.
7. The system MUST set the organization's seat count to zero when
   the subscription has ended.
8. The system MUST NOT update the organization's seat count for
   subscriptions in non-active statuses (e.g., incomplete, past
   due); the purchase record MUST still be created.
9. The system MUST sum quantities across all line items in a
   subscription to compute the total seat count (to support
   subscriptions with multiple price tiers). Currently, seat
   subscriptions contain only seat-type line items (paid and
   free); if non-seat line items are introduced in the future,
   the counting logic MUST be updated to filter by seat-type
   items only.
10. The system MUST record the subscription amount as the gross total
    (list-price unit amount times quantity) across all line items.
    This value does not reflect discounts, promotion codes, or
    coupons.
11. The system SHOULD record the net amount actually charged (after
    discounts) rather than the gross list price. This is SHOULD
    rather than MUST because the current payment processor API does
    not expose a reliable net amount at event time; once available,
    this SHOULD be upgraded to MUST. (Not yet implemented.)
12. When a subscription event's recurring interval is not recognized
    as monthly or annual, the system MUST default the billing cycle
    to monthly and log a warning.

### Idempotency

1. The system MUST use an idempotency key per subscription event to
   prevent duplicate processing.
2. The system MUST auto-generate an idempotency key when one is not
   provided.
3. The system MUST silently skip subscription events whose
   idempotency key already exists.
4. The system MUST produce exactly one purchase record even when
   multiple concurrent calls use the same idempotency key.

### Subscription Lifecycle

1. The system MUST ensure the subscription metadata user is a
   member of the organization when processing any subscription
   event, subject to the removal check in rule 2. If the user has
   never been a member of the organization, the system MUST add
   them as owner. If the user already has a membership in any role,
   the system MUST preserve their current role. If the metadata
   user ID does not resolve to a valid user record, the membership
   step silently fails (no membership is created) but the
   subscription event continues to be processed normally — the
   purchase record is still created and seat counts are still
   updated. The membership-ensure step MAY execute outside the
   purchase-recording transaction; if it succeeds but the purchase
   recording subsequently fails, the membership MUST NOT be rolled
   back — the user retains their membership.
2. The system MUST NOT re-add a subscription metadata user who was
   previously removed from the organization. This rule takes
   precedence over rule 1: a removed user is not treated as "never
   been a member." The system MUST be able to distinguish between a
   user who has never been a member and a user who was removed.
   (Not yet implemented — currently, if the metadata user was
   removed from the organization and a subsequent webhook fires,
   they are re-added as owner.)
3. The system MUST cancel subscriptions at the end of the current
   billing period (not immediately).
4. When cancelling a subscription that has a pending billing cycle
   change schedule, the system MUST release the schedule before or
   as part of the cancellation to prevent orphaned schedules.
5. The system MUST allow a pending cancellation to be reversed
   (stop cancellation), restoring the subscription to active.
6. When resubscribing after an ended subscription, the system MUST
   preserve the previous billing cycle (monthly or annual) as the
   default for the new checkout session.
7. The system MUST record subscription changes to the system's
   persistent state synchronously — before returning a response to
   the caller — after making payment processor API calls. The
   system MUST NOT depend solely on asynchronous webhook delivery
   for state consistency.
8. The system MUST also process incoming webhook events for
   subscription creation, update, and deletion.
9. The system MUST dispatch the subscription event to the correct
   handler based on the subscription metadata type field (see
   Definitions). Events with unrecognized type values MUST be
   logged and discarded.
10. The system MUST NOT allow deletion of an organization while a
    non-ended subscription exists. The subscription MUST be
    cancelled (and reach ended state) before organization deletion
    can proceed.

### Seat Count Modification (Mid-Subscription)

1. The system MUST allow only organization owners and billing
   managers to modify the seat count on an active subscription.
2. The system MUST reject seat downgrades when the requested count
   is less than the number of seats currently in use.
3. The system MUST apply prorated billing (immediate invoice) when
   increasing seats.
4. The system MUST NOT prorate when decreasing seats; the decrease
   takes effect at the end of the billing cycle. This applies to
   both monthly and yearly billing cycles.
5. The system MUST support payment authentication challenges (e.g.,
   3D Secure) for seat increases that require additional
   verification, returning a client secret for frontend handling.
6. The system MUST validate that the new seat count is a positive
   integer.
7. The system MUST NOT impose an upper limit on seat count for
   mid-subscription modifications. The 100-seat limit in Seat
   Purchase rule 1 applies only to the initial checkout flow.
8. The system MUST serialize concurrent seat count modifications
   for the same subscription to prevent conflicting payment
   processor updates.

### Billing Cycle Changes

1. The system MUST allow an organization to request a billing cycle
   change (monthly to annual, or annual to monthly) on an active
   subscription. If two concurrent requests both pass the
   existing-schedule check, the second MUST fail rather than create
   a duplicate schedule.
2. A billing cycle change MUST take effect at the next renewal date;
   it MUST NOT be applied immediately.
3. The system MUST NOT prorate or issue immediate charges or credits
   for a billing cycle change request.
4. The system MUST restrict billing cycle change requests to
   organization owners and billing managers.
5. When a billing cycle change takes effect at renewal, the system
   MUST use the new cycle's price for the next billing period.
6. The system MUST allow cancellation of a pending billing cycle
   change, restoring the subscription to its original cycle.
7. The system MUST preserve all subscription line items when
   scheduling a billing cycle change; only the paid seat price
   MUST change, other items (e.g., free seats) MUST be carried
   forward unchanged.
8. The system MUST preserve subscription-level discounts (promotion
   codes, coupons) when scheduling a billing cycle change. Both the
   current-period phase and the new-cycle phase MUST retain the
   active discounts.
9. If the schedule phase update fails after the schedule has been
   created, the system MUST release the orphaned schedule so the
   subscription is not permanently blocked from future cycle
   changes.
10. The system MUST determine the subscription's plan tier from the
    live payment processor price, not from the organization's
    database plan field, to prevent billing the wrong tier when
    the two diverge.
11. The system MUST verify that a schedule was created by the
    billing cycle change flow before allowing cancellation, to
    avoid releasing unrelated schedules.

### Subscription Access Control

1. The system MUST restrict subscription creation, cancellation,
   stop-cancellation, seat count changes, and billing portal access
   to organization owners and billing managers.
2. The system MUST allow any organization member to view the current
   subscription status and seat usage.
3. The system MUST reject requests from non-members with an access
   denied error.
4. The system MUST reject requests from members who are neither
   owners nor billing managers with a role-based authorization
   error.

### Require-Seats Flag and Subscription Enforcement

1. The system MUST treat organizations with the require-seats flag
   set to false as having an active subscription for all access
   checks (bypassing trial and subscription requirements).
2. The system MUST set the require-seats flag to true for all new
   organization signups, including enterprise trials.
3. The system MUST allow platform administrators (users with the
   site-wide admin role) to manually set the require-seats flag to
   false for any organization at the administrator's discretion,
   including design partners, internal testing, and enterprise
   contracts.
4. The system MUST classify an organization's status as "active"
   when it either has require-seats disabled OR has an active
   subscription purchase.
5. The system MUST classify an organization's status as "incomplete"
   when it has require-seats enabled AND has no active subscription.

### Free Trial

1. The system MUST place organizations without an active
   subscription into a free trial period.
2. The system MUST compute trial expiration from an explicit end
   date when set, or fall back to the organization creation date
   plus a configurable number of days (default: 14).
3. The system MUST compute days remaining by flooring the
   fractional difference between the expiration timestamp and the
   current time (i.e., rounding toward negative infinity, using
   `floor` semantics — not truncation toward zero). The system
   MUST classify trial status into the progressive trial stages
   defined in the Definitions section.
4. During active, ending-soon, ending-very-soon, and expires-today
   stages, the system MUST allow full functionality and MUST display
   an informational banner. The banner MUST use informational
   styling during the active stage, warning styling during the
   ending-soon stage, and critical styling during the
   ending-very-soon and expires-today stages.
5. During the soft-expired stage, the system MUST display a
   dismissible blocking dialog. If the user dismisses it, the
   system MUST present the interface in a read-only state with
   interactive controls disabled.
6. The soft-expired read-only restriction MUST be enforced at the
   UI layer only; the server MUST NOT block mutations during the
   soft-expired stage.
7. During the hard-expired stage, the system MUST display a
   non-dismissible blocking dialog. The user's only options MUST be
   to upgrade or switch to a personal profile.
8. The system MUST evaluate trial expiration status on every
   mutation request and MUST block server-side mutations with a
   forbidden error when the trial is currently hard-expired and no
   active subscription exists.
9. The system MUST exempt organizations participating in the OSS
   sponsorship program (see Definitions) from trial expiration
   (never hard-locked).
10. The system MUST exempt organizations with suppressed trial
    messaging (see Definitions) from trial expiration (treated as
    subscribed).

### Payment Processor Customer Management

1. The system MUST create at most one payment processor customer
   per organization.
2. The system MUST reuse an existing payment processor customer ID
   when one is already stored.
3. The system MUST handle race conditions during customer creation:
   if another process sets the customer ID between the initial check
   and the update, the creation MUST fail rather than overwrite.
4. The system MUST store the organization ID in the payment
   processor customer's metadata.

### Invoices

1. The system MUST classify organization invoices as "seats" when
   any line item contains seat metadata, and as "topup" otherwise.
   This is a seat-detection heuristic; non-seat subscription types
   that appear under an organization customer would be misclassified
   as "topup". The system SHOULD alert operators when invoices are
   classified as "topup" for an organization that has an active seat
   subscription, to detect potential misclassification.
2. The system MUST return invoice data including: ID, number,
   status, amount due, currency, creation date, hosted URL, PDF URL,
   type, and description.

### Email Notifications

1. The system MUST send a subscription confirmation email to the
   purchasing user upon initial subscription creation.
2. The system MUST send a renewal notification email to all
   organization owners when the subscription renews (first event in
   a new billing period). For monthly subscriptions this occurs
   every month; for annual subscriptions, once per year.
3. The system MUST send a cancellation notification email to all
   organization owners when the subscription ends.
4. The system MUST NOT send renewal emails for seat count changes
   within the same billing period.
5. Email delivery failures MUST be logged and reported to error
   tracking but MUST NOT block or roll back the subscription
   operation.

## Error Handling

1. When a subscription event has no line items or the first line
   item lacks a period end date, the system MUST reject the event
   with an error.
2. When subscription metadata is missing or has invalid required
   fields (type, user ID, organization ID, or non-numeric seat
   value), the system MUST reject the event with a validation error.
3. When a seat count update is requested but no subscription exists,
   the system MUST return a not-found error.
4. When a cancellation or stop-cancellation is requested but the
   organization's trial has hard-expired (and no subscription
   exists), the system MUST return a forbidden error.
5. When a new subscription checkout is attempted but the
   organization already has a non-ended subscription, the system
   MUST return a bad-request error.
6. When a payment for seat increase fails (e.g., card declined,
   insufficient funds), the system MUST propagate the failure rather
   than silently accepting the seat change.
7. When the payment processor customer creation fails, the system
   MUST propagate the error without persisting a partial customer
   record.
8. When a downgrade is attempted to a count lower than current seat
   usage, the system MUST return an error that includes both the
   current seat usage count and the requested seat count, so the
   caller can understand why the downgrade was rejected.
9. When a subscription event references an organization that has
   been deleted, the system MUST reject the event with an error
   and log a warning.

## Not Yet Implemented

The following rules reflect intended behavior that is not yet enforced
in the current codebase:

1. The system SHOULD record the net amount actually charged (after
   discounts) rather than the gross list price for subscription
   purchase records. (Currently records gross only.)

## Changelog

### 2026-03-28/29 -- Spec audit and billing compliance

- Added Definitions: non-ended subscription, active subscription,
  active subscription purchase, free-seat line item, active member,
  self-service creation flow, known paid seat prices, seat metadata,
  subscription event, subscription metadata user, subscription
  metadata type, bot user, OSS sponsorship program, suppressed trial
  messaging, trial stages (with numeric boundaries).
- Fixed CRITICAL: Free Trial rule 3 contradicted itself — said
  "flooring" and "(i.e., truncating toward zero)" which differ for
  negative values. Clarified to "floor semantics (rounding toward
  negative infinity)." Rewrote trial stage definitions to use
  `daysRemaining` integer values instead of ambiguous "N days past
  expiration" prose.
- Fixed Subscription Lifecycle rules 1-2: merged with explicit
  precedence so rule 2 (don't re-add removed users) clearly
  overrides rule 1 (add as owner if no membership).
- Documented metadata user behavior: if user ID doesn't resolve,
  membership step silently fails but purchase proceeds (Lifecycle
  rule 1). Documented that membership-ensure step MAY execute
  outside the purchase-recording transaction.
- Upgraded Subscription Lifecycle rule 2 from SHOULD to MUST and
  clarified rule 1 to resolve the conflict between ensuring user
  ownership and not re-adding removed users.
- Added Subscription Lifecycle rule 4: release pending billing cycle
  change schedule before cancellation.
- Added Subscription Lifecycle rule 10: block organization deletion
  while a non-ended subscription exists.
- Added Seat Usage Counting rule 5: bot user exclusion.
- Added Seat Usage Counting rule 11: over-quota members after a
  period-boundary downgrade MUST NOT be removed; system SHOULD warn
  owners.
- Added Seat Count Modification rule 8: concurrent modification
  serialization.
- Added Seat Count Updates rule 12: unrecognized billing cycle
  interval defaults to monthly.
- Added Email Notifications rule 5: email failures must not block
  subscription operations.
- Added Error Handling rule 9: reject events for deleted orgs.
- Added Invoices rule 1 SHOULD for misclassification alerting.
- Added Billing Cycle Changes rule 1 concurrent-request guard.
- Clarified Organization Plans rules 2, 5, 8; Seat Purchase rules 6, 8;
  Seat Count Updates rules 3, 9, 11; Subscription Lifecycle rules 2, 7, 9;
  Billing Cycle Changes rule 11; Free Trial rules 2-4, 8-10;
  Require-Seats rule 3; Seat Count Modification rule 7;
  Error Handling rule 8.
- Rewrote Seat Count Updates rule 2 as a business invariant instead
  of an algorithm description.
- Made Free Trial rule 4 styling requirements explicit (replaced
  "e.g." with MUST for each trial stage styling level).
- Added USD-only currency convention.
- Updated purchase record definition: removed "database row" wording.

- Removed NYI item 2 (removed-user tombstone) — now implemented.
- Removed NYI item 3 (org deletion guard) — verified fixed in prior audit.

### 2026-03-28 -- Billing cycle change hardening

- Expanded Billing Cycle Changes with rules 6-11: cancellation of
  pending changes, preservation of all line items and discounts,
  orphan schedule recovery, plan tier derived from Stripe price,
  and schedule structure verification.
- Added Subscription Lifecycle rule 5: resubscribe preserves the
  previous billing cycle.
- Added Seat Purchase and Checkout rule 8: resubscribe uses only
  paid seat quantity.

### 2026-03-26 -- Monthly billing cycle option

- Rewrote Seat Pricing to separate monthly and annual prices per
  plan tier. Monthly rates: Teams $18/seat, Enterprise $72/seat.
  Annual rates unchanged ($180/$720). Annual equals 10 monthly
  payments (12 months for the price of 10).
- Added billing cycle selection to Seat Purchase and Checkout.
- Added Billing Cycle Changes section: cycle switches take effect
  at renewal, no proration, restricted to owners and billing
  managers.
- Updated Overview and Organization Plans rule 4 to reflect that
  users choose both plan tier and billing cycle at conversion.
- Clarified Email Notifications renewal frequency by billing cycle.

### 2026-03-26 -- Initial spec

- Reverse-engineered from existing codebase.
