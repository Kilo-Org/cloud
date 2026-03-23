# KiloClaw Billing

## Status

Draft -- generated from branch `jdp/kiloclaw-billing` on 2026-03-13.
Updated 2026-03-19 -- pricing and trial duration changes.
Updated 2026-03-20 -- promotional codes and introductory pricing.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Overview

KiloClaw Billing manages the subscription lifecycle for KiloClaw hosted
instances. Users access the service through one of two subscription
plans: a discounted six-month commit plan or a month-to-month standard
plan. The commit plan auto-renews for successive six-month periods at
the same price; users may switch between plans at any time. New users
who provision an instance without subscribing first automatically
receive a 7-day free trial. A legacy earlybird purchase also grants
access until a fixed expiry date. A periodic background job enforces
expiry, suspension, and eventual instance destruction when access
lapses, with email notifications at each stage.

## Rules

### Plans

1. The system MUST support exactly two user-facing subscription plans:
   commit and standard. A trial plan exists internally but is created
   automatically at provisioning time, not selected by the user.
2. A trial plan MUST last 7 calendar days from the moment it is created.
3. A commit plan MUST cover a six-calendar-month billing period.
4. A standard plan MUST bill on a monthly recurring cycle.
5. The system MUST enforce at most one subscription record per user.
6. Plan pricing MUST be configured in the payment provider; the system
   MUST NOT independently validate or enforce specific price amounts.
7. The system MUST fail with an error at checkout time if a required
   plan price identifier is not configured.

### Standard Plan Introductory Pricing

1. New standard plan subscribers who do not have a prior canceled paid
   subscription MUST receive an introductory price for their first
   billing period. A canceled trial does not count as a prior paid
   subscription. Returning subscribers with a previously canceled paid
   subscription MUST receive the regular standard price.
2. The system MUST automatically transition introductory-price
   subscribers to the regular standard price at the end of the
   introductory billing period.
3. The automatic price transition MUST be transparent to the user: it
   MUST NOT appear as a pending plan switch in billing status and MUST
   NOT prevent the user from initiating a plan switch or canceling.
4. Failure to set up the automatic price transition during subscription
   creation MUST NOT block checkout completion.

### Trial Eligibility and Creation

1. A trial MUST only be created automatically when a user provisions an
   instance for the first time. There is no user-facing "start trial"
   action; the trial is bootstrapped during provisioning.
2. The system MUST create a trial only if the user has no existing
   subscription record and no earlybird purchase. The instance-record
   check is not needed at provisioning time because provisioning itself
   creates the instance, but the billing status endpoint includes the
   instance check as defense in depth.
3. When a trial is created, the system MUST record the trial start
   timestamp and an end timestamp exactly 7 days later.
4. The system MUST NOT require a credit card to start a trial.

### Access Control

1. The system MUST grant access when the subscription status is active.
2. The system MUST grant access when the subscription status is past-due
   and the subscription has not been suspended.
3. The system MUST grant access when the subscription status is trialing
   and the trial end date is in the future.
4. The system MUST grant access when the user holds a legacy earlybird
   purchase and the earlybird expiry date is in the future.
5. When earlybird access expires, the system MUST NOT automatically
   transition the user to a trial or any other plan; the user MUST
   manually subscribe to regain access.
6. The system MUST deny access and return a forbidden error when none of
   the above conditions are met.
7. All instance lifecycle operations (start, stop, destroy, provision,
   configuration changes) MUST be gated behind the access check, except
   for provisioning which uses the trial-bootstrap flow.

### Subscription Checkout

1. The system MUST reject a checkout request if the user already has a
   subscription in active, past-due, or unpaid status.
2. The system MUST allow checkout when the existing subscription status
   is trialing or canceled.
3. The system MUST verify with the payment provider that no subscription
   in active or trialing status already exists for the customer before
   creating a new checkout session, to guard against concurrent
   checkouts. This check does not cover provider-side subscriptions in
   past-due status.
4. The system MUST allow promotional codes on checkout for both plans.
5. For standard plan checkout, the system MUST use the introductory
   price when the user has no prior canceled paid subscription, and the
   regular price when the user has a previously canceled paid
   subscription (see Standard Plan Introductory Pricing).
6. The system SHOULD include referral tracking data in checkout sessions
   when a referral cookie is present.
7. The system SHOULD attempt to expire open checkout sessions tagged as
   KiloClaw before creating a new checkout session, so users who
   abandoned a previous checkout can start fresh. Expiration is
   best-effort: errors from the payment provider (e.g. the session was
   already expired or completed) MUST be swallowed. Duplicate open
   sessions from concurrent requests are tolerable because each requires
   independent user action to complete, and rule 3 prevents duplicate
   subscriptions.

### Commit Plan Lifecycle

