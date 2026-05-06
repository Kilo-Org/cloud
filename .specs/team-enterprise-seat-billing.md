# Team and Enterprise Seat Billing

## Role of This Document

This spec defines business rules and invariants for Team and Enterprise seat billing: required states, pricing, seat
counting, subscription lifecycle, and user-facing behavior. It is the source of truth for _what_ the system must
guarantee, not _how_ to implement it. Handler names, column layouts, Stripe API call patterns, and other implementation
choices belong in plans and code.

## Status

Active.

- 2026-03-26: reverse-engineered from existing code.
- 2026-03-26: added monthly billing cycle option.
- 2026-03-28: documented billing cycle change hardening.
- 2026-03-28/29: added spec audit fixes, definitions, and billing compliance implementation.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT
RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174]
when, and only when, they appear in all capitals, as shown here.

All monetary amounts in this spec are USD; seat billing currently supports only USD.

## Definitions

- **Active member**: User with a current organization membership record who is not a bot user. Counted toward seat usage
  after excluding billing managers.
- **Seat**: Access unit purchased by an organization. Each active member (except billing managers) and each pending
  invitation (except billing manager role) consumes one seat.
- **Billing cycle**: Subscription recurrence interval: monthly or annual.
- **Billing period**: One interval within a billing cycle (one month for monthly, one year for annual). Renewal and
  proration boundaries align to billing period edges.
- **Purchase record**: Persistent subscription-event record containing: subscription ID, organization ID, seat count,
  amount, start date, expiration date, idempotency key, and status.
- **Billing manager**: Organization role granting access to billing operations (checkout, cancellation, seat changes,
  portal) without consuming a seat.
- **Seat usage**: Active members plus qualifying pending invitations, excluding billing managers and expired/accepted
  invitations.
- **Non-ended subscription**: Subscription for which the payment processor has not set a termination timestamp. All
  subscription statuses except canceled and incomplete-expired are non-ended.
- **Active subscription**: Subscription whose payment processor status is specifically `active`. Distinguished from
  "non-ended subscription," which also includes statuses such as past-due or incomplete.
- **Active subscription purchase**: Purchase record whose `subscription_status` is not `ended`. Used for access checks
  and trial enforcement — an organization with at least one active subscription purchase is considered subscribed.
- **Known paid seat prices**: Payment processor price identifiers for the four seat pricing tiers (Teams monthly, Teams
  annual, Enterprise monthly, Enterprise annual). This configuration set MUST be updated whenever pricing tiers are
  added or removed.
- **Seat line item**: Subscription line item whose associated payment processor price product is the Teams or Enterprise
  seat product. Paid seat line items use known paid seat prices. Free-seat line items use another price under a seat
  product.
- **Free-seat line item**: Seat line item whose price is not one of the known paid seat prices. These represent
  promotional or complimentary seats and are excluded when determining resubscribe quantity.
- **Seat metadata**: Payment processor metadata used to classify subscriptions or invoices as seat-related. Subscription
  metadata `type` value `seats` identifies seat subscriptions; known paid seat price IDs can also identify seat invoice
  lines.
- **Self-service creation flow**: User-initiated flow for creating a new organization through the standard web UI, not
  administrative creation (admin panel, scripts, or API).
- **Require-seats flag**: Per-organization boolean that, when false, bypasses all trial and subscription enforcement —
  used for design partners, internal testing, and enterprise contracts.
- **Subscription event**: Subscription state-change notification from the payment processor (via webhook) or recorded
  locally after a direct API call (see Subscription Lifecycle rules 7-8). Both sources produce the same processing flow.
- **Subscription metadata user**: User identified by `kiloUserId` in the payment processor subscription metadata object.
  Typically the checkout initiator.
- **Subscription metadata type**: String field in payment processor subscription metadata identifying the subscription
  category (e.g., `seats`). Used to dispatch subscription events to the appropriate handler.
- **Bot user**: System or service account (flagged `is_bot` in the user record) excluded from seat counting and
  organization member lists.
