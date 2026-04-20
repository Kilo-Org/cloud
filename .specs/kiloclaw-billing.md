# KiloClaw Billing

## Role of This Document

This spec defines the business rules and invariants for KiloClaw
billing. It is the source of truth for _what_ the system must
guarantee — valid states, ownership boundaries, correctness
properties, and user-facing behavior. It deliberately does not
prescribe _how_ to implement those guarantees: handler names, column
layouts, conflict-resolution strategies, null-safety patterns, and
other implementation choices belong in plan documents and code, not
here.

## Status

Draft -- generated from branch `jdp/kiloclaw-billing` on 2026-03-13.
Updated 2026-03-19 -- pricing and trial duration changes.
Updated 2026-03-20 -- Stripe-to-credits hybrid billing model.
Updated 2026-03-24 -- credits-first billing, per-instance subscriptions,
Kilo Pass upsell checkout.
Updated 2026-03-27 -- subscription reassignment on re-provision.
Updated 2026-04-16 -- successor subscription rows on personal reprovision.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Legacy Stripe subscription**: A subscription with payment source
  `stripe` and a non-null payment provider subscription ID. The
  payment provider owns all state.
- **Hybrid subscription**: A subscription with payment source
  `credits` and a non-null payment provider subscription ID. The
  payment provider collects payment; the local billing engine tracks
  the period via credits.
- **Pure credit subscription**: A subscription with payment source
  `credits` and a null payment provider subscription ID. The local
  credit renewal sweep owns all state.
- **Stripe-funded subscription**: Any subscription with a non-null
  payment provider subscription ID (legacy Stripe or hybrid). Used
  throughout this spec to mean "has Stripe billing infrastructure"
  regardless of payment source.
- **Invoice settlement**: The process triggered by a paid KiloClaw
  invoice from the payment provider that converts the payment into
  balanced credit ledger entries and advances the subscription
  period. Defined in Stripe-Funded Credit Settlement.
- **Dunning state**: A non-active payment failure status reported by
  the payment provider (past-due, unpaid, or defensive terminal
  fallback).
- **Credit balance**: The user's available credit balance, computed as
  `total_microdollars_acquired - microdollars_used`. Credits enter the
  system by incrementing the acquired counter (purchases, grants,
  bonuses). Credits leave the system by incrementing the used counter
  (inference usage, pure-credit hosting deductions). The balance MUST
  NOT change as a result of Stripe-funded settlement (see
  Stripe-Funded Credit Settlement rule 3), which achieves
  balance-neutrality by incrementing and then decrementing the
  acquired counter.
- **Credit spend**: Any operation that increments the used counter.
  Both inference usage and pure-credit KiloClaw hosting deductions are
  credit spend. Stripe-funded settlement deductions are NOT credit
  spend; they are balance-neutral bookkeeping entries. Credit spend
  counts toward the Kilo Pass bonus unlock threshold.

## Overview

KiloClaw Billing manages the subscription lifecycle for KiloClaw hosted
instances. Every KiloClaw subscription is funded by credits: a
subscription is a recurring credit deduction tied to a specific
instance. Users access the service through one of two hosting plans: a
discounted six-month commit plan or a month-to-month standard plan.

The recommended checkout path is Kilo Pass, which adds credits to the
user's balance via a Stripe subscription. Those credits fund both
hosting and inference. Users who only want hosting (using free inference
models) can subscribe to a standalone hosting plan via Stripe; the
system routes each Stripe payment through the credit ledger as a
balanced deposit-and-deduction, so all hosting transactions appear in
the credit system regardless of funding source.

Stripe-funded subscriptions are lazily converted to a hybrid state on
their first settled invoice: the system records the payment source as
`credits` while preserving the payment provider subscription ID,
allowing Stripe to continue collecting payment while the local billing
engine tracks the period via credits. The commit plan auto-renews for
successive six-month periods at the same price; users may switch
between plans at any time.

Each subscription is scoped to a specific instance. A user MAY have
multiple instances, each with its own subscription and renewal cycle.
All subscriptions deduct from the same user credit balance.

New users who provision an instance without subscribing first
automatically receive a 7-day free trial. Legacy
`kiloclaw_earlybird_purchases` rows without canonical subscription rows
MUST NOT mint fresh trial access and instead require manual
remediation. Canonical earlybird subscription rows continue to grant
access until their recorded expiry.
A periodic background job enforces expiry, credit renewal, suspension,
and eventual instance destruction when access lapses, with email
notifications at each stage.

## Rules

### Plans

1. The system MUST support exactly two user-facing subscription plans:
   commit and standard. A trial plan exists internally but is created
   automatically at provisioning time, not selected by the user.
2. A trial plan MUST last 7 calendar days from the moment it is created.
3. A commit plan MUST cover a six-calendar-month billing period.
4. A standard plan MUST bill on a monthly recurring cycle.
5. The system MUST enforce at most one subscription record per
   instance. Each subscription MUST reference the instance it funds.
   A user MAY have multiple instances, each with its own subscription.
6. The base user-visible price for each plan MUST be identical
   regardless of payment source. Payment-provider-native promotions,
   coupons, or other checkout-side adjustments are excluded from this
   parity rule and are governed by the payment-source-specific rules
   below.
