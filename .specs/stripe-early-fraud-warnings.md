# Stripe Early Fraud Warning Enforcement

## Role of This Document

This spec defines the business rules and invariants for enforcing Stripe Early Fraud Warnings (EFWs). It is the source of truth for trigger scope, payment ownership classification, personal-account containment, financial unwinding, operational review, remediation, and privacy boundaries. Implementation mechanics such as route names, database columns, retry cadence, and Stripe request formatting belong in plans and code.

## Status

Draft -- created 2026-05-28.

Initial delivery is sequenced: the persistence foundation may be deployed inertly before event ingestion and action processing are enabled. Deploying case and action storage MUST NOT itself process historical warnings or change account access.

## Conventions

BCP 14 [RFC 2119] [RFC 8174] keywords apply only when they appear in all capitals: "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL".

## Definitions

- **Early Fraud Warning (EFW)**: A Stripe Radar warning communicated through a `radar.early_fraud_warning.created` event.
- **Warned charge**: The Stripe charge named by the EFW. It is the only charge eligible for automatic refund under this spec.
- **Canonical personal owner**: Exactly one personal Kilo user whose stored Stripe customer identity owns the warned payment, with no organization customer ownership conflict.
- **Organization-owned warning**: An EFW whose warned payment resolves to an organization Stripe customer.
- **Ambiguous warning**: An EFW for which stored canonical identities conflict or more than one owner is possible.
- **Unmatched warning**: An EFW for which no canonical stored customer owner can be resolved.
- **Enforced warning**: An EFW for a canonical personal owner that is accepted for automatic containment while enforcement is enabled.
- **Attributable value**: Credits or product benefits issued from the warned payment, including payment-derived bonuses; it excludes value acquired from unrelated legitimate payments.
- **Case**: Retained operational and financial record for one EFW and its ownership/enforcement outcome.
- **Action ledger**: Retained idempotent record of each containment, financial, access, payout, or notice operation required by a case.
- **Operational off switch**: Configuration that disables automatic personal enforcement for newly received EFWs without disabling durable review visibility.
- **Remediation**: Admin-reviewed recovery work for a legitimate user after enforcement; it is not an automatic reversal of irreversible side effects.

## Rules

### Trigger and Rollout Scope

1. Automated EFW enforcement MUST originate only from newly received `radar.early_fraud_warning.created` events after the enforcement capability is deployed and enabled.
2. The system MUST NOT import or automatically enforce historical EFW exports as part of this release.
3. Existing dispute, refund, and fraud-mark handling MUST continue to operate independently, subject to idempotency rules that prevent duplicated EFW side effects.
4. The persistence-only foundation MAY exist before processing is enabled; until ingestion is deployed, it MUST remain unwritten by EFW automation.

### Observation-Only Rollout Interval

- Before automatic enforcement is deployed and enabled, newly delivered EFWs MUST be persisted as `review_required` cases for operator visibility only, including warnings that resolve to a canonical personal owner.
- A case captured during the observation-only interval MUST remain manual-review work and MUST NOT later be promoted into automatic enforcement merely because enforcement is enabled for newly arriving warnings.
- Observation-only ingestion MUST NOT create action-ledger work, block users, disable automatic top-up, refund payments, reverse value, modify subscriptions or compute, reverse payouts or rewards, or send enforcement notices.

### Ownership Resolution and Review Boundary

5. Automatic enforcement MUST occur only when the warned payment resolves to one canonical personal owner and does not resolve to an organization.
6. Ownership resolution MUST use canonical stored payment-customer ownership and MUST NOT infer a destructive action from billing email, free-form metadata, or heuristic similarity.
7. Organization-owned, ambiguous, unmatched, malformed, already-disputed, or otherwise unsafe warnings MUST be retained as review-required cases and MUST NOT automatically block a person, refund a charge, reverse value, cancel billing, or suspend compute.
8. A personal enforcement path MUST NOT alter organization-owned subscriptions, organization auto-top-ups, organization KiloClaw instances, or organization seat access.

### Durable Case and Action State

