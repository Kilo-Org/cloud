# KiloClaw Data Model

## Role of This Document

This spec defines KiloClaw data-model business rules and invariants, specifically the `kiloclaw_instance` and `kiloclaw_subscription` tables and their relationship. It is the source of truth for system guarantees about record existence, immutability, lookup patterns, and creation order.

It does not prescribe implementation. Column layouts, migration strategies, backfill scripts, and other implementation choices belong in plans and code.

Multiple services and apps operate on this model: the web app, kiloclaw CF worker service, kiloclaw-billing service, and background jobs. All consumers MUST comply with these rules.

## Status

Draft — created 2026-04-15.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" are BCP 14 [RFC 2119] [RFC 8174] terms only when capitalized as shown here.

## Definitions

- **Instance record**: A `kiloclaw_instance` row representing a KiloClaw instance, whether or not the underlying infrastructure (CF worker Durable Object and infra provider resources) still exists.
- **Subscription record**: A `kiloclaw_subscription` row representing a billing subscription tied to a specific instance.
- **Destroyed instance**: An instance record whose underlying infrastructure has been torn down. The record persists with a destroyed marker.
- **Early-bird subscriber**: A user who purchased early-bird access before subscription billing existed. These users have instance records but may lack subscription records until backfill completes.
- **Subscription change log entry**: A subscription audit-log row capturing one `kiloclaw_subscription` mutation: what changed, when, and who or what caused it.
- **Actor**: Entity responsible for a subscription mutation: either a user (user ID) or the system (service or process name).
- **Context**: Instance ownership scope: _personal_ (not associated with any organization) or _organizational_ (associated with a specific organization). A user has one personal context and one organizational context per organization they belong to.
- **Associated user**: For an organizational instance, the organization member whose KiloClaw instance is provisioned for their use. The associated user is the user-facing operational owner; the organization is the billing owner.
- **Active instance**: Instance record not marked as destroyed.
- **Mutation**: Any `kiloclaw_subscription` INSERT or UPDATE that changes one or more business-relevant fields (status, plan, billing period, payment source, cancellation flags, suspension state, etc.). Automated timestamp updates (e.g., `updated_at`) without other field changes are not mutations for change log purposes.
- **Infra Provider**: Backing service provider where we provision compute and storage and deploy OpenClaw, e.g. fly.io, docker-local, Northflank.
- **Infra Provider Base Resource**: Some infra providers have a base top-level organizational resource that must exist, e.g. a fly.io app or Northflank project.

## Overview

The KiloClaw data model centers on instances and subscriptions. An instance record tracks a KiloClaw hosted environment's existence and state. A subscription record tracks the billing relationship funding that instance. Together, they are the foundation for the web app, CF worker services, billing service, and background jobs.

The model supports multiple instances per user or organization, though the system currently limits provisioning to one active instance per user per context (personal, and each organization the user belongs to) via UI and router constraints. These constraints are application-layer, not data-layer, so removing them later requires no schema changes.

A subscription change log provides a complete audit trail for every subscription-record mutation. Subscriptions are never deleted and are mutated by multiple services (web app, kiloclaw CF worker, kiloclaw-billing service, background jobs, and payment provider webhooks), so the change log gives operators and support reliable history of what happened, when, and why without relying on rotated or incomplete logs.

## Rules

### Record Immutability

1. An instance record MUST NOT be deleted from `kiloclaw_instance`, even after the underlying infrastructure (CF worker Durable Object and infra provider resources) is destroyed. Destroyed instances MUST be marked as destroyed, not removed.
2. A subscription record MUST NOT be deleted from `kiloclaw_subscription`. Subscription lifecycle transitions (cancellation, expiry, etc.) MUST be represented as status changes on the existing record, never row deletion. Historical organization KiloClaw instance and subscription records MUST be retained and usable to determine whether a user has already consumed their one 7-day org KiloClaw trial in that organization.
3. When a user account is deleted (e.g., GDPR right-to-erasure), instance and subscription records MUST be retained. Ownership references, including associated-user references on organizational instances, MUST be anonymized, not cascaded or removed. Organization ownership references MAY be retained when they are not directly identifying user data. Subscription change log rows MUST also be retained as canonical audit history. Any directly identifying fields in those rows MUST be anonymized under the GDPR exception in Subscription Change Log rule 14. Foreign key constraints on these tables MUST NOT cascade deletes from parent tables.

### Instance–Subscription Relationship