7. Stripe-funded billing MUST use configured payment-provider price
   identifiers. Credit-funded billing MUST use internal microdollar
   amounts that correspond to the same plan prices.
8. The system MUST fail with an error if required billing
   configuration for the selected plan is missing. For Stripe-funded
   billing this includes the payment-provider price identifier.
9. Each plan MUST support two payment sources: payment-provider
   (Stripe) and credits. Base plan pricing, built-in first-period
   pricing defined by this spec, access rules, failure handling, and
   suspension/destruction timelines MUST be identical regardless of
   payment source. Payment-provider-native promotions, coupons, and
   checkout-side adjustments MAY differ by payment source. The payment
   mechanism and the internal implementation of plan switching and
   cancellation differ by payment source (see Plan Switching and
   Cancellation and Reactivation).

### Payment Sources

The rules in this section govern paid self-service KiloClaw
subscription rows. Trial rows are temporary bootstrap rows and are
exempt from the paid funding invariants in rules 2 and 3. Current
organizational bootstrap rows that grant temporary `managed-active`
access before org billing launches are also outside these funding
invariants; they remain a temporary carveout until org billing
integration ships.

1. The system MUST record a payment source for each subscription. The
   value MUST be either `stripe` or `credits`.
2. For paid self-service rows, the system MUST enforce exactly three
   valid combinations of payment source and payment provider
   subscription ID:

   | State         | payment_source | provider subscription ID |
   | ------------- | -------------- | ------------------------ |
   | Legacy Stripe | `stripe`       | non-null                 |
   | Hybrid        | `credits`      | non-null                 |
   | Pure credit   | `credits`      | null                     |

   A subscription with payment source `stripe` MUST have a non-null
   payment provider subscription ID. A subscription with payment source
   `credits` MAY have a non-null payment provider subscription ID
   (hybrid) or a null one (pure credit). No other combination is
   valid.

3. A paid self-service subscription with payment source `credits`
   MUST record a credit renewal timestamp indicating when the next
   credit deduction is due.
4. At most one subscription record per instance is allowed regardless
   of payment source (see Plans rule 5).
5. User-initiated switching between payment sources is not supported
   for in-place mutation. Users MUST NOT be able to manually change a
   subscription's payment source while the subscription remains
   active; they MUST cancel and re-enroll to change funding method.
   System-initiated conversion from legacy Stripe to hybrid (`stripe`
   to `credits` with the provider subscription ID preserved) occurs
   automatically when a KiloClaw invoice is settled (see
   Stripe-Funded Credit Settlement). This is a one-way lazy
   migration, not a user action. A separate user-prompted conversion
   path exists for users who subscribe to Kilo Pass while holding a
   standalone Stripe hosting subscription (see Standalone-to-Credit
   Conversion).

### Hybrid Subscription Ownership

When a subscription is in the hybrid state, multiple events may
attempt to mutate the same subscription. The following ownership
rules resolve conflicts.

1. Invoice settlement MUST be the sole authority for hybrid-row
   successful payment: advancing the billing period, mutating the
   plan, updating the credit renewal timestamp, updating the
   commitment end date, and recovering the subscription to active
   status. No other event or background process MAY perform these
   operations on a hybrid row.
2. Subscription status-change events from the payment provider for
   hybrid rows MUST be limited to propagating cancel intent and
   dunning states. They MUST NOT overwrite the payment source,
   plan, billing period, credit renewal timestamp, or commitment end
   date. They MUST NOT recover hybrid rows to active status, clear
   suspension state, or trigger auto-resume.
3. Subscription creation events from the payment provider MUST NOT
   revert an already-hybrid row's converted state. The hybrid row's
   payment source, plan, billing period, credit renewal timestamp,
   and commitment end date MUST be preserved. Payment provider
   metadata (subscription ID, cancel intent) MUST still be updated.
4. Schedule lifecycle events (completion, release) for hybrid rows
   MUST clear schedule tracking state but MUST NOT mutate the plan
   or commitment end date. Plan mutation is owned by invoice
   settlement (rule 1). Schedule events and settled invoices may
   arrive in either order; the system MUST tolerate both orderings.
5. The credit renewal sweep MUST NOT select hybrid rows (see Credit
   Renewal rule 1). Hybrid-row renewal is owned entirely by invoice
   settlement.
6. The interrupted auto-resume retry in the billing lifecycle
   background job MUST include hybrid rows. A hybrid row can need
   retry if auto-resume was interrupted after invoice settlement
   recovered it to active (see Billing Lifecycle Background Job
   rule 5).
7. For non-hybrid rows (legacy Stripe or pure credit), all existing
   event-handling and sweep behaviors MUST remain unchanged. The
   ownership rules in this section apply ONLY to hybrid rows.

### Trial Eligibility and Creation

1. A trial MUST only be created automatically when a user provisions an
   instance for the first time. There is no user-facing "start trial"
   action; the trial is bootstrapped during provisioning.
