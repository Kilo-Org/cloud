# KiloClaw Billing Lifecycle

## Role of This Document

This spec defines the business rules and invariants for the KiloClaw
billing lifecycle as it applies to credit renewal orchestration. It is
the source of truth for _what_ the system must guarantee — valid
states, ownership boundaries, correctness properties, retry behavior,
and enforcement safety around credit renewals. It deliberately does not
prescribe _how_ to implement those guarantees: handler names, column
layouts, queue bindings, conflict-resolution strategies, and other
implementation choices belong in plan documents and code, not here.

This document supplements `.specs/kiloclaw-billing.md`. The core
billing spec remains authoritative for plan pricing, credit deduction
semantics, subscription status transitions, access rules, auto top-up,
auto-resume, emails, and suspension/destruction timelines. This
document governs lifecycle orchestration reliability for credit
renewal work.

## Status

Draft -- created 2026-05-13 from credit-renewal lifecycle policy
decisions.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Credit-renewal boundary**: The subscription's due
  `credit_renewal_at` timestamp being evaluated for one renewal
  decision. A boundary identifies the billing period that is being
  charged, canceled, deferred, skipped, or otherwise finalized.
- **Subscription-renewal boundary**: The pair of a subscription record
  and a credit-renewal boundary. This is the correctness unit for
  credit renewal lifecycle work.
- **Pure credit subscription**: A KiloClaw subscription with payment
  source `credits` and no payment-provider subscription ID, as defined
  in `.specs/kiloclaw-billing.md`.
- **Hybrid subscription**: A KiloClaw subscription with payment source
  `credits` and a non-null payment-provider subscription ID. Hybrid
  renewal is owned by payment-provider invoice settlement, not by the
  credit renewal lifecycle.
- **Discovery**: The lifecycle activity that finds due pure-credit
  subscription-renewal boundaries eligible for credit renewal work.
- **Credit-renewal item**: The independent lifecycle work for one
  subscription-renewal boundary.
- **Expected outcome**: A safe, intended result of processing a
  credit-renewal item, including renewal, cancellation at period end,
  insufficient credits becoming past-due, auto top-up deferral,
  duplicate idempotency reconciliation, or stale/ineligible-row skip.
- **System failure**: An unexpected technical failure that prevents the
  system from safely deciding or finalizing a credit-renewal item. A
  system failure is distinct from an expected billing outcome.
- **Terminal renewal failure**: A system failure for a
  subscription-renewal boundary that exhausted automatic retry and now
  requires operator resolution, retry, or waiver.
- **Unresolved terminal renewal failure**: A terminal renewal failure
  that has not been resolved, waived, or superseded by advancement of
  the subscription's credit-renewal boundary.
- **Per-user serialization**: A correctness guarantee that
  balance-sensitive credit renewal decisions for the same user do not
  execute concurrently in a way that allows stale balance reads,
  overdraws, or inconsistent Kilo Pass bonus projections.
- **Downstream enforcement**: Billing lifecycle actions that can suspend,
  stop, warn, or destroy an instance after subscription expiry,
  past-due grace expiry, or destruction deadline expiry.

## Overview

Pure credit KiloClaw subscriptions renew by deducting credits from the
user's balance at each due credit-renewal boundary. Credit renewal must
remain safe under duplicate delivery, retries, stale state, multiple
subscriptions for the same user, and background-worker time limits.
The lifecycle therefore treats each subscription-renewal boundary as an
independent, idempotent unit of work.

Credit renewal discovery may run in bounded slices and may discover the
same boundary more than once. Duplicate discovery is acceptable because
the renewal item must re-read current state and use period-scoped
idempotency before mutating billing state. Only unresolved terminal
system failures are durable enforcement blockers. The lifecycle does
not require a global credit-renewal run barrier before unrelated
downstream enforcement can proceed.

## Rules

### Scope and Ownership

1. The credit renewal lifecycle MUST select only pure credit
   subscriptions whose status is active or past-due and whose
   credit-renewal boundary is due.
2. The credit renewal lifecycle MUST NOT select hybrid subscriptions.
   Hybrid renewal remains owned by payment-provider invoice settlement.
3. The credit renewal lifecycle MUST NOT select legacy Stripe-funded
   subscriptions.
4. The credit renewal lifecycle MUST operate on the
   subscription-renewal boundary as the unit of correctness.
5. Credit renewal lifecycle rules in this document MUST preserve the
   Credit Renewal rules in `.specs/kiloclaw-billing.md`, including
   one-period advancement, period-scoped idempotency keys, atomic
   deduction and period advancement, auto top-up behavior, and recovery
   behavior for past-due subscriptions.