4. Every instance record MUST have a corresponding subscription record. This invariant is eventually consistent: during the creation sequence (rules 19–23), a brief window exists between the instance INSERT and subscription INSERT where the instance has no subscription. Outside that bounded creation window, an instance record without a subscription record MUST NOT exist, except an instance explicitly quarantined for bootstrap remediation after both primary and fallback subscription-bootstrap paths failed (rule 22). That exception MUST be rare, MUST cause the provisioning request to fail, and MUST NOT be treated as a live provisioned instance for user access or onboarding completion. This invariant is application-layer enforced; the creation-order rules define the satisfying sequence.
5. Each subscription record MUST reference exactly one instance. The relationship is one-to-one: at most one subscription per instance (see kiloclaw-billing.md, Plans rule 5).
6. Early-bird subscribers with instance records but no subscription records are a known rule 4 violation. These MUST be resolved by backfilling canonical subscription records for those instances. Runtime code MUST NOT continue granting access from purchase-table fallback once migration cleanup is complete; users without canonical rows are treated as exceptions requiring manual remediation.

### Multi-Instance Support

7. The model MUST accommodate multiple instances per user or organization. No schema-level constraint SHALL restrict a user or organization to a single instance. Organizational instance records MUST identify the owning organization, associated user, and organizational context. The associated user is the user-facing owner for operational workflows; the organization is the billing owner.
8. The system MUST limit provisioning to one active instance per user per context. A user MAY simultaneously have one active instance in their personal context and one in each organization they belong to. The limit is per context, not per user globally. This limit MUST be enforced at the UI and router layer, not the database layer. Runtime and UI rules MUST limit active organization KiloClaw provisioning to one active instance per user per organization until this product limit is explicitly relaxed, but no schema-level constraint SHALL enforce only one organization KiloClaw instance per organization.
9. When the single-instance limit is relaxed in the future, no schema migration SHALL be required.

### Operational Instance Markers

Instance records MAY store operational lifecycle markers that alone do not grant or revoke billing entitlement. These markers are runtime metadata on the instance record, not substitutes for subscription status, suspension, or destruction fields. Markers MAY be cleared when the lifecycle condition they represent no longer applies.

### Record Lookup

10. Fetching a single record from `kiloclaw_instance` or `kiloclaw_subscription` SHOULD use the table's primary key. Non-primary-key lookups are acceptable only when the caller does not yet know the primary key (e.g., initial resolution from an external identifier). Queries MUST NOT rely on fuzzy matching, partial string comparison, or heuristic selection to locate a specific record.
11. Queries filtering by user, organization, or other non-primary-key attributes (e.g., listing all instances for a user) MUST use exact equality on indexed columns.

### Subscription Change Log

Every `kiloclaw_subscription` mutation MUST be accompanied by a change log entry. The change log is append-only and the authoritative audit trail for subscription state.

12. Each service or process that mutates a subscription record MUST write the corresponding change log entry. This includes creation, status transitions, plan changes, billing period advancement, payment source changes, cancellation, reactivation, suspension, destruction scheduling, and any other mutation.
13. Each entry MUST capture:
    a. The subscription identifier (foreign key to the subscription record).
    b. The change timestamp. It MUST be the database server's current time at insertion, not the application's wall clock or an external event timestamp.
    c. The actor type: `user` or `system`.
    d. The actor identifier: for user actors, the user ID; for system actors, a service or process name (e.g., `kiloclaw-billing`, `kiloclaw-worker`, `billing-lifecycle-job`, `stripe-webhook`, `credit-renewal-sweep`).
    e. The action performed, as a descriptive label (e.g., `created`, `status_changed`, `plan_switched`, `period_advanced`, `canceled`, `reactivated`, `suspended`, `destruction_scheduled`, `reassigned`). All services MUST use consistent action labels. New labels MUST be documented before use.
    f. Enough detail to reconstruct subscription state before and after the mutation. For initial creation, prior state MUST be recorded as absent.
    g. Optional context or reason string with additional detail (e.g., `stripe_invoice:inv_xxx`, `insufficient_credits`, `user_requested`, `trial_expired`).