2. The system MUST create a trial only if the user has no existing
   subscription record. The instance-record check is not needed at
   provisioning time because provisioning itself creates the instance,
   but the billing status endpoint includes the instance check as
   defense in depth.
3. When a trial is created, the system MUST record the trial start
   timestamp and an end timestamp exactly 7 days later.
4. The system MUST NOT require a credit card to start a trial.
5. When a user provisions a new instance and the user's existing
   subscription references a destroyed instance, the system MUST
   create a successor subscription row on the newly provisioned
   instance, provided the current personal subscription row still
   grants access (active, non-suspended past-due, or trialing with a
   future end date). The predecessor row on the destroyed instance
   MUST remain as historical record and MUST be marked non-live via
   `transferred_to_subscription_id`. The successor row MUST inherit
   the remaining entitlement and any live payment-provider ownership.
   This preserves the user's remaining subscription time when they
   destroy and re-create an instance while keeping one subscription
   row per instance.

### Personal Reprovision Transfer

1. In personal context, the current subscription row is the personal
   subscription row whose `transferred_to_subscription_id` is null.
2. Live personal runtime MUST have at most one current subscription
   row per user personal context. If more than one exists, runtime
   MUST fail closed and quarantine/manual-review the user rather than
   choose heuristically.
3. Transferred-out predecessor rows MUST NOT participate in live
   access checks, checkout duplicate guards, credit enrollment,
   Stripe webhook mutation, invoice settlement, renewal, dunning,
   lifecycle sweeps, or email warnings.
4. Webhook and settlement routing MUST first resolve by Stripe
   subscription ID. If resolved row has
   `transferred_to_subscription_id`, runtime MUST follow predecessor
   to successor until current row is reached. If Stripe ownership or
   lineage resolution is ambiguous, missing, cyclic, or crosses the
   personal/organization boundary, runtime MUST quarantine rather than
   mutate a row.
5. Personal paid flows MUST always carry an instance billing anchor.
   The system MUST NOT create new detached personal subscription rows.

### Access Control

1. The system MUST grant access when the subscription status is active.
2. The system MUST grant access when the subscription status is past-due
   and the subscription has not been suspended.
3. The system MUST grant access when the subscription status is trialing
   and the trial end date is in the future.
4. The system MUST grant access when a canonical earlybird subscription
   row remains in an access-granting state.
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
4. The system MUST allow payment-provider promotional codes for either
   plan. These promotions are payment-provider-native checkout
   adjustments and do not require an equivalent user-entered mechanism
   in the credit-enrollment flow.
5. The system MUST apply the configured first-month discount when
   creating a standard plan checkout session without consuming the
   promotional-code input. The implementation MAY use a dedicated
   intro price or another provider-supported mechanism that keeps
   user-entered promotional codes available.
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
10. After a Stripe checkout completes, the subscription MUST NOT be
    reported as fully activated until invoice settlement has completed
    (see Stripe-Funded Credit Settlement). Subscription creation from
    the payment provider is an intermediate state; the system MUST
    treat a subscription as fully activated only after settlement has
    converted it to the hybrid state.

### Credit Enrollment

1. The system MUST reject a credit enrollment request if the user
   already has a subscription in active, past-due, or unpaid status.
   This is the same guard as Subscription Checkout rule 1.
2. The system MUST allow credit enrollment when the existing
   subscription status is trialing or canceled.
3. The system MUST apply a first-month discounted price when enrolling
   in the standard plan via credits, identical to the built-in Stripe
   first-month discount defined in Subscription Checkout rule 5. This
   rule does not attempt to mirror user-entered payment-provider promo
   codes. The discounted cost is 4,000,000 microdollars. A user
   qualifies for the discount when no prior paid subscription exists; a canceled trial
   subscription (plan = 'trial') MUST NOT count as a prior paid
   subscription. When the user has a canceled non-trial subscription,
   the system MUST charge the regular standard price of 9,000,000
   microdollars. The commit plan has no first-month discount.
4. The system MUST verify that the user's effective credit balance is
   sufficient to cover the first billing period before proceeding:
   the applicable standard plan cost per rule 3 (4,000,000 or
   9,000,000 microdollars) or 48,000,000 microdollars for the commit
   plan (six months paid upfront). The effective balance MUST be
   computed as the current
   credit balance plus the projected bonus credits the user would earn
   from the deduction. The projected bonus MUST be obtained by querying
   the Kilo Pass entitlement system for the bonus that would result
   from the deduction amount, without committing any credit award.
   When the user has no Kilo Pass, the effective balance equals the
   current credit balance. When the enrollment is triggered by a Kilo
   Pass upsell checkout flow (see Kilo Pass Upsell Checkout), the
   system MUST account for the credits that will be added by the
   concurrent Kilo Pass purchase when evaluating sufficiency.
5. The system MUST check whether the user was previously suspended
   (has a non-null suspension timestamp) before mutating the
   subscription row.
