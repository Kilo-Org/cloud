# KiloClaw Data Model

## Role of This Document

This spec defines the business rules and invariants for the KiloClaw
data model — specifically the `kiloclaw_instance` and
`kiloclaw_subscription` tables and the relationships between them. It
is the source of truth for _what_ the system is required to guarantee
about record existence, immutability, lookup patterns, and creation
order.
It deliberately does not prescribe _how_ to implement those
guarantees: column layouts, migration strategies, backfill scripts,
and other implementation choices belong in plan documents and code,
not here.

Multiple services and apps operate on this data model (the web app,
the kiloclaw CF worker service, the kiloclaw-billing service, and
background jobs). All consumers MUST comply with the rules below.

## Status

Draft — created 2026-04-15.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

## Definitions

- **Instance record**: A row in `kiloclaw_instance` representing a
  KiloClaw instance, whether or not the underlying infrastructure
  (CF worker Durable Object and infra provider resources) still exists.
- **Subscription record**: A row in `kiloclaw_subscription`
  representing a billing subscription tied to a specific instance.
- **Destroyed instance**: An instance record whose underlying
  infrastructure has been torn down. The record persists with a
  destroyed marker.
- **Early-bird subscriber**: A user who purchased early-bird access
  before the subscription billing system was available. These users
  have instance records but may lack subscription records until
  backfill is complete.
- **Subscription change log entry**: A row in the subscription audit
  log that captures a single mutation to a `kiloclaw_subscription`
  record — what changed, when, and who or what caused it.
- **Actor**: The entity responsible for a subscription mutation.
  An actor is either a user (identified by user ID) or the system
  (identified by a service or process name).
- **Context**: The ownership scope of an instance — either
  _personal_ (not associated with any organization) or
  _organizational_ (associated with a specific organization). A user
  has one personal context and one organizational context per
  organization they belong to.
- **Active instance**: An instance record that has not been marked
  as destroyed.
- **Mutation**: Any database write (INSERT or UPDATE) to a
  `kiloclaw_subscription` row that changes one or more of its
  business-relevant fields (status, plan, billing period, payment
  source, cancellation flags, suspension state, etc.). Automated
  timestamp updates (e.g., `updated_at`) that occur without any
  other field change are not mutations for change log purposes.
- **Infra Provider**: The backing service provider where we provision compute and storage and onto which we actually deploy OpenClaw. For example fly.io, docker-local, Northflank.
- **Infra Provider Base Resource**: Some infra providers have base top-level organizational resource that must exist. For example fly.io has a app concept, Northflank has projects.

## Overview

The KiloClaw data model centers on two core entities: instances and
subscriptions. An instance record tracks the existence and state of a
KiloClaw hosted environment. A subscription record tracks the billing
relationship that funds that instance. Together they form the
foundation that the web app, CF worker services, billing service, and
background jobs all rely on.

The data model supports multiple instances per user or organization,
though the system currently limits provisioning to one active instance
per user per context (personal, and each organization the user belongs
to) via UI and router constraints. These constraints are enforced at
the application layer, not the data layer, so removing them in the
future requires no schema changes.

A subscription change log provides a complete audit trail of every
mutation to a subscription record. Because subscriptions are never
deleted and are mutated by multiple services (web app, kiloclaw CF
worker, kiloclaw-billing service, background jobs, and payment
provider webhooks), the change log gives operators and support a
reliable history of what happened, when, and why — without relying
on application logs that may be rotated or incomplete.

## Rules

### Record Immutability

1. An instance record MUST NOT be deleted from `kiloclaw_instance`,
   even after the underlying infrastructure (CF worker Durable Object
   and infra provider resources) is destroyed. Destroyed instances MUST be marked as
   destroyed rather than removed.
2. A subscription record MUST NOT be deleted from
   `kiloclaw_subscription`. Subscription lifecycle transitions
   (cancellation, expiry, etc.) MUST be represented as status changes
   on the existing record, never as row deletion.
