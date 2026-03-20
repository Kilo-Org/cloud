# KiloClaw Billing

## Status

Draft -- generated from branch `jdp/kiloclaw-billing` on 2026-03-13.
Updated 2026-03-19 -- pricing and trial duration changes.

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
plan. Each plan can be funded either through the external payment
provider (Stripe) or by deducting from the user's KiloPass credit
balance. The commit plan auto-renews for successive six-month periods
at the same price; users may switch between plans at any time. New
users who provision an instance without subscribing first automatically
receive a 7-day free trial. A legacy earlybird purchase also grants
access until a fixed expiry date. A periodic background job enforces
expiry, credit renewal, suspension, and eventual instance destruction
when access lapses, with email notifications at each stage.

## Rules

### Plans

1. The system MUST support exactly two user-facing subscription plans:
   commit and standard. A trial plan exists internally but is created
   automatically at provisioning time, not selected by the user.
2. A trial plan MUST last 7 calendar days from the moment it is created.
3. A commit plan MUST cover a six-calendar-month billing period.
4. A standard plan MUST bill on a monthly recurring cycle.
5. The system MUST enforce at most one subscription record per user.
6. The user-visible price for each plan MUST be identical regardless
   of payment source.
7. Stripe-funded billing MUST use configured payment-provider price
   identifiers. Credit-funded billing MUST use internal microdollar
   amounts that correspond to the same plan prices.
8. The system MUST fail with an error if required billing
   configuration for the selected plan is missing. For Stripe-funded
   billing this includes the payment-provider price identifier.
9. Each plan MUST support two payment sources: payment-provider
   (Stripe) and credits. Plan pricing, access rules, failure handling,
   and suspension/destruction timelines MUST be identical regardless
   of payment source. The payment mechanism and the internal
   implementation of plan switching and cancellation differ by payment
   source (see Plan Switching and Cancellation and Reactivation).

### Payment Sources

1. The system MUST record a payment source for each subscription. The
   value MUST be either `stripe` or `credits`.
2. A subscription with payment source `stripe` MUST have a non-null
   payment provider subscription ID. A subscription with payment source
   `credits` MUST have a null payment provider subscription ID.
3. A subscription with payment source `credits` MUST record a credit
   renewal timestamp indicating when the next credit deduction is due.
4. At most one subscription record per user is allowed regardless of
   payment source (see Plans rule 5).
5. The system MUST NOT allow a user to hold simultaneous subscriptions
   with different payment sources. Switching between payment sources
   is deferred to a future phase; users who wish to change payment
   source MUST cancel their current subscription and re-enroll after
   the billing period ends.

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

### Subscription Checkout (Stripe)

1. The system MUST reject a checkout request if the user already has a
   subscription in active, past-due, or unpaid status.
2. The system MUST allow checkout when the existing subscription status
   is trialing or canceled.
3. The system MUST verify with the payment provider that no subscription
   in active or trialing (delayed-billing) status already exists for the
   customer before creating a new checkout session, to guard against
   concurrent checkouts. This check does not cover provider-side
   subscriptions in past-due status.
4. The system MUST NOT allow promotional codes for either plan.
5. The system MUST apply a provider-configured first-month discount
   coupon when creating a standard plan checkout session.
6. When a configurable billing start date is set and is in the future,
   the system MUST create the subscription with a delayed billing period
   that begins on that date.
7. When the billing start date is unset or is in the past, the system
   MUST start billing immediately with no delayed period.
8. The system SHOULD include referral tracking data in checkout sessions
   when a referral cookie is present.
9. The system SHOULD attempt to expire open checkout sessions tagged as
   KiloClaw before creating a new checkout session, so users who
   abandoned a previous checkout can start fresh. Expiration is
   best-effort: errors from the payment provider (e.g. the session was
   already expired or completed) MUST be swallowed. Duplicate open
   sessions from concurrent requests are tolerable because each requires
   independent user action to complete, and rule 3 prevents duplicate
   subscriptions.

### Credit Enrollment

1. The system MUST reject a credit enrollment request if the user
   already has a subscription in active, past-due, or unpaid status.
   This is the same guard as Subscription Checkout rule 1.
2. The system MUST allow credit enrollment when the existing
   subscription status is trialing or canceled.