6. The credit deduction and subscription upsert MUST be performed in
   a single database transaction so that a crash cannot
   leave the user with deducted credits and no active subscription.
   Within this transaction the system MUST:
   a. Insert a negative credit transaction for the first period's cost.
   The insertion MUST use a period-encoded idempotency key (see
   Credit Renewal rule 2) with conflict-safe semantics. The key
   MUST distinguish the instance, plan, and billing period, for
   example `kiloclaw-subscription:{instance_id}:YYYY-MM` for
   standard or `kiloclaw-subscription-commit:{instance_id}:YYYY-MM`
   for commit. If the insertion detects a duplicate, the system MUST
   abort the enrollment as a duplicate attempt.
   b. Atomically record the deduction as credit spend (see
   Definitions) by incrementing the user's used counter by the
   deducted amount. This ensures the deduction counts toward the
   Kilo Pass bonus unlock threshold.
   c. Create or upsert the subscription record with payment source set
   to `credits`, status set to active, the billing period set from
   the current time, the credit renewal timestamp set to the period
   end, the payment provider subscription ID set to null, and the
   instance reference set to the target instance.
   d. The subscription upsert MUST clear the past-due-since timestamp
   and set the status to active, but MUST NOT clear the suspension
   timestamp or destruction deadline at this step. If the user was
   previously suspended, those columns are needed as a signal for
   the auto-resume procedure in rule 8.
   If the transaction is interrupted, the database MUST roll back all
   operations so that a retry can re-attempt without the idempotency
   key blocking it.
7. After the enrollment transaction commits (rule 6), the system MUST
   trigger a bonus credit evaluation. This step determines whether the
   user's cumulative credit spend (see Definitions) — including the
   hosting deduction just committed — now qualifies for additional
   bonus credits under their Kilo Pass entitlement and, if so, awards
   them. The user's credit balance MAY be temporarily negative between
   the deduction in rule 6b and the bonus award; other
   balance-observing systems (monitoring, display, renewal sweeps)
   MUST tolerate transient negative balances from this flow. When the
   user has no Kilo Pass, this step is a no-op. If the bonus
   evaluation fails or times out, the system MUST log the failure but
   MUST NOT roll back the enrollment. The missed bonus SHOULD be
   recovered by a subsequent reconciliation process; this spec does
   not define that process.
8. If the user was previously suspended (per rule 5), the system MUST
   call the auto-resume procedure after the transaction commits to
   restart the instance, clear suspension-cycle email log entries, and
   clear the suspension timestamp and destruction deadline. This MUST
   happen after the subscription row is in active state. If the
   process crashes before auto-resume completes, the non-null
   suspension timestamp on an active subscription signals that
   resume is still required; the next background job run MUST
   detect this state and retry the auto-resume.
9. For the commit plan, the system MUST record a commit-period end
   date six calendar months from enrollment, consistent with Commit
   Plan Lifecycle rule 2.

### Kilo Pass Upsell Checkout

Kilo Pass is the RECOMMENDED checkout path for KiloClaw hosting. The
system SHOULD present Kilo Pass tiers as the primary option when a
user activates hosting, with standalone hosting plans as a secondary
alternative.

1. When a user selects a Kilo Pass tier from the KiloClaw checkout
   flow, the system MUST redirect to the Kilo Pass checkout with a
   callback parameter indicating that KiloClaw auto-activation is
   pending. The callback MUST include the selected hosting plan
   (standard or commit) and the target instance identifier.
2. After the Kilo Pass checkout completes and the payment provider's
   invoice has been settled (credits have been added to the user's
   balance), the system MUST automatically enroll the target instance
   in the selected hosting plan via the credit enrollment path (see
   Credit Enrollment). The user MUST NOT be required to take a
   separate activation action.
3. The auto-enrollment MUST wait for the Kilo Pass invoice settlement
   to complete before attempting the credit deduction. The system
   MUST poll or wait until the user's credit balance reflects the
   Kilo Pass payment before calling credit enrollment, to handle
   the race between the browser redirect and the payment provider
   webhook.
4. The commit plan MUST be offered to users selecting a Kilo Pass
   tier only when the tier provides sufficient credits to cover the
   first commit period (48,000,000 microdollars). This includes
   monthly tiers of 49 dollars or above and all annual tiers. The
   standard plan MUST be available with all Kilo Pass tiers.
5. All credit enrollment rules (balance check, idempotency,
   transaction atomicity, bonus evaluation, auto-resume) apply
   to Kilo Pass upsell enrollments. The upsell checkout is a
   convenience flow that ends in the same credit enrollment path.

### Standalone-to-Credit Conversion

When a user with a Stripe-funded hosting subscription subscribes to
Kilo Pass, the system SHOULD prompt the user to transition hosting to
credit-funded billing. This section applies to legacy Stripe and
hybrid subscriptions. Hybrid subscriptions already route payments
through the credit ledger but still incur a separate Stripe charge;
conversion eliminates that charge by transitioning to pure credit.

1. The system MUST detect when a user has both a Kilo Pass
   subscription and a Stripe-funded KiloClaw hosting subscription
   (non-null payment provider subscription ID).
2. When this condition is detected, the system SHOULD present a
   prompt offering to switch hosting to credit-funded billing. The
   conversion MUST NOT be automatic; it MUST require user
   confirmation.
3. If the user accepts, the system MUST set cancel-at-period-end on
   the Stripe-funded hosting subscription (both in the payment
   provider and locally). The current billing period continues as
   already paid by Stripe.