### Bounded Discovery

1. Discovery MUST be bounded so that the system does not load or
   process all due subscriptions in one unbounded lifecycle invocation.
2. Discovery MUST be resumable when more eligible boundaries remain
   after the current bounded discovery slice.
3. Discovery MUST use stable ordering suitable for continuation and
   MUST NOT rely on offset pagination for mutating lifecycle candidate
   sets.
4. Discovery MAY discover or emit the same subscription-renewal
   boundary more than once.
5. Duplicate discovery MUST NOT create duplicate credit deductions,
   duplicate subscription period advancement, or duplicate terminal
   failure obligations.
6. Discovery SHOULD include enough non-sensitive correlation data for
   operators to diagnose backlog, continuation, and item-processing
   outcomes.

### Credit-Renewal Item Processing

1. Each credit-renewal item MUST represent exactly one
   subscription-renewal boundary.
2. Before applying side effects, item processing MUST re-read and
   revalidate the current user, subscription, and instance state.
3. If the subscription's current credit-renewal boundary no longer
   matches the item boundary, the item MUST be treated as stale or
   superseded and MUST NOT apply another deduction for that boundary.
4. If the subscription is no longer a current eligible pure-credit row,
   the item MUST be skipped without billing mutation.
5. If the associated instance or ownership context makes the row
   ineligible for personal credit renewal, the item MUST be skipped
   without billing mutation. Instance destruction alone MUST NOT make a
   current personal pure-credit subscription ineligible; renewal remains
   governed by subscription state and cancellation intent.
6. If the user has been soft-deleted, the item MUST NOT create
   user-facing side effects.
7. Expected stale, superseded, or ineligible-row outcomes MUST NOT be
   treated as system failures.
8. A successful credit deduction MUST advance the subscription by
   exactly one billing period for the processed boundary.
9. Processing MUST preserve the period-scoped idempotency behavior
   defined in `.specs/kiloclaw-billing.md` so duplicate delivery cannot
   double-charge or double-advance a subscription.

### Shared Credit Balance Safety

1. The system MUST NOT allow concurrent credit-renewal decisions for
   the same user to consume or reason about the same credit balance in a
   way that can overdraw credits or make inconsistent Kilo Pass bonus
   decisions.
2. Balance-sensitive renewal decision and deduction for pure-credit
   subscriptions owned by the same user MUST be serialized, or protected
   by an equivalent atomic guard with the same correctness properties.
3. The serialized decision MUST observe the user's current effective
   balance at the time the renewal decision is made.
4. Multiple due subscriptions for the same user MAY be processed by
   separate lifecycle items, but their balance-sensitive decision and
   deduction steps MUST NOT run concurrently.
5. The system MUST NOT wait on unbounded external side effects while
   holding a per-user serialization primitive. Inputs needed for the
   serialized balance decision SHOULD be locally available or obtained
   before entering the serialized decision.
6. If the system cannot safely determine the effective balance for a
   renewal item because of a system failure, it MUST retry or terminally
   fail the item rather than marking the user past-due as if credits
   were insufficient.

### Expected Outcomes

1. A credit-renewal item MUST be considered safely finalized when the
   system reaches the correct billing outcome for that boundary.
2. A successful deduction and period advancement is an expected outcome.
3. Processing cancel-at-period-end by canceling the subscription at the
   due boundary is an expected outcome.
4. Marking a subscription past-due because effective balance is
   insufficient and auto top-up is unavailable, disabled, or already
   triggered for the boundary is an expected outcome.
5. Triggering auto top-up and deferring the renewal decision is an
   expected outcome.
6. Reconciling a duplicate idempotency key as an already-finalized
   boundary is an expected outcome.
7. Skipping a stale, superseded, transferred, detached,
   organization-managed, Stripe-funded, hybrid, or otherwise ineligible
   row is an expected outcome. A destroyed instance row is not skipped
   when its current personal pure-credit subscription otherwise remains
   renewable.
8. Expected outcomes MUST NOT create terminal renewal failures.
9. Expected outcomes MUST NOT block unrelated downstream enforcement.

### Automatic Retry and Terminal Failure

1. Unexpected system failures during credit-renewal item processing
   MUST be retried automatically when retry capacity remains.
2. The system MUST attempt no more than three automatic processing
   attempts for the same subscription-renewal boundary before treating
   the item as terminally failed, unless an operator explicitly retries
   it.
3. When automatic retry is exhausted, the system MUST record an
   unresolved terminal renewal failure for the subscription-renewal
   boundary.
4. Terminal renewal failures MUST be keyed by subscription and
   credit-renewal boundary so duplicate terminal handling for the same
   boundary is idempotent.