- **OSS sponsorship program**: Organization-level enrollment (indicated by a non-null `oss_sponsorship_tier` setting)
  managed through an administrative workflow. Participating organizations are exempt from trial expiration.
- **Suppressed trial messaging**: Organization setting (`suppress_trial_messaging`) that, when enabled, treats the
  organization as if it has an active subscription for trial enforcement purposes.
- **Trial stages**: Progressive classifications of an organization's trial status based on floored `daysRemaining` (see
  Free Trial rule 3):
  - **Active**: `daysRemaining >= 8`
  - **Ending soon**: `daysRemaining` 4 through 7 (inclusive)
  - **Ending very soon**: `daysRemaining` 1 through 3 (inclusive)
  - **Expires today**: `daysRemaining == 0`
  - **Soft-expired**: `daysRemaining` −1 through −3 (inclusive)
  - **Hard-expired**: `daysRemaining <= −4`

## Overview

Organizations buy recurring seats to give members platform access. Two plan tiers exist -- Teams and Enterprise -- each
with distinct per-seat pricing. Each tier supports monthly and annual billing; annual billing costs 10 months of the
monthly rate (12 months for the price of 10). All self-service signups start on Enterprise with a 14-day free trial.
Users choose plan tier (Teams or Enterprise) and billing cycle (monthly or annual) only when converting to paid. Seat
counts are tracked per organization and enforced against active members and pending invitations. Organizations without
an active subscription use a time-limited free trial with escalating restrictions: informational banners, a dismissible
read-only lock, then a non-dismissible hard lock blocking all server-side mutations. A billing manager role grants
billing access without consuming a seat.

## Rules

### Organization Plans

1. System MUST support exactly two plan types: Teams and Enterprise.
2. System MUST default the organization plan to Teams at the data layer when no plan is explicitly provided by the
   creation flow. (Self-service creation always provides Enterprise; see rule 3.)
3. The self-service creation flow MUST create all new organizations on the Enterprise plan with a 14-day free trial.
4. The user MUST NOT be offered a choice of plan or billing cycle during trial creation; plan tier and billing cycle
   selection occurs only when converting to a paid subscription.
5. When processing any subscription event (whether from a webhook or a local API call), system MUST update the
   organization's plan type if the subscription metadata includes a valid plan type value.
6. System MUST NOT change the organization's plan type when the subscription metadata omits the plan type field.
7. System MUST silently ignore (log and discard) invalid plan type values in subscription metadata.
8. When an organization transitions from Enterprise to Teams, the system MUST persist Enterprise-only settings (e.g.,
   model deny lists, provider deny lists, KiloClaw opt-out) in storage, MUST exclude them from enforcement logic, and
   MUST NOT expose them in the organization settings UI while the plan is Teams.
9. If the organization later transitions back to Enterprise, the system MUST reactivate the previously stored
   Enterprise-only settings without requiring reconfiguration.

### Seat Pricing

1. System MUST price Teams seats at $18 per seat per month on the monthly billing cycle.
2. System MUST price Teams seats at $180 per seat per year on the annual billing cycle (equivalent to $15 per seat per
   month).
3. System MUST price Enterprise seats at $72 per seat per month on the monthly billing cycle.
4. System MUST price Enterprise seats at $720 per seat per year on the annual billing cycle (equivalent to $60 per seat
   per month).
5. Annual pricing MUST equal 10 times the monthly rate for each plan tier (12 months for the price of 10).
6. Both monthly and annual billing cycles MUST be available for both plan tiers.

### Seat Purchase and Checkout

1. System MUST allow purchasing between 1 and 100 seats (inclusive) per checkout.
2. System MUST require the user to select a billing cycle (monthly or annual) during checkout.
3. System MUST use the billing-cycle-specific price for the selected plan tier when creating the checkout session.
4. System MUST require a payment processor customer record for the organization before creating a checkout session.
5. System MUST lazily create the payment processor customer record when one does not yet exist.
6. System MUST NOT allow creating a second subscription if the organization already has a non-ended subscription. Seat
   changes on an existing subscription MUST use the mid-subscription modification flow defined in the Seat Count
   Modification section.