4. When the Stripe subscription reaches its canceled state at period
   end, the system MUST clear the payment provider subscription ID
   from the local subscription row, converting it to a pure credit
   subscription. If the row was hybrid, the payment source remains
   `credits`; if it was legacy Stripe, the payment source MUST be
   set to `credits`. The credit renewal timestamp MUST be set to
   the existing current-period-end so that the credit renewal sweep
   picks up the next renewal. This transition MUST happen
   atomically when the payment provider reports the subscription as
   canceled.
5. After the transition in rule 4, the credit renewal sweep handles
   subsequent renewals as a pure credit subscription, deducting
   from the user's Kilo Pass-funded credit balance.
6. If the user declines or ignores the prompt, the Stripe-funded
   hosting subscription MUST continue unchanged. The system MAY
   re-present the prompt at a later time.

### Stripe-Funded Credit Settlement

When the payment provider reports a paid invoice for a KiloClaw
subscription, the system converts the payment into credit-accounted
settlement. This is the mechanism by which legacy Stripe rows become
hybrid rows (see Payment Sources rule 2) and by which existing hybrid
rows renew.

1. The system MUST identify KiloClaw invoices by matching a line
   item's price against the configured KiloClaw price identifiers.
   Invoices with no matching line item MUST NOT be processed by
   this flow. If required invoice data (charge identifier,
   subscription identifier, matching line item, or period
   boundaries) is absent, the system MUST log a warning and skip
   the invoice.
2. The settled plan and billing period boundaries MUST be derived
   from the invoice, not from local subscription state or
   wall-clock time. The invoice is authoritative because local
   schedule tracking may have been cleared before the invoice
   arrives (see Hybrid Subscription Ownership rule 4).
3. Settlement MUST be balance-neutral: the system MUST record a
   positive credit entry and a matching negative credit deduction
   in a single atomic operation. The user's visible credit balance
   MUST NOT change as a result.
4. The deduction amount MUST equal the settled invoice amount. The
   system MUST NOT substitute locally defined plan cost constants.
   Payment-provider-side adjustments (first-month discounts,
   promotional codes, coupons, prorations) flow through as-is.
5. Settlement MUST be idempotent. Processing the same invoice twice
   MUST NOT produce duplicate credits or duplicate deductions.
6. On successful settlement the system MUST:
   a. Set payment source to `credits`, preserving the payment
   provider subscription ID (converting a legacy Stripe row to
   hybrid, or no-op for an already-hybrid row).
   b. Set subscription status to active.
   c. Advance the billing period and credit renewal timestamp to
   the invoice-derived boundaries.
   d. For commit plans, update the commitment end date to the
   invoice's period end. For standard plans, clear it.
   e. Clear past-due state and any auto-top-up marker for the
   prior period.
7. If a scheduled plan change matches the settled invoice's plan,
   the system MUST clear the schedule tracking state atomically
   with settlement. If the invoice plan differs from the current
   plan and there is no matching scheduled change, the system MUST
   treat the settled invoice as authoritative and log a warning.
8. If the subscription was past-due or suspended before settlement,
   the system MUST trigger the auto-resume procedure after the
   settlement transaction commits (see Auto-Resume on Payment
   Recovery).
9. After the settlement transaction commits, the system MUST
   trigger a bonus credit evaluation as described in Credit
   Enrollment rule 6.

### Commit Plan Lifecycle

1. A commit subscription MUST remain on the commit price in the payment
   provider; the system MUST NOT create a schedule to auto-transition
   the subscription to the standard plan.
2. When a commit subscription is created, the system MUST record a
   commit-period end date six calendar months from the billing start.
   When a delayed-billing period is configured, the six months MUST
   start from the delayed-billing end date, not from subscription
   creation.
3. For legacy Stripe rows, when a subscription update is received and
   the commit-period end date is in the past, the system MUST extend
   it by six calendar months from the previous boundary, keeping the
   subscription on the commit plan. For hybrid rows, commit-period
   extension is handled by invoice settlement (see Stripe-Funded
   Credit Settlement rule 6d); subscription status-change events
   MUST NOT extend the commit-period end date (see Hybrid
   Subscription Ownership rule 2).
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
   released) and the local schedule tracking state still references
   the schedule: for legacy Stripe rows the system MUST apply the
   scheduled plan and update the commit-period end date accordingly;
   for hybrid rows the system MUST clear the schedule tracking state
   but MUST NOT mutate the plan or commitment end date (see Hybrid
   Subscription Ownership rule 4). Plan mutation for hybrid rows
   occurs when the corresponding invoice is settled (see
   Stripe-Funded Credit Settlement rule 7). Intentional releases
   (cancellation or cancel-plan-switch) clear the local schedule
   reference before the event fires, so the schedule event MUST NOT
   match those rows.
7. When a standard-to-commit switch takes effect, the system MUST set
   the commit-period end date to six calendar months from the
   transition date.
8. The system MUST allow cancellation of user-initiated plan switches.
9. For pure credit subscriptions, a plan switch MUST NOT create a
   payment-provider schedule. The system MUST record the scheduled
   plan locally and apply it at the next period boundary during the
   credit renewal sweep.