1. A commit subscription MUST remain on the commit price in the payment
   provider; the system MUST NOT create a schedule to auto-transition
   the subscription to the standard plan.
2. When a commit subscription is created, the system MUST record a
   commit-period end date six calendar months from the billing start.
   For pre-launch subscriptions that had a delayed-billing trial_end,
   the six months starts from that trial boundary.
3. When a subscription update is received and the commit-period end
   date is in the past, the system MUST extend it by six calendar
   months from the previous boundary, keeping the subscription on the
   commit plan.
4. When a user-initiated plan-switch schedule completes or is
   released/canceled, the system MUST apply or clear the schedule
   tracking fields as appropriate (see Plan Switching).

### Plan Switching

1. The system MUST allow switching between commit and standard plans only
   for active subscriptions.
2. The system MUST reject a switch if the user is already on the
   requested plan.
3. A switch from standard to commit MUST create a schedule with two
   phases: current plan until period end, then commit (open-ended).
4. A switch from commit to standard MUST create a schedule with two
   phases: current plan until period end, then standard.
5. For a standard-to-commit switch, the recorded scheduled-plan MUST
   be commit.
6. When a plan-switch schedule reaches a terminal status (completed or
   released) and the local schedule tracking fields still reference
   the schedule, the system MUST apply the scheduled plan and update
   the commit-period end date accordingly. Intentional releases
   (cancellation or cancel-plan-switch) clear the local schedule
   reference before the webhook fires, so the schedule event handler
   MUST NOT match those rows.
7. When a standard-to-commit switch takes effect, the system MUST set
   the commit-period end date to six calendar months from the
   transition date.
8. The system MUST allow cancellation of user-initiated plan switches.
9. The system MUST reject a plan switch if a user-initiated plan switch
   is already pending.
10. If an automatic price transition is pending when the user requests a
    plan switch, the system MUST replace the automatic transition with
    the user's requested switch.
11. After canceling a user-initiated plan switch, if the subscription is
    still on the introductory price, the system MUST restore the
    automatic price transition. Failure to restore the transition MUST
    NOT prevent the switch cancellation from succeeding.

### Cancellation and Reactivation

1. The system MUST reject a cancellation request if no active
   subscription with a payment provider ID exists.
2. The system MUST reject a cancellation request if cancellation is
   already pending.
3. When canceling a subscription that has a pending schedule — whether
   a user-initiated plan switch or an automatic price transition — the
   system MUST release the schedule before setting the
   cancel-at-period-end flag.
4. Cancellation MUST NOT terminate access immediately; access MUST
   continue until the current billing period ends.
5. The system MUST allow reactivation of a subscription that is pending
   cancellation.
6. On reactivation, the system MUST clear the cancel-at-period-end flag.
7. On reactivation, if the subscription is still on the introductory
   price, the system MUST restore the automatic price transition.
   Failure to restore the transition MUST NOT prevent the reactivation
   from succeeding.

### Billing Lifecycle Background Job

1. The background job MUST be protected by an authorization secret;
   requests without valid authorization MUST receive an unauthorized
   response.
2. Each sweep in the background job MUST process users independently;
   a failure for one user MUST NOT prevent processing of other users.
3. All errors during sweep processing MUST be captured for monitoring.
4. The background job MUST detect active subscriptions on the
   introductory price that have no automatic price transition pending
   and MUST set up the missing transition.

### Trial Expiry Warnings

1. When a trial has 2 or fewer days remaining and has not been
   suspended, the system MUST send a trial-ending-soon notification.
2. When a trial has 1 or fewer days remaining, the system MUST send a
   more urgent trial-expires-tomorrow notification instead of the
   2-day notification.

### Earlybird Expiry Warnings

1. When the earlybird expiry date is 14 or fewer days away, the system
   MUST send a warning notification to earlybird users who do not have
   an active or trialing subscription.
2. When the earlybird expiry date is 1 or fewer days away, the system
   MUST send a more urgent expires-tomorrow notification.

### Trial Expiry Enforcement

1. When a trial's end date has passed and the subscription is still in
   trialing status (not yet suspended), the system MUST stop the user's
   instance.
2. The system MUST transition the subscription to canceled status.
3. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
4. The system MUST send a trial-suspended notification.
5. If the instance stop operation fails (e.g., no instance exists), the
   system MUST still proceed with the status transition.

### Subscription Period Expiry Enforcement

1. When a canceled subscription's billing period has ended and the
   subscription has not been suspended, the system MUST stop the user's
   instance.
2. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
3. The system MUST send a subscription-suspended notification.

### Destruction Warning

1. When a suspended subscription's destruction deadline is 2 or fewer
   days away, the system MUST send a destruction-warning notification.

### Instance Destruction

1. When a suspended subscription's destruction deadline has passed, the
   system MUST destroy the user's instance.