7. System MUST record each subscription event as a seat purchase record with: subscription ID, organization ID, seat
   count, amount in USD, start date, expiration date, idempotency key, and subscription status. The amount MUST reflect
   the actual cycle-specific price charged.
8. When resubscribing after an ended subscription, system MUST use only the paid seat quantity from the most recently
   ended subscription (by termination timestamp), excluding free-seat line items, as the checkout quantity.
9. System MUST require billing address collection during checkout.

### Seat Usage Counting

1. System MUST count each active organization member toward seat usage, except members with the billing manager role.
2. System MUST count each pending invitation toward seat usage, except invitations for the billing manager role.
3. System MUST NOT count expired invitations toward seat usage.
4. System MUST NOT count accepted invitations toward seat usage (accepted invitees are counted as active members
   instead).
5. System MUST NOT count bot users (see Definitions) toward seat usage.
6. System MUST report seat usage as a pair: seats used (members plus qualifying pending invitations) and total seats
   purchased.
7. System MUST allow seat usage to exceed total purchased seats (no hard block on over-usage at the counting layer).
8. For Teams-plan organizations, system MUST disable the invitation UI when seat usage equals or exceeds the purchased
   seat count.
9. For Enterprise-plan organizations, system MUST NOT restrict invitations based on seat usage.
10. Server MUST NOT enforce seat limits when processing invitations or when members accept invitations; seat-limit
    enforcement on invitations is a UI-layer-only control.
11. When a billing period begins with a lower seat count than current usage (e.g., an end-of-period downgrade takes
    effect), system MUST NOT remove existing members. The over-usage state persists until resolved by the organization
    (by removing members or purchasing additional seats). System SHOULD display a warning to organization owners
    indicating over-usage.

### Seat Count Updates from Subscription Events

1. System MUST update the organization's seat count when processing an active subscription event.
2. The organization's effective seat count MUST equal the highest seat count among all purchase records that share the
   most recent billing-period start date for that organization.
3. System MUST apply seat upgrades (higher count with a more recent start date) within the same transaction that records
   the purchase.
4. System MUST NOT apply seat downgrades within the same billing period; the current higher seat count MUST be retained
   until a new billing period begins.
5. System MUST apply seat downgrades when a subscription event arrives with a more recent start date (new billing
   period).
6. System MUST handle out-of-order subscription events correctly by always resolving to the seat count from the most
   recent start date, regardless of processing order.
7. System MUST set the organization's seat count to zero when the subscription has ended.
8. System MUST NOT update the organization's seat count for subscriptions in non-active statuses (e.g., incomplete, past
   due); the purchase record MUST still be created.
9. System MUST sum quantities across all seat line items in a subscription to compute the total seat count (to support
   subscriptions with multiple seat price tiers), and MUST exclude non-seat line items.
10. System MUST record the seat subscription amount as the gross total (list-price unit amount times quantity) across
    all seat line items. This value does not reflect discounts, promotion codes, coupons, or non-seat line items.
11. System SHOULD record the net amount actually charged (after discounts) rather than the gross list price. This is
    SHOULD rather than MUST because the current payment processor API does not expose a reliable net amount at event
    time; once available, this SHOULD be upgraded to MUST. (Not yet implemented.)
12. When a subscription event's recurring interval is not recognized as monthly or annual, system MUST default the
    billing cycle to monthly and log a warning.

### Idempotency

1. System MUST use an idempotency key per subscription event to prevent duplicate processing.
2. System MUST auto-generate an idempotency key when one is not provided.
3. System MUST silently skip subscription events whose idempotency key already exists.
4. System MUST produce exactly one purchase record even when multiple concurrent calls use the same idempotency key.

### Subscription Lifecycle