10. For pure credit subscriptions, canceling a plan switch MUST clear
    the locally recorded scheduled plan. No payment-provider API call
    is needed.
11. User-initiated cross-payment-source switching (credits to Stripe or
    vice versa) is NOT RECOMMENDED. Users who wish to change payment
    source MUST cancel their current subscription and re-enroll after
    the billing period ends. System-initiated conversion from legacy
    Stripe to hybrid via invoice settlement (see Payment Sources
    rule 5 and Stripe-Funded Credit Settlement) is not governed by
    this rule.

### Cancellation and Reactivation

1. The system MUST reject a cancellation request if no active
   subscription exists. For Stripe-funded subscriptions, the provider
   subscription ID MUST be present. For pure credit subscriptions,
   the payment source MUST be `credits` and status MUST be active.
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
6. For pure credit subscriptions, the system MUST set the
   cancel-at-period-end flag in the local database only. No payment
   provider API call is needed. The credit renewal sweep handles the
   period-end transition (see Credit Renewal rule 5).
7. The system MUST allow reactivation of a subscription that is pending
   cancellation.
8. On reactivation of a Stripe-funded subscription, the system MUST
   clear the cancel-at-period-end flag on both the payment provider
   and in the local database.
9. On reactivation of a pure credit subscription, the system MUST
   clear the cancel-at-period-end flag in the local database only.

### Billing Lifecycle Background Job

1. The background job MUST be protected by an authorization secret;
   requests without valid authorization MUST receive an unauthorized
   response.
2. Each sweep in the background job MUST process users independently;
   a failure for one user MUST NOT prevent processing of other users.
3. All errors during sweep processing MUST be captured for monitoring.
4. The credit renewal sweep MUST run before all other sweeps so that
   pure credit subscriptions are renewed (or marked past-due, or
   canceled) before the existing sweeps evaluate expiry and suspension.
   Hybrid rows are excluded from the credit renewal sweep (see Credit
   Renewal rule 1); their renewal is handled by invoice settlement.
5. The background job MUST detect subscriptions with payment source
   `credits` (both hybrid and pure credit) in active status that
   still have a non-null suspension timestamp (indicating a prior
   auto-resume was interrupted) and retry the auto-resume procedure
   for those subscriptions. This MUST include hybrid rows; a hybrid
   row can need retry if auto-resume was interrupted after invoice
   settlement recovered it to active.

### Credit Renewal

1. The credit renewal sweep MUST select only pure credit subscriptions
   where status is active or past-due and the credit renewal timestamp
   is at or before the current time. Hybrid subscriptions MUST NOT be
   selected; their renewal is owned by invoice settlement (see
   Stripe-Funded Credit Settlement). The payment provider's dunning
   process handles payment failure for hybrid subscriptions;
   status-change events propagate past-due state to the local row.
2. Each credit deduction MUST use a period-encoded category key
   with a uniqueness constraint. The key MUST be derived from the
   subscription's credit renewal timestamp (the period boundary being
   charged for), not from the current wall-clock time. The format
   MUST distinguish the instance, renewal cadence, and plan, for
   example `kiloclaw-subscription:{instance_id}:2026-04` for a
   standard renewal or
   `kiloclaw-subscription-commit:{instance_id}:2026-04` for a
   commit renewal.
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
6. When the effective balance (as defined in Credit Enrollment rule 4)
   is sufficient and the deduction succeeds (one affected row), the
   system MUST atomically record the deduction as credit spend (see
   Definitions) and advance the subscription's billing period
   (current-period-start, current-period-end, credit-renewal-timestamp)
   within the same transaction. After the transaction commits, the
   system MUST trigger a bonus credit evaluation as described in Credit
   Enrollment rule 6. The user's credit balance MAY be temporarily
   negative between the deduction and the bonus award. If the bonus evaluation
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
    rule 4) is insufficient, the system MUST first check whether
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
15. When a pure credit subscription has a scheduled plan change and
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
      This rule does not apply to hybrid rows; hybrid plan switching
      is handled by Stripe-Funded Credit Settlement rule 10.

### Auto Top-Up Integration with Credit Renewal

1. The auto top-up flow is asynchronous: triggering auto top-up
   creates and pays a payment-provider invoice, but credits are only
   applied when the invoice-paid webhook fires. The credit renewal
   sweep MUST NOT wait for the top-up to complete.
2. When the sweep triggers auto top-up for a row, the sweep MUST skip
   that row entirely without setting past-due status, sending failure
   notifications, or advancing the billing period.
3. On the next sweep run, if the auto top-up succeeded and the
   effective balance (as defined in Credit Enrollment rule 4) is now
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

1. When a canonical earlybird subscription row's `trial_ends_at` is 14
   or fewer days away and the user does not have another active or
   trialing subscription, the system MUST send a warning notification.
2. When the row's `trial_ends_at` is 1 or fewer days away, the system
   MUST send a more urgent expires-tomorrow notification instead of
   the 14-day notification.