3. The system MUST verify that the user's effective credit balance is
   sufficient to cover the first billing period before proceeding:
   25,000,000 microdollars for the standard plan (one month) or
   54,000,000 microdollars for the commit plan (six months paid
   upfront). The effective balance MUST be computed as the current
   credit balance plus the projected bonus credits the user would earn
   from the deduction. The projected bonus MUST be obtained by querying
   the Kilo Pass entitlement system for the bonus that would result
   from the deduction amount, without committing any credit award.
   When the user has no Kilo Pass, the effective balance equals the
   current credit balance.
4. The system MUST check whether the user was previously suspended
   (has a non-null suspension timestamp) before mutating the
   subscription row.
5. The credit deduction and subscription upsert MUST be performed in
   a single database transaction so that a crash cannot
   leave the user with deducted credits and no active subscription.
   Within this transaction the system MUST:
   a. Insert a negative credit transaction for the first period's cost.
   The insertion MUST use a period-encoded idempotency key (see
   Credit Renewal rule 2) with conflict-safe semantics. The key
   MUST distinguish the plan and billing period, for example
   `kiloclaw-subscription:YYYY-MM` for standard or
   `kiloclaw-subscription-commit:YYYY-MM` for commit. If the
   insertion detects a duplicate, the system MUST abort the
   enrollment as a duplicate attempt.
   b. Atomically decrement the user's acquired credit balance by the
   deducted amount.
   c. Create or upsert the subscription record with payment source set
   to `credits`, status set to active, the billing period set from
   the current time, the credit renewal timestamp set to the period
   end, and the payment provider subscription ID set to null.
   d. The subscription upsert MUST clear the past-due-since timestamp
   and set the status to active, but MUST NOT clear the suspension
   timestamp or destruction deadline at this step. If the user was
   previously suspended, those columns are needed as a signal for
   the auto-resume procedure in rule 7.
   If the transaction is interrupted, the database MUST roll back all
   operations so that a retry can re-attempt without the idempotency
   key blocking it.
6. After the enrollment transaction commits (rule 5), the system MUST
   trigger a bonus credit evaluation. This step determines whether the
   user's cumulative spend now qualifies for additional bonus credits
   under their Kilo Pass entitlement and, if so, awards them. The
   user's acquired credit balance MAY be temporarily negative between
   the deduction in rule 5b and the bonus award; other
   balance-observing systems (monitoring, display, renewal sweeps)
   MUST tolerate transient negative balances from this flow. When the
   user has no Kilo Pass, this step is a no-op. If the bonus
   evaluation fails or times out, the system MUST log the failure but
   MUST NOT roll back the enrollment. The missed bonus SHOULD be
   recovered by a subsequent reconciliation process; this spec does
   not define that process.
7. If the user was previously suspended (per rule 4), the system MUST
   call the auto-resume procedure after the transaction commits to
   restart the instance, clear suspension-cycle email log entries, and
   clear the suspension timestamp and destruction deadline. This MUST
   happen after the subscription row is in active state. If the
   process crashes before auto-resume completes, the non-null
   suspension timestamp on an active subscription signals that
   resume is still required; the next background job run MUST
   detect this state and retry the auto-resume.
8. For the commit plan, the system MUST record a commit-period end
   date six calendar months from enrollment, consistent with Commit
   Plan Lifecycle rule 2.

### Commit Plan Lifecycle

1. A commit subscription MUST remain on the commit price in the payment
   provider; the system MUST NOT create a schedule to auto-transition
   the subscription to the standard plan.
2. When a commit subscription is created, the system MUST record a
   commit-period end date six calendar months from the billing start.
   When a delayed-billing period is configured, the six months MUST
   start from the delayed-billing end date, not from subscription
   creation.
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
3. For Stripe-funded subscriptions, a switch from standard to commit
   MUST create a payment-provider schedule with two phases: current
   plan until period end, then commit (open-ended).
4. For Stripe-funded subscriptions, a switch from commit to standard
   MUST create a payment-provider schedule with two phases: current
   plan until period end, then standard.
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
9. For credit-funded subscriptions, a plan switch MUST NOT create a
   payment-provider schedule. The system MUST record the scheduled
   plan locally and apply it at the next period boundary during
   the credit renewal sweep.
10. For credit-funded subscriptions, canceling a plan switch MUST clear
    the locally recorded scheduled plan. No payment-provider API call
    is needed.
11. Cross-payment-source switching (credits to Stripe or vice versa) is
    NOT RECOMMENDED in v1. Users who wish to change payment source
    MUST cancel their current subscription and re-enroll after the
    billing period ends.