1. System MUST ensure the subscription metadata user is a member of the organization when processing any subscription
   event, subject to the removal check in rule 2. If the user has never been a member of the organization, system MUST
   add them as owner. If the user already has a membership in any role, system MUST preserve their current role. If the
   metadata user ID does not resolve to a valid user record, the membership step silently fails (no membership is
   created) but the subscription event continues to be processed normally — the purchase record is still created and
   seat counts are still updated. The membership-ensure step MAY execute outside the purchase-recording transaction; if
   it succeeds but the purchase recording subsequently fails, the membership MUST NOT be rolled back — the user retains
   their membership.
2. System MUST NOT re-add a subscription metadata user who was previously removed from the organization. This rule takes
   precedence over rule 1: a removed user is not treated as "never been a member." System MUST be able to distinguish
   between a user who has never been a member and a user who was removed. (Not yet implemented — currently, if the
   metadata user was removed from the organization and a subsequent webhook fires, they are re-added as owner.)
3. System MUST cancel subscriptions at the end of the current billing period (not immediately).
4. When cancelling a subscription that has a pending billing cycle change schedule, system MUST release the schedule
   before or as part of the cancellation to prevent orphaned schedules.
5. System MUST allow a pending cancellation to be reversed (stop cancellation), restoring the subscription to active.
6. When resubscribing after an ended subscription, system MUST preserve the previous billing cycle (monthly or annual)
   as the default for the new checkout session.
7. System MUST record subscription changes to the system's persistent state synchronously — before returning a response
   to the caller — after making payment processor API calls. The system MUST NOT depend solely on asynchronous webhook
   delivery for state consistency.
8. System MUST also process incoming webhook events for subscription creation, update, and deletion.
9. System MUST dispatch the subscription event to the correct handler based on the subscription metadata type field (see
   Definitions). Events with unrecognized type values MUST be logged and discarded.
10. System MUST NOT allow deletion of an organization while a non-ended subscription exists. The subscription MUST be
    cancelled (and reach ended state) before organization deletion can proceed.

### Seat Count Modification (Mid-Subscription)

1. System MUST allow only organization owners and billing managers to modify the seat count on an active subscription.
2. System MUST reject seat downgrades when the requested count is less than the number of seats currently in use.
3. System MUST apply prorated billing (immediate invoice) when increasing seats.
4. System MUST NOT prorate when decreasing seats; the decrease takes effect at the end of the billing cycle. This
   applies to both monthly and yearly billing cycles.
5. System MUST support payment authentication challenges (e.g., 3D Secure) for seat increases that require additional
   verification, returning a client secret for frontend handling.
6. System MUST validate that the new seat count is a positive integer.
7. System MUST NOT impose an upper limit on seat count for mid-subscription modifications. The 100-seat limit in Seat
   Purchase rule 1 applies only to the initial checkout flow.
8. System MUST serialize concurrent seat count modifications for the same subscription to prevent conflicting payment
   processor updates.

### Billing Cycle Changes

1. System MUST allow an organization to request a billing cycle change (monthly to annual, or annual to monthly) on an
   active subscription. If two concurrent requests both pass the existing-schedule check, the second MUST fail rather
   than create a duplicate schedule.
2. A billing cycle change MUST take effect at the next renewal date; it MUST NOT be applied immediately.
3. System MUST NOT prorate or issue immediate charges or credits for a billing cycle change request.
4. System MUST restrict billing cycle change requests to organization owners and billing managers.
5. When a billing cycle change takes effect at renewal, the system MUST use the new cycle's price for the next billing
   period.
6. System MUST allow cancellation of a pending billing cycle change, restoring the subscription to its original cycle.
7. System MUST preserve all subscription line items when scheduling a billing cycle change; only the paid seat price
   MUST change, other items (e.g., free seats) MUST be carried forward unchanged.
8. System MUST preserve subscription-level discounts (promotion codes, coupons) when scheduling a billing cycle change.
   Both the current-period phase and the new-cycle phase MUST retain the active discounts.