3. The notification's expiry date and days-remaining MUST be derived
   from the row's `trial_ends_at`, not from a globally configured
   earlybird expiry constant.

### Trial Expiry Enforcement

1. When a trial's end date has passed and the subscription is still in
   trialing status (not yet suspended), the system MUST stop the
   subscription's associated instance.
2. The system MUST transition the subscription to canceled status.
3. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
4. The system MUST send a trial-suspended notification.
5. If the instance stop operation fails (e.g., no instance exists), the
   system MUST still proceed with the status transition.

### Subscription Period Expiry Enforcement

1. When a canceled subscription's billing period has ended and the
   subscription has not been suspended, the system MUST stop the
   subscription's associated instance.
2. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
3. The system MUST send a subscription-suspended notification.

### Destruction Warning

1. When a suspended subscription's destruction deadline is 2 or fewer
   days away, the system MUST send a destruction-warning notification.

### Instance Destruction

1. When a suspended subscription's destruction deadline has passed, the
   system MUST destroy the subscription's associated instance.
2. The system MUST mark the instance record as destroyed.
3. The system MUST clear the destruction deadline after destruction.
4. The system MUST send an instance-destroyed notification.
5. If the destroy operation fails (e.g., no instance exists), the system
   MUST still proceed with the state transition.

### Past-Due Payment Enforcement

1. When a subscription has been in past-due status for more than 14 days
   and has not been suspended, the system MUST stop the subscription's
   associated instance. This applies equally to Stripe-funded and
   credit-funded subscriptions.
2. The system MUST set a suspension timestamp and a destruction deadline
   7 days in the future.
3. The system MUST send a payment-suspended notification.
4. The 14-day threshold MUST be measured from the time the subscription
   first entered past-due status, not from the last database update.
   For pure credit subscriptions, past-due status is set by the credit
   renewal sweep. For legacy Stripe subscriptions, it is set by the
   payment provider status-change event. For hybrid subscriptions, it
   is set by the payment provider's dunning state propagation (see
   Hybrid Subscription Ownership rule 2).

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

1. When a subscription transitions to active while the subscription's
   instance is suspended, the system MUST attempt to start the
   subscription's associated instance.
   For legacy Stripe subscriptions, this transition is detected by a
   payment provider status-change event. For pure credit
   subscriptions, this transition is detected by the credit renewal
   sweep when a past-due subscription with a non-null suspension
   timestamp is successfully renewed. For hybrid subscriptions, this
   transition is detected by the invoice settlement path (see
   Stripe-Funded Credit Settlement rule 8); payment provider
   status-change events MUST NOT trigger auto-resume for hybrid rows
   (see Hybrid Subscription Ownership rule 2).
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
3. Pure credit subscriptions have no payment provider status. Their
   status MUST be managed entirely by the credit renewal sweep and
   the billing lifecycle sweeps. Payment provider status mapping
   rules MUST NOT apply to pure credit subscriptions.
4. Hybrid subscriptions receive limited payment provider status
   mapping. Only dunning states MUST be propagated from payment
   provider status changes. Recovery to active status, plan changes,
   period advancement, and clearing of suspension state MUST NOT
   be applied from status-change events for hybrid subscriptions;
   these are owned by invoice settlement (see Hybrid Subscription
   Ownership rules 1-2).

### Billing Status Reporting

1. The billing status response MUST include whether the user currently
   has access and the reason for that access (trial, subscription, or
   earlybird).
2. The system MUST report trial eligibility as true only when the user
   has no instance records at all (including destroyed instances), no
   subscription record.
3. The billing status MUST include trial data (start, end, days
   remaining, expired flag) when a trial exists or existed.
4. The billing status MUST include subscription data (plan, status,
   cancel-at-period-end, period end, commit end, scheduled plan,
   payment source) when a paid subscription exists. When a user has
   multiple instances, the billing status MUST include subscription
   data for each instance. Subscription data MUST be included when
   either a payment provider subscription ID is present or the
   payment source is `credits`; it MUST NOT be suppressed solely
   because a payment provider subscription ID is absent.
5. When the payment source is `credits`, the billing status MUST also
   include the credit renewal timestamp and the renewal cost for the
   next billing period so the frontend can display the next renewal
   date and amount due. For hybrid subscriptions, the renewal cost is
   Stripe-determined; the system MUST report a plan-based
   approximation or indicate that renewal is billed via Stripe.
6. The billing status MUST include a Stripe-funding indicator that is
   true for Stripe-funded subscriptions and false for pure credit
   subscriptions. The frontend MUST use this indicator — not payment
   source alone — to determine whether to show Stripe portal access,
   payment method management, or credit-specific UI such as the
   top-up flow.
7. When the user has a Stripe-funded KiloClaw subscription and also
   has a Kilo Pass subscription, the billing status MUST include an
   indicator signaling that the standalone-to-credit conversion
   prompt should be shown (see Standalone-to-Credit Conversion).
8. The billing status MUST include earlybird data (expiry date, days
   remaining) only when a canonical earlybird subscription row exists.
9. The billing status MUST include instance data (whether an
   undestroyed instance exists, suspension timestamp, destruction
   deadline, and destroyed flag) when any instance record exists.