14. Change log entries MUST NOT be updated or deleted during normal operation. The log is strictly append-only. GDPR-required anonymization of directly identifying fields is the sole exception. That anonymization MUST preserve the event's audit meaning, timestamps, action labels, and non-identifying context.
15. When the change log entry is written in the same database transaction as the mutation, a change log failure that aborts the transaction is acceptable: the entire operation will be retried. Without an enclosing transaction, a change log failure MUST NOT prevent the mutation from succeeding; the system MUST log the failure and proceed. The system MUST retry the failed change log write or run reconciliation to detect and backfill missing entries. Missing entries MUST be resolved within a bounded time (defined by the implementing service's SLA) so the audit trail remains complete.
16. When a subscription mutation occurs within a database transaction, the change log entry SHOULD be written within the same transaction so the log is consistent with subscription state. Out-of-transaction writes are acceptable only when the mutation itself is not transactional (e.g., a single atomic UPDATE).
17. The change log MUST be queryable by subscription identifier and time range for debugging and support investigations.
18. Change log entries MUST NOT contain sensitive data such as payment tokens, card numbers, or credentials. Payment provider identifiers (e.g., Stripe subscription ID, invoice ID) MAY be included as context.

### Record Creation Order

The creation order below reflects the target lifecycle. This order MUST be enforced only after the existing data model reaches the desired state (rules 1–6 satisfied, early-bird backfill complete).

19. A Cloudflare Worker Durable Object and an infra provider base resource MUST both exist before an instance record is created in `kiloclaw_instance`. Infrastructure MUST be provisioned first; the record is a reflection of existing infrastructure, not a reservation.
20. If either infrastructure component fails to provision, the system MUST NOT create an instance record. Cleanup of any partially provisioned infrastructure is the provisioning service's responsibility.
21. The kiloclaw CF worker service MUST be the sole creator of `kiloclaw_instance` records. No other service or application MAY insert rows into this table.
22. After the instance record is committed, the kiloclaw CF worker service MUST call the kiloclaw-billing service to create the corresponding `kiloclaw_subscription` record. For organizational-context provisioning, this bootstrap MUST create the corresponding organization-funded subscription row. Subscription creation MUST NOT be attempted before the instance record is persisted. This call MUST occur as part of the same provisioning request: the window between instance commit and subscription creation (see rule 4) MUST be bounded to that request's duration. If the primary subscription bootstrap path fails after the instance row is persisted, the provisioning service MUST retry or run a fallback path that creates canonical subscription state before the request exits. The request MUST NOT complete successfully while leaving a silently unpaired instance row. If both primary and fallback bootstrap fail, the provisioning request MUST fail and the instance MUST be explicitly quarantined for remediation, not left as an unnoticed orphan. This quarantine state is the sole temporary exception to rule 4 and MUST NOT be surfaced as a successful provisioned instance.
23. The onboarding flow MUST NOT be considered complete and MUST NOT play the completion "ding" sound until both the instance record and subscription record have been persisted to the database.

## Migration Path

The creation-order rules (19–23) represent the target state. They MUST NOT be enforced until these prerequisites are met:

1. All existing instance records satisfy rules 1–6 (no orphaned instances without subscriptions).
2. Early-bird subscription backfill is complete (rule 6).
3. Any existing code paths that create records in a different order have been updated.

Until these prerequisites are met, the existing creation order remains in effect and the system MUST tolerate records created under the prior ordering.

## Not Yet Implemented

The following rules use SHOULD and reflect intended behavior not yet enforced:

1. Early-bird subscription backfill SHOULD be completed before enforcing the creation-order rules. (Currently, early-bird users may have instance records without subscription records.)
2. The onboarding flow SHOULD gate completion on both records existing. (Currently, the onboarding flow may complete before subscription creation.)
3. The subscription change log (rules 12–18) SHOULD be implemented across all services that mutate subscription records. (Currently, no change log exists; subscription history requires reconstruction from application logs.)

## Changelog

### 2026-05-06 -- Organization KiloClaw ownership

- Added associated-user terminology for organizational instances.
- Clarified organizational instance ownership, billing ownership, per-user-per-org active-instance limits, organization-funded subscription bootstrap, and associated-user GDPR handling.

### 2026-04-15 -- Initial spec

- Record immutability (rules 1–3), including GDPR anonymization.
- Instance–subscription pairing invariant (rules 4–6) and early-bird backfill requirement.
- Multi-instance support with per-context single-instance limit (rules 7–9).
- Primary-key-based record lookup rules (rules 10–11).
- Subscription change log with actor tracking, action labels, before/after state, and transaction semantics (rules 12–18).
- Record creation order and partial-failure handling (rules 19–23).