9. If the schedule phase update fails after the schedule has been created, system MUST release the orphaned schedule so
   the subscription is not permanently blocked from future cycle changes.
10. System MUST determine the subscription's plan tier from the live payment processor price, not from the
    organization's database plan field, to prevent billing the wrong tier when the two diverge.
11. System MUST verify that a schedule was created by the billing cycle change flow before allowing cancellation, to
    avoid releasing unrelated schedules.

### Subscription Access Control

1. System MUST restrict subscription creation, cancellation, stop-cancellation, seat count changes, and billing portal
   access to organization owners and billing managers.
2. System MUST allow any organization member to view the current subscription status and seat usage.
3. System MUST reject requests from non-members with an access denied error.
4. System MUST reject requests from members who are neither owners nor billing managers with a role-based authorization
   error.

### Require-Seats Flag and Subscription Enforcement

1. System MUST treat organizations with the require-seats flag set to false as having an active subscription for all
   access checks (bypassing trial and subscription requirements).
2. System MUST set the require-seats flag to true for all new organization signups, including enterprise trials.
3. System MUST allow platform administrators (users with the site-wide admin role) to manually set the require-seats
   flag to false for any organization at the administrator's discretion, including design partners, internal testing,
   and enterprise contracts.
4. System MUST classify an organization's status as "active" when it either has require-seats disabled OR has an active
   subscription purchase.
5. System MUST classify an organization's status as "incomplete" when it has require-seats enabled AND has no active
   subscription.

### Organization KiloClaw Add-On

1. KiloClaw is an organization add-on subordinate to the organization subscription or trial entitlement.
2. Organization KiloClaw MUST NOT create, modify, or extend the organization seat subscription.
3. Organization KiloClaw MUST NOT appear as a direct Stripe add-on line item on the organization seat subscription.
4. When the organization subscription entitlement ends because the organization subscription is canceled, ended, or
   otherwise no longer recoverable as the same entitlement, the KiloClaw billing system MUST cancel organization
   KiloClaw subscriptions.
5. Organization KiloClaw availability MUST follow the organization's active, trial, and hard-expired access state.
   Active or trialing organization states MAY allow KiloClaw, subject to KiloClaw-specific rules. Hard-expired
   organization trial states MUST block KiloClaw access but MUST NOT by themselves immediately cancel organization
   KiloClaw subscriptions. Ended organization entitlement MUST block KiloClaw access.
6. Enterprise organizations MUST support an admin-controlled KiloClaw opt-out setting.
7. This setting MUST be persisted like other Enterprise-only settings.
8. The setting MUST be hidden or non-configurable while the organization is Teams.
9. The setting MUST NOT be enforced while the organization is Teams.
10. If the organization returns to Enterprise, the persisted setting MUST again be enforceable.
11. When enforced, the setting MUST block organization KiloClaw provisioning and access.

### Free Trial

1. System MUST place organizations without an active subscription into a free trial period.
2. System MUST compute trial expiration from an explicit end date when set, or fall back to the organization creation
   date plus a configurable number of days (default: 14).
3. System MUST compute days remaining by flooring the fractional difference between the expiration timestamp and the
   current time (i.e., rounding toward negative infinity, using `floor` semantics — not truncation toward zero). The
   system MUST classify trial status into the progressive trial stages defined in the Definitions section.
4. During active, ending-soon, ending-very-soon, and expires-today stages, system MUST allow full functionality and MUST
   display an informational banner. The banner MUST use informational styling during the active stage, warning styling
   during the ending-soon stage, and critical styling during the ending-very-soon and expires-today stages.
5. During the soft-expired stage, system MUST display a dismissible blocking dialog. If the user dismisses it, the
   system MUST present the interface in a read-only state with interactive controls disabled.
6. The soft-expired read-only restriction MUST be enforced at the UI layer only; the server MUST NOT block mutations
   during the soft-expired stage.
7. During the hard-expired stage, system MUST display a non-dismissible blocking dialog. The user's only options MUST be
   to upgrade or switch to a personal profile.