### Cancellation and Reactivation

1. The system MUST reject a cancellation request if no active
   subscription exists. For Stripe-funded subscriptions, the payment
   provider subscription ID MUST be present. For credit-funded
   subscriptions, the payment source MUST be `credits` and status
   MUST be active.
2. The system MUST reject a cancellation request if cancellation is
   already pending.
3. When canceling a Stripe-funded subscription that has a pending
   schedule, the system MUST release the schedule before setting the
   cancel-at-period-end flag.
4. Cancellation MUST NOT terminate access immediately; access MUST
   continue until the current billing period ends.
5. For Stripe-funded subscriptions, the system MUST set the
   cancel-at-period-end flag on both the payment provider and in the
   local database.
6. For credit-funded subscriptions, the system MUST set the
   cancel-at-period-end flag in the local database only. No payment
   provider API call is needed. The credit renewal sweep handles the
   period-end transition (see Credit Renewal rule 5).
7. The system MUST allow reactivation of a subscription that is pending
   cancellation.
8. On reactivation of a Stripe-funded subscription, the system MUST
   clear the cancel-at-period-end flag on both the payment provider
   and in the local database.
9. On reactivation of a credit-funded subscription, the system MUST
   clear the cancel-at-period-end flag in the local database only.

### Billing Lifecycle Background Job

1. The background job MUST be protected by an authorization secret;
   requests without valid authorization MUST receive an unauthorized
   response.
2. Each sweep in the background job MUST process users independently;
   a failure for one user MUST NOT prevent processing of other users.
3. All errors during sweep processing MUST be captured for monitoring.
4. The credit renewal sweep MUST run before all other sweeps so that
   credit-funded subscriptions are renewed (or marked past-due, or
   canceled) before the existing sweeps evaluate expiry and suspension.
5. The background job MUST detect credit-funded subscriptions in
   active status that still have a non-null suspension timestamp
   (indicating a prior auto-resume was interrupted) and retry the
   auto-resume procedure for those subscriptions.

### Credit Renewal

1. The credit renewal sweep MUST select all subscriptions where
   payment source is `credits`, status is active or past-due, and
   the credit renewal timestamp is at or before the current time.
2. Each credit deduction MUST use a period-encoded category key
   with a uniqueness constraint. The key MUST be derived from the
   subscription's credit renewal timestamp (the period boundary being
   charged for), not from the current wall-clock time. The format
   MUST distinguish the renewal cadence and plan, for example
   `kiloclaw-subscription:2026-04` for a standard renewal or
   `kiloclaw-subscription-commit:2026-04` for a commit renewal.
   The insertion MUST use conflict-safe semantics so that a duplicate
   key is silently ignored rather than causing an error.
   The sweep MUST advance the subscription by exactly one billing
   period per successful deduction. If the subscription has fallen
   behind by multiple periods (e.g., the sweep was delayed), the
   sweep MUST NOT attempt to catch up multiple periods in a single
   run. Instead, each successive sweep run advances by one period
   until the credit renewal timestamp is in the future. This ensures
   each period produces a distinct idempotency key.
3. The credit deduction insert and subscription period advancement
   MUST be performed in a single database transaction. If the
   transaction is interrupted, the database MUST roll back both
   operations so that a retry can re-attempt the deduction without
   the idempotency key blocking it.
4. If the deduction insert returns zero affected rows (duplicate key
   from a prior committed transaction), the subscription update
   within the same transaction is a no-op (same values). The system
   MUST skip further processing for that row.
5. If the subscription has cancel-at-period-end set, the sweep MUST
   skip the deduction, set the subscription status to canceled, and
   clear the cancel-at-period-end flag. The billing period MUST NOT
   be advanced; current-period-end retains its existing value.
   Subscription Period Expiry Enforcement rule 1 handles suspension
   once current-period-end has passed.
6. When the effective balance (as defined in Credit Enrollment rule 3)
   is sufficient and the deduction succeeds (one affected row), the
   system MUST atomically decrement the user's acquired credit balance
   and advance the subscription's billing period (current-period-start,
   current-period-end, credit-renewal-timestamp) within the same
   transaction. After the transaction commits, the system MUST trigger
   a bonus credit evaluation as described in Credit Enrollment rule 6.
   The user's acquired credit balance MAY be temporarily negative
   between the deduction and the bonus award. If the bonus evaluation
   fails or times out, the system MUST log the failure and continue
   processing the row; the missed bonus SHOULD be recovered by a
   subsequent reconciliation process.