9. The system MUST retain at most one case for each Stripe EFW identifier.
10. Cases MUST retain safe payment correlation identifiers, amount/currency when available, owner classification, optional canonical owner links, lifecycle status, operational reason, timestamps, and non-sensitive failure context.
11. Required operations MUST be represented by idempotent action ledger entries, including containment, exact-charge refund, attributable-value reversal, subscription/access termination, KiloClaw suspension, payout or reward handling, and the user notice.
12. Each operation MUST converge under duplicate webhook delivery, retry processing, concurrent processing, and later related Stripe events. No required effect may be executed more than once for the same case/action target.
13. Case and action persistence MUST NOT store raw Stripe payloads, card data, billing email, auth data, secrets, or sensitive failure output. Stripe object identifiers and non-sensitive result codes are sufficient for retrieval and audit.
14. When a linked user is soft-deleted, retained case/action audit history and fraud-correlation identifiers MAY remain, but direct user linkage and other directly identifying fields MUST be anonymized or removed.

### Personal Containment and Financial Unwinding

15. For an enforced warning, the system MUST durably claim the case before initiating destructive work.
16. The system MUST immediately block the canonical personal account locally and disable personal automatic top-up capability before relying on asynchronous external cleanup. It MUST NOT overwrite an earlier independent block reason.
17. External and financial cleanup MUST be retryable asynchronously from the retained action ledger; webhook latency MUST NOT be the only durability mechanism.
18. The system MUST refund only the remaining refundable amount of the warned charge. It MUST NOT refund a latest invoice, a replacement charge, or another unrelated payment.
19. The system MUST reverse only attributable value derived from the warned payment. If that value has been consumed, the resulting auditable balance MAY be negative. Unrelated legitimate credits MUST NOT be confiscated.
20. The refund and attributable-value reversal requirements apply regardless of charge amount or liability-shift signals in this initial release.

### Recurring Access and KiloClaw

21. An enforced warning MUST terminate all personal recurring access represented by the contained user's Stripe-originated personal billing and local renewal state, including personal auto-top-up and recognized personal recurring subscriptions.
22. For every current personal KiloClaw subscription affected by enforcement, renewal MUST be canceled immediately and compute MUST be suspended or stopped promptly.
23. KiloClaw fraud enforcement MUST assign a fresh seven-day destruction grace after suspension and MUST NOT immediately destroy stored instance data.
24. No later Stripe update may automatically reactivate access canceled or suspended by an enforced warning.

### Affiliate, Referral, and User Notice Effects

25. An enforced EFW refund MUST be treated as an adverse qualifying payment for Impact affiliate and referral handling for supported personal products.
26. An eligible affiliate SALE tied to the refunded warned payment MUST be eligible for full commission reversal even when the proactive refund prevents a later dispute notification.
27. Pending or earned-but-unapplied referral rewards from the warned payment MUST be canceled; already-applied rewards MUST be routed to review rather than automatically clawed back.
28. Once enforcement outcome is known, the system MUST send an idempotent minimal transactional notice that states the payment was refunded and access restricted and provides a support/remediation path. The notice MUST NOT disclose the EFW, fraud-scoring detail, card detail, or abuse-service information.

### Operations, Kill Switch, and Remediation

29. Automatic personal enforcement MUST be controlled by an operational off switch.
30. When the off switch disables enforcement, a newly received EFW MUST remain operator-visible as paused or review-required state and MUST NOT perform containment or destructive actions.
31. Required personal actions MUST NOT be marked completed while any required shutdown or financial action is unconfirmed; failed or ambiguous operations MUST remain retryable or review-required.
32. A legitimate-user recovery MUST require an audited admin/support remediation decision. The system MUST NOT automatically undo a refund, cancellation, credit adjustment, payout reversal, or suspension.
33. Operational case and action visibility is REQUIRED. Experiment dashboards, efficacy metrics, historical EFW imports, and non-Stripe cross-provider cancellation automation are outside this initial release.

## Changelog

### 2026-05-28 -- Initial EFW enforcement contract

- Defined new-event-only Stripe EFW enforcement for canonical personal owners and review-only handling for organization-owned, ambiguous, unmatched, or unsafe warnings.
- Defined durable idempotent cases/actions, immediate local containment, exact-charge refunds, attributable-value reversal, recurring-access shutdown, seven-day KiloClaw destruction grace, adverse-payment side effects, minimal notice, kill switch, and audited remediation boundaries.