8. System MUST evaluate trial expiration status on every mutation request and MUST block server-side mutations with a
   forbidden error when the trial is currently hard-expired and no active subscription exists.
9. System MUST exempt organizations participating in the OSS sponsorship program (see Definitions) from trial expiration
   (never hard-locked).
10. System MUST exempt organizations with suppressed trial messaging (see Definitions) from trial expiration (treated as
    subscribed).

### Payment Processor Customer Management

1. System MUST create at most one payment processor customer per organization.
2. System MUST reuse an existing payment processor customer ID when one is already stored.
3. System MUST handle race conditions during customer creation: if another process sets the customer ID between the
   initial check and the update, the creation MUST fail rather than overwrite.
4. System MUST store the organization ID in the payment processor customer's metadata.

### Invoices

1. System MUST classify organization invoices as "seats" when any line item contains seat metadata, and as "topup"
   otherwise. This is a seat-detection heuristic; non-seat subscription types that appear under an organization customer
   would be misclassified as "topup". System SHOULD alert operators when invoices are classified as "topup" for an
   organization that has an active seat subscription, to detect potential misclassification.
2. System MUST return invoice data including: ID, number, status, amount due, currency, creation date, hosted URL, PDF
   URL, type, and description.

### Email Notifications

1. System MUST send a subscription confirmation email to the purchasing user upon initial subscription creation.
2. System MUST send a renewal notification email to all organization owners when the subscription renews (first event in
   a new billing period). For monthly subscriptions this occurs every month; for annual subscriptions, once per year.
3. System MUST send a cancellation notification email to all organization owners when the subscription ends.
4. System MUST NOT send renewal emails for seat count changes within the same billing period.
5. Email delivery failures MUST be logged and reported to error tracking but MUST NOT block or roll back the
   subscription operation.

## Error Handling

1. When a subscription event has no seat line items or no seat line item has a period end date, system MUST reject the
   event with an error.
2. When subscription metadata is missing or has invalid required fields (type, user ID, organization ID, or non-numeric
   seat value), system MUST reject the event with a validation error.
3. When a seat count update is requested but no subscription exists, system MUST return a not-found error.
4. When a cancellation or stop-cancellation is requested but the organization's trial has hard-expired (and no
   subscription exists), system MUST return a forbidden error.
5. When a new subscription checkout is attempted but the organization already has a non-ended subscription, the system
   MUST return a bad-request error.
6. When a payment for seat increase fails (e.g., card declined, insufficient funds), system MUST propagate the failure
   rather than silently accepting the seat change.
7. When the payment processor customer creation fails, the system MUST propagate the error without persisting a partial
   customer record.
8. When a downgrade is attempted to a count lower than current seat usage, system MUST return an error that includes
   both the current seat usage count and the requested seat count, so the caller can understand why the downgrade was
   rejected.
9. When a subscription event references an organization that has been deleted, system MUST reject the event with an
   error and log a warning.

## Not Yet Implemented

These intended rules are not yet enforced in the current codebase:

1. System SHOULD record the net amount actually charged (after discounts) rather than the gross list price for
   subscription purchase records. (Currently records gross only.)

## Changelog

### 2026-05-06 -- Organization KiloClaw add-on

- Added organization KiloClaw as a credits-funded add-on subordinate to organization entitlement, not a Stripe
  seat-subscription line item.
- Added Enterprise-only KiloClaw opt-out persistence and enforcement rules aligned with other Enterprise-only settings.

### 2026-05-05 -- Mixed subscription line-item filtering

- Updated seat line item definitions and Seat Count Updates rules 9-10 to require filtering subscription events to seat
  product line items only, excluding non-seat add-ons from seat counts and recorded seat subscription amount.
- Updated Error Handling rule 1 to validate seat line item periods rather than the first unfiltered line item.

### 2026-03-28/29 -- Spec audit and billing compliance

