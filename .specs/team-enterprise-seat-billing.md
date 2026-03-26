# Team and Enterprise Seat Billing

## Status

Draft -- reverse-engineered from existing code on 2026-03-26.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Overview

Organizations purchase seats through recurring subscriptions to grant their members
access to the platform. Two plan tiers exist -- Teams and Enterprise -- each with
distinct per-seat pricing. All self-service signups begin on the Enterprise plan
with a 14-day free trial; users choose their plan tier (Teams or Enterprise) when
converting to a paid subscription. Seat counts are tracked per organization and
enforced against active members and pending invitations. Organizations without an
active subscription operate under a time-limited free trial with escalating
restrictions: informational banners, then a dismissible read-only lock, then a
non-dismissible hard lock that blocks all server-side mutations. A "billing manager"
role exists that grants billing access without consuming a seat.

## Rules

### Organization Plans

1. The system MUST support exactly two plan types: Teams and Enterprise.
2. The system MUST default the organization plan to Teams at the data layer when no plan is explicitly specified.
3. The self-service creation flow MUST create all new organizations on the Enterprise plan with a 14-day free trial.
4. The user MUST NOT be offered a choice of plan during trial creation; plan selection occurs only when converting to a paid subscription.
5. The system MUST update the organization's plan type when subscription metadata includes a valid plan type value.
6. The system MUST NOT change the organization's plan type when the subscription metadata omits the plan type field.
7. The system MUST silently ignore (log and discard) invalid plan type values in subscription metadata.
8. When an organization transitions from Enterprise to Teams, the system MUST retain Enterprise-only settings (e.g., model deny lists, provider deny lists) in storage but MUST NOT apply them while the plan is Teams.
9. If the organization later transitions back to Enterprise, the system MUST reactivate the previously stored Enterprise-only settings without requiring reconfiguration.

### Seat Pricing

1. The system MUST price Teams seats at $15 per seat per month (or $180 per seat per year).
2. The system MUST price Enterprise seats at $60 per seat per month (or $720 per seat per year).
3. The system MUST support both monthly and yearly billing cycles.

### Seat Purchase and Checkout

1. The system MUST allow purchasing between 1 and 100 seats (inclusive) per checkout.
2. The system MUST require a payment processor customer record for the organization before creating a checkout session.
3. The system MUST lazily create the payment processor customer record when one does not yet exist.
4. The system MUST NOT allow creating a second subscription if the organization already has a non-ended subscription. Seat changes on an existing subscription use a separate modification flow.
5. The system MUST record each subscription event as a seat purchase record with: subscription ID, organization ID, seat count, amount in USD, start date, expiration date, idempotency key, and subscription status.
6. The system MUST require billing address collection during checkout.

### Seat Usage Counting

1. The system MUST count each active organization member toward seat usage, except members with the billing manager role.
2. The system MUST count each pending invitation toward seat usage, except invitations for the billing manager role.
3. The system MUST NOT count expired invitations toward seat usage.
4. The system MUST NOT count accepted invitations toward seat usage (accepted invitees are counted as active members instead).
5. The system MUST report seat usage as a pair: seats used (members plus qualifying pending invitations) and total seats purchased.
6. The system MUST allow seat usage to exceed total purchased seats (no hard block on over-usage at the counting layer).
7. For Teams-plan organizations, the system MUST disable the invitation UI when seat usage equals or exceeds the purchased seat count.
8. For Enterprise-plan organizations, the system MUST NOT restrict invitations based on seat usage.
9. The server MUST NOT enforce seat limits when processing invitations or when members accept invitations; seat-limit enforcement on invitations is a UI-layer-only control.

### Seat Count Updates from Subscription Events

1. The system MUST update the organization's seat count when processing an active subscription event.
2. The system MUST determine the effective seat count by finding all purchase records with the most recent start date and taking the maximum seat count among them.
3. The system MUST apply seat upgrades (higher count with a more recent start date) immediately.
4. The system MUST NOT apply seat downgrades within the same billing period; the current higher seat count MUST be retained until a new billing period begins.
5. The system MUST apply seat downgrades when a subscription event arrives with a more recent start date (new billing period).
6. The system MUST handle out-of-order subscription events correctly by always resolving to the seat count from the most recent start date, regardless of processing order.
7. The system MUST set the organization's seat count to zero when the subscription has ended.
8. The system MUST NOT update the organization's seat count for subscriptions in non-active statuses (e.g., incomplete, past due); the purchase record MUST still be created.
9. The system MUST sum quantities across all line items in a subscription to compute the total seat count (to support subscriptions with multiple price tiers).
10. The system MUST record the subscription amount as the gross total (list-price unit amount times quantity) across all line items. This value does not reflect discounts, promotion codes, or coupons.
11. The system SHOULD record the net amount actually charged (after discounts) rather than the gross list price. (Not yet implemented.)

### Idempotency

1. The system MUST use an idempotency key per subscription event to prevent duplicate processing.
2. The system MUST auto-generate an idempotency key when one is not provided.
3. The system MUST silently skip subscription events whose idempotency key already exists.
4. The system MUST produce exactly one purchase record even when multiple concurrent calls use the same idempotency key.

### Subscription Lifecycle

1. The system MUST ensure the user identified in the subscription metadata is an owner of the organization when processing any subscription event. This is idempotent: if the user already has a membership (in any role), their existing role is preserved.
2. The system SHOULD NOT re-add a previously removed user as owner based on subscription metadata during webhook processing. (Not yet implemented -- currently, if the metadata user was removed from the organization and a subsequent webhook fires, they are re-added as owner.)
3. The system MUST cancel subscriptions at the end of the current billing period (not immediately).
4. The system MUST allow a pending cancellation to be reversed (stop cancellation), restoring the subscription to active.
5. The system MUST immediately record subscription changes to the local database after API calls, without waiting for asynchronous webhook delivery.
6. The system MUST also process incoming webhook events for subscription creation, update, and deletion.
7. The system MUST dispatch the subscription event to the correct handler based on the subscription metadata type field.