### Billing Portal

1. The system MUST allow users with Stripe-funded subscriptions to
   access the payment provider's billing portal to manage their payment
   methods.
2. The billing portal session MUST redirect the user back to the
   dashboard upon completion.
3. The billing portal MUST NOT be offered for pure credit
   subscriptions. The frontend MUST use the Stripe-funding indicator
   (see Billing Status Reporting rule 6), not payment source alone,
   to determine portal eligibility. Hybrid subscriptions MUST have
   portal access for Stripe payment method management. Pure credit
   users MUST be directed to the credit top-up flow instead.

### User Data Deletion

1. When a user is soft-deleted, the system MUST retain
   `kiloclaw_instance` and `kiloclaw_subscription` rows for that
   user. Ownership references and directly identifying user fields
   MUST be anonymized rather than deleted.
2. When a user is soft-deleted, the system MUST retain subscription
   change-log rows as canonical audit history. Any directly
   identifying actor or ownership fields in those rows MUST be
   anonymized while preserving the audit trail's meaning.
3. When a user is soft-deleted, the system MUST delete auxiliary
   KiloClaw billing records whose purpose is operational rather than
   canonical state, such as email notification log entries.
4. Credit transaction records created by subscription deductions are
   managed by the credit system's own data deletion rules, not by
   KiloClaw billing. This spec does not impose additional deletion
   requirements on credit transaction records.

### Changelog

#### 2026-03-27 -- Credit spend model, subscription reassignment

- Added definitions for credit balance, credit spend, and the
  distinction between pure-credit deductions (which increment the used
  counter and count toward the Kilo Pass bonus threshold) and
  Stripe-funded settlement deductions (which are balance-neutral
  bookkeeping and do not count as spend).
- Updated Credit Enrollment rule 5b and Credit Renewal rule 6 to use
  "record as credit spend" instead of "decrement acquired credit
  balance," aligning the spec with the intent that hosting deductions
  count toward the Kilo Pass bonus unlock threshold.
- Clarified Credit Enrollment rule 6: "cumulative credit spend"
  explicitly includes the hosting deduction just committed.
- Added Trial Eligibility and Creation rule 5: when a user provisions
  a new instance and the existing subscription references a destroyed
  instance, the system reassigns the subscription to the new instance.
  This fixes a bug where destroying and re-creating an instance left
  the subscription orphaned on the old destroyed instance.

#### 2026-03-24 -- Credits-first billing, per-instance subscriptions, Kilo Pass upsell

- Reframed the overview to reflect credits-first billing direction:
  every KiloClaw subscription is a credit deduction, regardless of
  funding source. Kilo Pass is the recommended checkout path.
- Changed subscription scope from per-user to per-instance. Plans
  rule 5 now enforces at most one subscription per instance. A user
  may have multiple instances, each with its own subscription.
- Idempotency keys for credit deductions (enrollment and renewal)
  now include the instance identifier to support per-instance
  subscriptions.
- Added Kilo Pass Upsell Checkout section defining the recommended
  checkout flow where users subscribe to Kilo Pass and hosting
  auto-activates via credit enrollment.
- Added Standalone-to-Credit Conversion section defining the
  user-prompted flow for transitioning Stripe-funded hosting
  (legacy Stripe or hybrid) to pure credit when the user subscribes
  to Kilo Pass. Includes the state transition that clears the
  payment provider subscription ID at period end.
- Credit Enrollment rule 3 now accounts for credits from a concurrent
  Kilo Pass purchase when evaluating balance sufficiency.
- Billing Status Reporting now includes per-instance subscription
  data and a conversion-prompt indicator for users with both
  Stripe-funded hosting and Kilo Pass.
- Lifecycle enforcement sections (trial expiry, subscription expiry,
  destruction, past-due, auto-resume) updated to reference the
  subscription's associated instance rather than "the user's
  instance."

#### 2026-03-20 -- Stripe-to-credits hybrid billing model

- Introduced the hybrid subscription state: `payment_source='credits'`
  with a non-null payment provider subscription ID. Legacy Stripe rows
  lazily convert to hybrid on their next settled invoice.
- Added Stripe-Funded Credit Settlement section defining the invoice
  settlement path.
- Added Hybrid Subscription Ownership section defining which events
  own which mutations for hybrid rows.
- Changed discriminants throughout the spec from payment source to
  payment provider subscription ID presence for: plan switching,
  cancellation, reactivation, billing portal, and renewal sweep scope.
- Credit renewal sweep now excludes hybrid rows; hybrid renewal is
  owned by invoice settlement.
- Payment provider status mapping now includes a limited hybrid path:
  non-active dunning states only.
- Billing status now includes a Stripe-funding indicator.
- Checkout success activation now requires invoice settlement.

#### 2026-03-19 -- Pricing and trial changes

Previous values:

- Trial duration: 30 days
- Standard plan: $25/month, promotional codes allowed
- Commit plan: $54/6 months
- Trial expiry warning: 5 days before expiry

New values:

- Trial duration: 7 days (existing trials keep their original end date)
- Standard plan: $9/month with $4 first month while still allowing
  promotional codes
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