3. When a user account is deleted (e.g., GDPR right-to-erasure),
   instance and subscription records MUST be retained. Ownership
   references MUST be anonymized rather than cascaded or removed.
   Foreign key constraints on these tables MUST NOT cascade deletes
   from parent tables.

### Instance–Subscription Relationship

4. Every instance record MUST have a corresponding subscription
   record. This is an eventually-consistent invariant: during the
   creation sequence (rules 19–23), a brief window exists between
   the instance INSERT and the subscription INSERT where the
   instance has no subscription. Outside that bounded creation
   window, there MUST NOT exist an instance record without a
   subscription record. This invariant is enforced at the
   application layer; the creation-order rules define the sequence
   that satisfies it.
5. Each subscription record MUST reference exactly one instance. The
   relationship is one-to-one: at most one subscription per instance
   (see kiloclaw-billing.md, Plans rule 5).
6. Early-bird subscribers who have instance records without
   subscription records are a known violation of rule 4. These
   MUST be resolved by backfilling subscription records for all
   early-bird instances. Until backfill is complete, code that
   queries subscriptions for early-bird users MUST treat the user
   as having earlybird-only access (no active subscription) and
   MUST NOT throw an unhandled error or return an error response.

### Multi-Instance Support

7. The data model MUST accommodate multiple instances per user or
   organization. No schema-level constraint SHALL restrict a user or
   organization to a single instance.
8. The system MUST limit provisioning to one active instance per
   user per context. A user MAY have one active instance in their
   personal context and one active instance in each organization
   they belong to, simultaneously. The limit is per context, not
   per user globally. This limit MUST be enforced at the UI and
   router layer, not at the database layer.
9. When the single-instance limit is relaxed in the future, no
   schema migration SHALL be required.

### Record Lookup

10. Fetching a single record from `kiloclaw_instance` or
    `kiloclaw_subscription` SHOULD use the table's primary key;
    non-primary-key lookups are acceptable only when the caller does
    not yet know the primary key (e.g., initial resolution from an
    external identifier). Queries MUST NOT rely on fuzzy matching,
    partial string comparison, or heuristic selection to locate a
    specific record.
11. When a query requires filtering by user, organization, or other
    non-primary-key attributes (e.g., listing all instances for a
    user), the query MUST use exact equality on indexed columns.

### Subscription Change Log

Every mutation to a `kiloclaw_subscription` record MUST be
accompanied by a change log entry. The change log is append-only
and serves as the authoritative audit trail for subscription state.

12. Each service or process that mutates a subscription record MUST
    write the corresponding change log entry. This includes
    creation, status transitions, plan changes, billing period
    advancement, payment source changes, cancellation, reactivation,
    suspension, destruction scheduling, and any other mutation.
13. Each change log entry MUST capture the following information:
    a. The subscription identifier (foreign key to the subscription
    record).
    b. A timestamp of when the change occurred. The timestamp MUST
    be the database server's current time at the moment of
    insertion, not the application's wall clock or an external
    event timestamp.
    c. The actor type: `user` or `system`.
    d. The actor identifier: for user actors, the user ID; for
    system actors, a service or process name (e.g.,
    `kiloclaw-billing`, `kiloclaw-worker`, `billing-lifecycle-job`,
    `stripe-webhook`, `credit-renewal-sweep`).
    e. The action performed, as a descriptive label (e.g.,
    `created`, `status_changed`, `plan_switched`,
    `period_advanced`, `canceled`, `reactivated`, `suspended`,
    `destruction_scheduled`, `reassigned`). All services MUST use
    consistent action labels. New labels MUST be documented before
    use.
    f. Sufficient detail to reconstruct the state of the
    subscription before and after the mutation. For the initial
    creation entry, the prior state MUST be recorded as absent.
    g. An optional context or reason string providing additional
    detail (e.g., `stripe_invoice:inv_xxx`, `insufficient_credits`,
    `user_requested`, `trial_expired`).
14. Change log entries MUST NOT be updated or deleted. The log is
    strictly append-only.