2. The system MUST mark all active instance records as destroyed.
3. The system MUST clear the destruction deadline after destruction.
4. The system MUST send an instance-destroyed notification.
5. If the destroy operation fails (e.g., no instance exists), the system
   MUST still proceed with the state transition.

### Past-Due Payment Enforcement

1. When a subscription has been in past-due status for more than 14 days
   and has not been suspended, the system MUST stop the user's instance.
2. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
3. The system MUST send a payment-suspended notification.
4. The 14-day threshold MUST be measured from the time the subscription
   first entered past-due status, not from the last database update.

### Email Notifications

1. Each notification type MUST be sent at most once per user per
   lifecycle event.
2. If a notification send fails, the system MUST allow the notification
   to be retried on the next background job run.
3. The system MUST prevent concurrent duplicate sends of the same
   notification to the same user.

### Auto-Resume on Payment Recovery

1. When a subscription transitions to active while the user is
   suspended, the system MUST attempt to start the user's instance.
2. If the instance start attempt fails, the system MUST log the failure
   but MUST still proceed with clearing the suspension state. The system
   does not retry the instance start.
3. The system MUST clear the suspension timestamp and destruction
   deadline.
4. The system MUST clear email log entries for suspension and destruction
   notifications so they can fire again in a future suspension cycle.
5. The system MUST NOT clear email log entries for trial or earlybird
   warning notifications, as those are one-time events.

### Payment Provider Status Mapping

1. When the payment provider reports a subscription as "trialing"
   (e.g. pre-launch delayed billing), the system MUST map this to
   active status internally, since delayed billing is not a
   product-level trial.
2. When the payment provider reports "incomplete" or "paused" status,
   the system MUST map these to terminal statuses (unpaid or canceled
   respectively).

### Billing Status Reporting

1. The billing status response MUST include whether the user currently
   has access and the reason for that access (trial, subscription, or
   earlybird).
2. The system MUST report trial eligibility as true only when the user
   has no instance records at all (including destroyed instances), no
   subscription record, and no earlybird purchase.
3. The billing status MUST include trial data (start, end, days
   remaining, expired flag) when a trial exists or existed.
4. The billing status MUST include subscription data (plan, status,
   cancel-at-period-end, period end, commit end, scheduled plan) when a
   paid subscription exists.
5. The billing status MUST include earlybird data (expiry date, days
   remaining) when the user has an earlybird purchase.
6. The billing status MUST include instance data (whether an
   undestroyed instance exists, suspension timestamp, destruction
   deadline, and destroyed flag) when any instance record exists.

### Billing Portal

1. The system MUST allow users to access the payment provider's billing
   portal to manage their payment methods.
2. The billing portal session MUST redirect the user back to the
   dashboard upon completion.

### User Data Deletion

1. When a user is soft-deleted, the system MUST delete all subscription
   records for that user.
2. When a user is soft-deleted, the system MUST delete all email
   notification log entries for that user.

### Changelog

#### 2026-03-21 -- Remove delayed-billing start date

- Removed configurable billing start date (`STRIPE_KILOCLAW_BILLING_START`)
  and associated checkout rules (former rules 6–7). New subscriptions now
  always bill immediately.
- Pre-launch subscriptions created with a delayed `trial_end` are still
  handled correctly; the trialing→active status mapping remains until those
  subscriptions transition.

#### 2026-03-20 -- Promotional codes and introductory pricing

Previous values:

- Standard plan first-month discount: coupon applied at checkout
- Promotional codes: not allowed on either plan

New values:

- Standard plan first-month discount: introductory price with automatic
  transition to regular price at period end
- Promotional codes: allowed on both plans at checkout

#### 2026-03-19 -- Pricing and trial changes

Previous values:

- Trial duration: 30 days
- Standard plan: $25/month, promotional codes allowed
- Commit plan: $54/6 months
- Trial expiry warning: 5 days before expiry

New values:

- Trial duration: 7 days (existing trials keep their original end date)
- Standard plan: $9/month with $4 first month via coupon, no promotional codes
- Commit plan: $48/6 months
- Trial expiry warning: 2 days before expiry
- 14 existing subscribers migrated to new pricing at next billing cycle

## Error Handling

1. When a background job sweep encounters an error for a specific user,
   the system MUST log the error and continue processing remaining
   users.
2. When an instance stop or destroy operation fails during a lifecycle
   sweep, the system MUST log the failure and proceed with the
   subscription state transition regardless.
3. When a schedule release fails during cancellation with an error
   indicating the schedule is already released or canceled, the system
   MUST treat this as success and proceed with clearing local state.
4. When a schedule release fails during cancellation for any other
   reason (e.g., transient API error), the system MUST abort the
   cancellation and return an error to the user.