- Added Definitions: non-ended subscription, active subscription, active subscription purchase, free-seat line item,
  active member, self-service creation flow, known paid seat prices, seat metadata, subscription event, subscription
  metadata user, subscription metadata type, bot user, OSS sponsorship program, suppressed trial messaging, trial stages
  (with numeric boundaries).
- Fixed CRITICAL: Free Trial rule 3 contradicted itself — said "flooring" and "(i.e., truncating toward zero)" which
  differ for negative values. Clarified to "floor semantics (rounding toward negative infinity)." Rewrote trial stage
  definitions to use `daysRemaining` integer values instead of ambiguous "N days past expiration" prose.
- Fixed Subscription Lifecycle rules 1-2: merged with explicit precedence so rule 2 (don't re-add removed users) clearly
  overrides rule 1 (add as owner if no membership).
- Documented metadata user behavior: if user ID doesn't resolve, membership step silently fails but purchase proceeds
  (Lifecycle rule 1). Documented that membership-ensure step MAY execute outside the purchase-recording transaction.
- Upgraded Subscription Lifecycle rule 2 from SHOULD to MUST and clarified rule 1 to resolve the conflict between
  ensuring user ownership and not re-adding removed users.
- Added Subscription Lifecycle rule 4: release pending billing cycle change schedule before cancellation.
- Added Subscription Lifecycle rule 10: block organization deletion while a non-ended subscription exists.
- Added Seat Usage Counting rule 5: bot user exclusion.
- Added Seat Usage Counting rule 11: over-quota members after a period-boundary downgrade MUST NOT be removed; system
  SHOULD warn owners.
- Added Seat Count Modification rule 8: concurrent modification serialization.
- Added Seat Count Updates rule 12: unrecognized billing cycle interval defaults to monthly.
- Added Email Notifications rule 5: email failures must not block subscription operations.
- Added Error Handling rule 9: reject events for deleted orgs.
- Added Invoices rule 1 SHOULD for misclassification alerting.
- Added Billing Cycle Changes rule 1 concurrent-request guard.
- Clarified Organization Plans rules 2, 5, 8; Seat Purchase rules 6, 8; Seat Count Updates rules 3, 9, 11; Subscription
  Lifecycle rules 2, 7, 9; Billing Cycle Changes rule 11; Free Trial rules 2-4, 8-10; Require-Seats rule 3; Seat Count
  Modification rule 7; Error Handling rule 8.
- Rewrote Seat Count Updates rule 2 as a business invariant instead of an algorithm description.
- Made Free Trial rule 4 styling requirements explicit (replaced "e.g." with MUST for each trial stage styling level).
- Added USD-only currency convention.
- Updated purchase record definition: removed "database row" wording.

- Removed NYI item 2 (removed-user tombstone) — now implemented.
- Removed NYI item 3 (org deletion guard) — verified fixed in prior audit.

### 2026-03-28 -- Billing cycle change hardening

- Expanded Billing Cycle Changes with rules 6-11: cancellation of pending changes, preservation of all line items and
  discounts, orphan schedule recovery, plan tier derived from Stripe price, and schedule structure verification.
- Added Subscription Lifecycle rule 5: resubscribe preserves the previous billing cycle.
- Added Seat Purchase and Checkout rule 8: resubscribe uses only paid seat quantity.

### 2026-03-26 -- Monthly billing cycle option

- Rewrote Seat Pricing to separate monthly and annual prices per plan tier. Monthly rates: Teams $18/seat, Enterprise
  $72/seat. Annual rates unchanged ($180/$720). Annual equals 10 monthly payments (12 months for the price of 10).
- Added billing cycle selection to Seat Purchase and Checkout.
- Added Billing Cycle Changes section: cycle switches take effect at renewal, no proration, restricted to owners and
  billing managers.
- Updated Overview and Organization Plans rule 4 to reflect that users choose both plan tier and billing cycle at
  conversion.
- Clarified Email Notifications renewal frequency by billing cycle.

### 2026-03-26 -- Initial spec

- Reverse-engineered from existing codebase.