15. When the change log entry is written in the same database
    transaction as the mutation, a change log failure that aborts
    the transaction is acceptable — the entire operation will be
    retried. When no enclosing transaction exists, a change log
    failure MUST NOT prevent the mutation from succeeding; the
    system MUST log the failure and proceed. The system MUST
    retry the failed change log write or run a reconciliation
    process that detects and backfills missing entries. Missing
    entries MUST be resolved within a bounded time (defined by
    the implementing service's SLA) so the audit trail remains
    complete.
16. When a subscription mutation occurs within a database
    transaction, the change log entry SHOULD be written within the
    same transaction so that the log is consistent with the
    subscription state. Out-of-transaction writes are acceptable
    only when the mutation itself is not transactional (e.g., a
    single atomic UPDATE).
17. The change log MUST be queryable by subscription identifier and
    by time range to support debugging and support investigations.
18. Change log entries MUST NOT contain sensitive data such as
    payment tokens, card numbers, or credentials. Payment provider
    identifiers (e.g., Stripe subscription ID, invoice ID) MAY be
    included as context.

### Record Creation Order

The creation order below reflects the target lifecycle. This order
MUST be enforced only after the existing data model has been brought
into the desired state (rules 1–6 satisfied, early-bird backfill
complete).

19. A Cloudflare Worker Durable Object and a infra provider base resource MUST both exist
    before an instance record is created in `kiloclaw_instance`.
    Infrastructure MUST be provisioned first; the record is a
    reflection of existing infrastructure, not a reservation.
20. If either infrastructure component fails to provision, the system
    MUST NOT create an instance record. Cleanup of any partially
    provisioned infrastructure is the responsibility of the
    provisioning service.
21. The kiloclaw CF worker service MUST be the sole creator of
    `kiloclaw_instance` records. No other service or application
    MAY insert rows into this table.
22. After the instance record has been committed to the database,
    the kiloclaw CF worker service MUST call the kiloclaw-billing
    service to create the corresponding `kiloclaw_subscription`
    record. Subscription creation MUST NOT be attempted before the
    instance record is persisted. This call MUST occur as part of
    the same provisioning request — the window between instance
    commit and subscription creation (see rule 4) MUST be bounded
    to the duration of that request. If subscription creation
    fails, the provisioning service MUST retry or mark the instance
    as requiring remediation so the orphan is not silently ignored.
23. The onboarding flow MUST NOT be considered complete (and MUST NOT
    play the completion "ding" sound) until both the instance record
    and the subscription record have been persisted to the database.

## Migration Path

The creation-order rules (19–23) represent the target state. They
MUST NOT be enforced until the following prerequisites are met:

1. All existing instance records satisfy rules 1–6 (no orphaned
   instances without subscriptions).
2. Early-bird subscription backfill is complete (rule 6).
3. Any existing code paths that create records in a different order
   have been updated.

Until these prerequisites are met, the existing creation order
remains in effect and the system MUST tolerate records created under
the prior ordering.

## Not Yet Implemented

The following rules use SHOULD and reflect intended behavior that is
not yet enforced in the current codebase:

1. Early-bird subscription backfill SHOULD be completed before
   enforcing the creation-order rules. (Currently, early-bird users
   may have instance records without subscription records.)
2. The onboarding flow SHOULD gate completion on both records
   existing. (Currently, the onboarding flow may complete before
   subscription creation.)
3. The subscription change log (rules 12–18) SHOULD be implemented
   across all services that mutate subscription records. (Currently,
   no change log exists; subscription history can only be
   reconstructed from application logs.)

## Changelog

### 2026-04-15 -- Initial spec

- Record immutability (rules 1–3), including GDPR anonymization.
- Instance–subscription pairing invariant (rules 4–6) with
  early-bird backfill requirement.
- Multi-instance support with per-context single-instance limit
  (rules 7–9).
- Primary-key-based record lookup rules (rules 10–11).
- Subscription change log with actor tracking, action labels,
  before/after state, and transaction semantics (rules 12–18).
- Record creation order and partial-failure handling (rules 19–23).