7. When a commit-plan renewal succeeds and the commit-period end date
   has been reached, the system MUST extend the commit-period end date
   by six calendar months from the previous boundary.
8. When the deduction succeeds and the subscription was previously
   past-due, the system MUST clear the past-due-since timestamp and
   set the status to active.
9. When the deduction succeeds, the subscription was past-due, and
   the suspension timestamp is null (grace-period recovery), the
   system MUST delete the credit-renewal-failed email log entry for
   the user so that future failures can re-trigger the notification.
10. When the deduction succeeds, the subscription was past-due, and
    the suspension timestamp is non-null (suspended recovery), the
    system MUST call the auto-resume procedure to restart the instance,
    clear the suspension-cycle email log entries (including the
    credit-renewal-failed entry), and clear the suspension columns.
11. When the effective balance (as defined in Credit Enrollment
    rule 3) is insufficient, the system MUST first check whether
    the user has auto top-up enabled and whether a top-up has
    already been triggered for the current renewal period. If auto
    top-up is available and has NOT yet been triggered for this
    period, the system MUST persist the durable marker (the credit
    renewal timestamp of the period being charged) on the
    subscription row BEFORE triggering the auto top-up call. This
    ensures that if the process crashes after the payment-provider
    invoice is created but before the marker write would otherwise
    have committed, the marker already exists and prevents a
    duplicate top-up on the next sweep. The auto top-up call MUST
    include a deterministic idempotency key derived from the user ID
    and the credit renewal timestamp of the period being charged, so
    that the payment provider de-duplicates repeated requests for the
    same renewal period. After the marker is persisted and the
    top-up triggered, the system MUST skip the row without changing
    any other state (fire-and-skip). The next sweep run MUST
    re-evaluate the row after the top-up webhook has credited the
    balance. The marker MUST be cleared when the billing period
    advances (successful deduction) or when the subscription is
    canceled.
12. When the effective balance is still insufficient (per rule 11)
    and auto top-up is not available, has been disabled due to a
    prior card decline, or was already triggered for the current
    period (marker present), the system MUST set the subscription
    status to past-due and record a past-due-since timestamp
    (preserving any existing value). Past-Due Payment Enforcement
    rule 1 handles suspension after 14 days.
13. When the effective balance is insufficient and the system enters the past-due
    path (rule 12), the system MUST send a credit-renewal-failed
    notification, subject to the standard email idempotency rules.
    The notification MUST NOT be sent when the system takes the
    fire-and-skip path (rule 11).
14. The credit renewal sweep MUST handle three distinct recovery paths
    in a single pass: active renewal (status active, renewal due),
    grace-period recovery (status past-due, not suspended), and
    suspended recovery (status past-due, suspended). Separate sweeps
    are not needed.
15. When a credit-funded subscription has a scheduled plan change and
    the current period has ended, the renewal sweep MUST determine
    the effective plan and cost before the deduction, but MUST apply
    the plan mutation inside the same database transaction as the
    credit deduction and period advancement (rule 3). This ensures
    that a crash between the plan switch and the charge cannot leave
    the subscription on the new plan without a corresponding
    deduction. Applying the plan change MUST:
    - Update the subscription's plan to the scheduled plan value.
    - Clear the scheduled-plan and scheduled-by fields.
    - If switching to commit: set the commit-period end date to six
      calendar months from the transition date, consistent with Plan
      Switching rule 7.
    - If switching to standard: clear the commit-period end date.
      After the plan change is applied, subsequent sweeps MUST NOT
      reapply it (the cleared scheduled-plan field prevents this).

### Auto Top-Up Integration with Credit Renewal

1. The auto top-up flow is asynchronous: triggering auto top-up
   creates and pays a payment-provider invoice, but credits are only
   applied when the invoice-paid webhook fires. The credit renewal
   sweep MUST NOT wait for the top-up to complete.
2. When the sweep triggers auto top-up for a row, the sweep MUST skip
   that row entirely without setting past-due status, sending failure
   notifications, or advancing the billing period.
3. On the next sweep run, if the auto top-up succeeded and the
   effective balance (as defined in Credit Enrollment rule 3) is now
   sufficient, the sweep MUST proceed with the normal deduction. If
   the effective balance is still insufficient, the sweep MUST enter
   the insufficient-balance path (Credit Renewal rule 11).