### Seat Count Modification (Mid-Subscription)

1. The system MUST allow only organization owners and billing managers to modify the seat count on an active subscription.
2. The system MUST reject seat downgrades when the requested count is less than the number of seats currently in use.
3. The system MUST apply prorated billing (immediate invoice) when increasing seats.
4. The system MUST NOT prorate when decreasing seats; the decrease takes effect at the end of the billing cycle. This applies to both monthly and yearly billing cycles.
5. The system MUST support payment authentication challenges (e.g., 3D Secure) for seat increases that require additional verification, returning a client secret for frontend handling.
6. The system MUST validate that the new seat count is a positive integer.
7. The system MUST NOT impose an upper limit on seat count for mid-subscription modifications (unlike initial checkout, which caps at 100).

### Subscription Access Control

1. The system MUST restrict subscription creation, cancellation, stop-cancellation, seat count changes, and billing portal access to organization owners and billing managers.
2. The system MUST allow any organization member to view the current subscription status and seat usage.
3. The system MUST reject requests from non-members with an access denied error.
4. The system MUST reject requests from members who are neither owners nor billing managers with a role-based authorization error.

### Require-Seats Flag and Subscription Enforcement

1. The system MUST treat organizations with the require-seats flag set to false as having an active subscription for all access checks (bypassing trial and subscription requirements).
2. The system MUST set the require-seats flag to true for all new organization signups, including enterprise trials.
3. The system MUST allow administrators to manually set the require-seats flag to false for special accounts (design partners, internal testing, enterprise contracts).
4. The system MUST classify an organization's status as "active" when it either has require-seats disabled OR has an active subscription purchase.
5. The system MUST classify an organization's status as "incomplete" when it has require-seats enabled AND has no active subscription.

### Free Trial

1. The system MUST place organizations without an active subscription into a free trial period.
2. The system MUST compute trial expiration from an explicit end date when set, or fall back to the organization creation date plus a configurable number of days.
3. The system MUST classify trial status into progressive stages: active (8+ days remaining), ending soon (4-7 days), ending very soon (1-3 days), expires today (0 days), soft-expired (1-3 days past), and hard-expired (4+ days past).
4. During active, ending-soon, ending-very-soon, and expires-today stages, the system MUST allow full functionality and MUST display an informational banner with escalating visual urgency.
5. During the soft-expired stage, the system MUST display a dismissible blocking dialog. If the user dismisses it, the system MUST present the interface in a read-only state with interactive controls disabled.
6. The soft-expired read-only restriction MUST be enforced at the UI layer only; the server MUST NOT block mutations during the soft-expired stage.
7. During the hard-expired stage, the system MUST display a non-dismissible blocking dialog. The user's only options MUST be to upgrade or switch to a personal profile.
8. The system MUST block all server-side mutations with a forbidden error when the trial is hard-expired and no active subscription exists.
9. The system MUST exempt organizations participating in the OSS sponsorship program from trial expiration (never hard-locked).
10. The system MUST exempt organizations with suppressed trial messaging from trial expiration (treated as subscribed).

### Payment Processor Customer Management

1. The system MUST create at most one payment processor customer per organization.
2. The system MUST reuse an existing payment processor customer ID when one is already stored.
3. The system MUST handle race conditions during customer creation: if another process sets the customer ID between the initial check and the update, the creation MUST fail rather than overwrite.
4. The system MUST store the organization ID in the payment processor customer's metadata.

### Invoices

1. The system MUST classify organization invoices as "seats" when any line item contains seat metadata, and as "topup" otherwise. This is a seat-detection heuristic; non-seat subscription types that appear under an organization customer would be misclassified as "topup".
2. The system MUST return invoice data including: ID, number, status, amount due, currency, creation date, hosted URL, PDF URL, type, and description.

### Email Notifications

1. The system MUST send a subscription confirmation email to the purchasing user upon initial subscription creation.
2. The system MUST send a renewal notification email to all organization owners when the subscription renews (first event in a new billing period).
3. The system MUST send a cancellation notification email to all organization owners when the subscription ends.
4. The system MUST NOT send renewal emails for seat count changes within the same billing period.

## Error Handling

1. When a subscription event has no line items or the first line item lacks a period end date, the system MUST reject the event with an error.
2. When subscription metadata is missing or has invalid required fields (type, user ID, organization ID, or non-numeric seat value), the system MUST reject the event with a validation error.
3. When a seat count update is requested but no subscription exists, the system MUST return a not-found error.
4. When a cancellation or stop-cancellation is requested but the organization's trial has hard-expired (and no subscription exists), the system MUST return a forbidden error.
5. When a new subscription checkout is attempted but the organization already has a non-ended subscription, the system MUST return a bad-request error.
6. When a payment for seat increase fails (e.g., card declined, insufficient funds), the system MUST propagate the failure rather than silently accepting the seat change.
7. When the payment processor customer creation fails, the system MUST propagate the error without persisting a partial customer record.
8. When a downgrade is attempted to a count lower than current seat usage, the system MUST return a descriptive error including the current usage and requested count.

## Not Yet Implemented

The following rules use SHOULD and reflect intended behavior that is not yet enforced in the current codebase:

1. The system SHOULD record the net amount actually charged (after discounts) rather than the gross list price for subscription purchase records. (Currently records gross only.)
2. The system SHOULD NOT re-add a previously removed user as owner based on subscription metadata during webhook processing. (Currently, webhook events will re-add the metadata user as owner if they were removed from the organization.)