5. A terminal renewal failure MUST record enough non-sensitive context
   for operators to understand the failed boundary, failure category,
   attempt history, last observed error, and current resolution state.
6. The system MUST NOT convert terminal system failure into an
   insufficient-credit past-due outcome automatically.
7. An unresolved terminal renewal failure MUST remain unresolved until
   an operator resolves it, waives it, retries it successfully, or the
   subscription boundary is superseded by a later safe state.
8. Operator resolution or waiver MUST be auditable with actor, time,
   and reason.

### Downstream Enforcement Protection

1. Downstream enforcement MUST skip a subscription-renewal boundary
   while it has an unresolved terminal renewal failure.
2. Downstream enforcement MUST NOT skip unrelated subscriptions or
   unrelated renewal boundaries solely because another boundary has an
   unresolved terminal renewal failure.
3. Resolved, waived, or superseded terminal renewal failures MUST NOT
   protect a subscription from downstream enforcement.
4. Pending or retrying credit-renewal work does not by itself require a
   durable enforcement barrier. Protection is REQUIRED only after an
   unresolved terminal renewal failure exists.
5. The system MUST monitor credit-renewal backlog and retry age so that
   pending or retrying work does not approach enforcement grace windows
   without operator visibility.
6. If credit-renewal backlog or retry age creates credible risk of
   false suspension or destruction, the system SHOULD add a stronger
   protection mechanism before continuing rollout.

### Observability and Operator Control

1. The system MUST expose enough operational signal to detect discovery
   backlog, item-processing backlog, item failures, retry exhaustion,
   and unresolved terminal renewal failures.
2. Operators MUST have a way to identify unresolved terminal renewal
   failures by subscription, renewal boundary, age, and failure category.
3. Operators MUST have a way to resolve, waive, or retry unresolved
   terminal renewal failures.
4. Operational logs and diagnostics MUST NOT include tokens,
   credentials, authentication headers, cookies, webhook secrets, or
   other sensitive secrets.
5. User-facing PII in operational diagnostics MUST be avoided unless it
   is required for support and protected by existing access controls and
   data handling rules.
6. Queue or background-worker configuration SHOULD be tuned from
   observed latency, backlog, retry rate, and same-user contention.

## Error Handling

1. When discovery fails before emitting all due boundaries, the system
   MUST retry or resume discovery without requiring manual database
   repair.
2. When duplicate discovery emits the same boundary more than once, item
   processing MUST remain idempotent.
3. When item processing observes stale or ineligible current state, the
   system MUST skip the item without user-facing error.
4. When item processing encounters an expected billing outcome, the
   system MUST finalize that outcome according to
   `.specs/kiloclaw-billing.md` and MUST NOT record a terminal system
   failure.
5. When item processing encounters a retryable system failure, the
   system MUST preserve enough context for retry and MUST NOT mutate the
   subscription into a user-fault state solely because of that failure.
6. When retry is exhausted for a subscription-renewal boundary, the
   system MUST record an unresolved terminal renewal failure and alert or
   otherwise surface the failure to operators.
7. When downstream enforcement sees an unresolved terminal renewal
   failure for the same subscription-renewal boundary, it MUST skip that
   boundary until the failure is resolved, waived, retried successfully,
   or superseded.
8. When an operator waives a terminal renewal failure, the waiver MUST
   remove enforcement protection for that boundary without pretending a
   successful renewal occurred.

## Implementation Status

The current thin-slice implementation processes credit renewal as bounded
discovery plus independent per-boundary lifecycle items. It exposes
structured logs for discovery backlog, item queue age, retry exhaustion,
and unresolved terminal renewal failures. Minimal operator tooling exists
for listing, resolving, waiving, and constructing retry messages for
terminal renewal failures.

The following SHOULD-level operational improvements remain future work:

1. The system SHOULD split credit-renewal item processing into a dedicated
   queue if shared lifecycle-queue contention, backlog, or retry behavior
   shows that the existing lifecycle queue is insufficient.
2. The system SHOULD add richer dashboard or admin UI support for terminal
   renewal failure resolution, waiver, and retry if CLI/operator-script
   handling is not sufficient for support workflows.
3. The system SHOULD add stronger protection if credit-renewal backlog or
   retry age approaches downstream enforcement grace windows.

## Changelog

### 2026-05-13 -- Initial spec

- Created to codify credit-renewal lifecycle policy decisions.
- Codified per-boundary fan-out, bounded discovery, per-user balance
  serialization, expected outcomes, terminal renewal failures, and
  downstream enforcement protection.