4. The system MUST enter the insufficient-balance path (not fire-and-
   skip) when auto top-up is not enabled, has been disabled due to a
   prior card decline, or was already triggered for the current
   renewal period (as indicated by the durable marker described in
   Credit Renewal rule 11) and the effective balance remains
   insufficient.

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
   This applies equally to Stripe-funded and credit-funded subscriptions.
2. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
3. The system MUST send a payment-suspended notification.
4. The 14-day threshold MUST be measured from the time the subscription
   first entered past-due status, not from the last database update.
   For credit-funded subscriptions, past-due status is set by the
   credit renewal sweep; for Stripe-funded subscriptions, it is set
   by the payment provider webhook.

### Email Notifications

1. Each notification type MUST be sent at most once per user per
   lifecycle event.
2. If a notification send fails, the system MUST allow the notification
   to be retried on the next background job run.
3. The system MUST prevent concurrent duplicate sends of the same
   notification to the same user.
4. The system MUST support a credit-renewal-failed notification type
   for credit-funded subscriptions. This notification MUST be sent
   when the credit renewal sweep enters the insufficient-balance path
   and MUST be subject to the same idempotency rules as other
   notification types.

### Auto-Resume on Payment Recovery

1. When a subscription transitions to active while the user is
   suspended, the system MUST attempt to start the user's instance.
   For Stripe-funded subscriptions, this transition is detected by
   the payment provider webhook. For credit-funded subscriptions,
   this transition is detected by the credit renewal sweep when a
   past-due subscription with a non-null suspension timestamp is
   successfully renewed.
2. If the instance start attempt fails, the system MUST log the failure
   and MUST NOT clear the suspension timestamp or destruction deadline.
   Leaving these fields intact allows the background job (Billing
   Lifecycle Background Job rule 5) to detect the incomplete
   auto-resume and retry on the next sweep.
3. The system MUST clear the suspension timestamp and destruction
   deadline only after a successful instance start (or when no instance
   exists to restart).
4. The system MUST clear email log entries for suspension, destruction,
   and credit-renewal-failed notifications so they can fire again in a
   future suspension cycle.
5. The system MUST NOT clear email log entries for trial or earlybird
   warning notifications, as those are one-time events.

### Payment Provider Status Mapping

1. When the payment provider reports a subscription as "trialing"
   (delayed billing), the system MUST map this to active status
   internally, since delayed billing is not a product-level trial.
2. When the payment provider reports "incomplete" or "paused" status,
   the system MUST map these to terminal statuses (unpaid or canceled
   respectively).
3. Credit-funded subscriptions have no payment provider status. Their
   status MUST be managed entirely by the credit renewal sweep and
   the billing lifecycle sweeps. Payment provider status mapping rules
   MUST NOT apply to credit-funded subscriptions.

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
   cancel-at-period-end, period end, commit end, scheduled plan,
   payment source) when a paid subscription exists. Subscription data
   MUST be included when either a payment provider subscription ID is
   present or the payment source is `credits`; it MUST NOT be
   suppressed solely because a payment provider subscription ID is
   absent.
5. When the payment source is `credits`, the billing status MUST also
   include the credit renewal timestamp and the renewal cost for the
   next billing period so the frontend can display the next renewal
   date and amount due.
6. The billing status MUST include earlybird data (expiry date, days
   remaining) when the user has an earlybird purchase.
7. The billing status MUST include instance data (whether an
   undestroyed instance exists, suspension timestamp, destruction
   deadline, and destroyed flag) when any instance record exists.

### Billing Portal

1. The system MUST allow users with Stripe-funded subscriptions to
   access the payment provider's billing portal to manage their payment
   methods.
2. The billing portal session MUST redirect the user back to the
   dashboard upon completion.
3. The billing portal MUST NOT be offered for credit-funded
   subscriptions. The frontend MUST NOT call the billing portal
   endpoint when the user's payment source is `credits`; it MUST
   direct the user to the credit top-up flow instead.

### User Data Deletion

1. When a user is soft-deleted, the system MUST delete all subscription
   records for that user.
2. When a user is soft-deleted, the system MUST delete all email
   notification log entries for that user.
3. Credit transaction records created by subscription deductions are
   managed by the credit system's own data deletion rules, not by
   KiloClaw billing. This spec does not impose additional deletion
   requirements on credit transaction records.

### Changelog

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
