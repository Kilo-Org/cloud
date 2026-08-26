# Enterprise Organization Alerts: Monthly Spending

## Role of This Document

This document is a PRD/spec hybrid for enterprise organization alerts and the
first collection-backed alert type, Monthly Spending. It defines product scope,
business rules, and system guarantees.

This document is the source of truth for what the feature MUST guarantee.
Everything up to and including Error Handling is normative. High-Level
Implementation Approach is non-normative orientation: it records which existing
Kilo systems the guarantees should reuse, and it can change without changing the
product contract.

## Status

Draft -- created 2026-08-24; corrected 2026-08-26.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174]
when, and only when, they appear in all capitals.

All monetary amounts in the first release are in USD.

## Summary

Enterprise organization owners, admins, and billing managers need advance
notice when AI usage spend becomes unexpectedly high. Today they can inspect
usage after the fact and configure a low-balance alert, but they cannot ask Kilo
to notify selected people when month-to-date organization AI usage crosses one
or more chosen dollar amounts.

The first release adds a general **Alerts** surface to the organization account.
An organization can create any number of independently identified Monthly
Spending alerts. Each alert has one positive threshold, its own enabled state,
and up to 10 recipients. Kilo queues informational email delivery to each
eligible configured recipient when direct organization AI usage reaches or
exceeds that alert's threshold during the UTC calendar month. Alerts do not
interrupt usage or cap charges.

The New Alert flow has an alert-type dropdown defaulted to **Monthly Spending**.
It also shows disabled **More coming soon** affordance. Alert type selects a
type-specific editor, allowing future types without making the first release a
generic rule builder.

## Customer Problem

Enterprise usage can change quickly as an organization adds members, enables
agents, or adopts more capable models. The people accountable for cost are not
always the people generating usage, and they may not visit usage analytics
frequently. One threshold is insufficient when different teams need staged
notifications or independent recipient groups.

The highest-value intervention is timely awareness, not automatic disruption.
Finance and engineering leaders can investigate usage, communicate with their
teams, adjust policy, or contact Kilo without Kilo taking an
availability-impacting action on their behalf.

## Product Principles

1. **Warn without disrupting.** Alerts are informational only.
2. **Use explicit language.** A threshold or alert is not a budget, limit, or
   cap.
3. **Treat alerts independently.** Every alert has stable identity, lifecycle,
   recipients, and delivery history.
4. **Deduplicate at the alert boundary.** One alert cannot repeatedly notify a
   recipient in one period, while separate alerts may each notify that address.
5. **Match existing billing authority.** Users who can manage organization
   billing can manage alerts.
6. **Expose one extensible home.** Organization alert management belongs under
   **Alerts**, not in a Monthly Spending-specific account destination.
7. **Bound operational work, not customer choice.** There is no product limit
   on alert count; listing and evaluation MUST paginate and batch.
8. **Keep the first type narrow.** Do not revive the discontinued Cost Insights
   system or build a generic automation platform.
9. **Preserve a path to other windows.** Period calculation remains separate
   from spend calculation, crossing detection, and delivery.

## Goals

1. Let authorized enterprise billing users create, edit, disable, re-enable,
   and archive any number of Monthly Spending alerts.
2. Let each alert route email to up to 10 addresses, including finance aliases
   and people who are not Kilo members.
3. Notify recipients reliably when month-to-date AI usage spend reaches that
   alert's amount, without duplicate delivery for that alert and period.
4. Allow the same recipient to receive distinct, intentional emails from
   distinct alerts.
5. Make alert state, type, amount, and recipients understandable on one Alerts
   surface.
6. Establish stable identity, period, persistence, and delivery semantics that
   can support future alert types and windows.
7. Scale listing and evaluation without imposing an artificial alert-count
   limit.

## Non-Goals

The first release does not include:

1. Hard spending caps, request blocking, model blocking, throttling, or agent
   cancellation.
2. Percentage milestones or multiple thresholds inside one alert. Customers
   create separate alerts for separate absolute thresholds.
3. Per-member, group, child-organization, project, repository, model, provider,
   or product thresholds.
4. Parent-plus-child consolidated spending.
5. Daily, weekly, rolling, billing-cycle, quarterly, annual, or custom windows
   in the customer UI.
6. Forecasts, anomaly detection, burn-rate alerts, recommendations, or spend
   attribution in the alert email.
7. Slack, Teams, SMS, push, webhook, or PagerDuty delivery.
8. Repeated reminders from the same alert while spending remains above its
   threshold.
9. A new Cost Insights dashboard or restoration of the discontinued Cost
   Insights product.
10. Migrating the existing low-balance alert to the new alert persistence or
    changing its trigger and delivery behavior.
11. Seat subscription charges, Kilo Pass purchases, KiloClaw compute, Exa,
    Coding Plans, top-ups, taxes, discounts, grants, transfers, expirations,
    refunds, or other balance movements in measured spend.

## Definitions

- **Collection-backed alert**: A durable organization-owned rule with immutable
  identity, a type, type-specific configuration, lifecycle state, recipients,
  and audit history. Unless stated otherwise, **alert** refers to this kind of
  alert; the legacy low-balance setting is excluded.
- **Alert identity**: An opaque, globally unique identifier assigned once at
  creation. It is never reused or derived from mutable configuration.
- **Monthly Spending alert**: An alert that triggers at one positive USD amount
  for a UTC calendar month. It is not an enforced maximum.
- **Measured AI usage spend**: The sum of billed organization AI usage cost in
  canonical organization-attributed `microdollar_usage.cost` records for the
  applicable period. This is the default Cost metric in organization usage
  analytics, not the organization's invoice or all-product Credit consumption.
- **Direct organization spend**: Measured AI usage spend attributed to the
  exact organization ID, excluding parent, child, sibling, and unrelated
  organizations.
- **Period definition**: A typed and versioned description that resolves an
  evaluation time to one stable occurrence identity and one half-open interval.
- **Monthly period**: The UTC calendar month beginning at 00:00:00 UTC on its
  first day and ending at 00:00:00 UTC on the first day of the next month.
- **Period occurrence identity**: A stable identifier for one occurrence of a
  versioned period definition, such as `calendar_month_utc:v1:2026-08`.
- **Alert recipient**: A normalized email address configured on one alert. A
  recipient does not need to be an organization member.
- **Configuration version**: A monotonically increasing revision for an alert,
  changed whenever its threshold, period, lifecycle state, or recipients change.
- **Delivery identity**: Alert identity, period occurrence identity, normalized
  recipient, and channel. Organization and alert type MAY be retained as
  denormalized context but are not substitutes for alert identity. Threshold
  and configuration version are deliberately excluded.
- **Delivery claim**: The durable record for one delivery identity. Creating it
  admits that recipient toward the alert-period cap. The same claim may be
  retried or refreshed only when the provider is known not to have accepted it.
  An accepted or ambiguous provider outcome is terminal for automatic dispatch.
- **Disabled**: A reversible alert state that retains identity and configuration
  but is not evaluated and cannot produce new delivery claims.
- **Archived**: A terminal customer lifecycle state. The alert is omitted from
  default lists and can neither be edited nor re-enabled.
- **Billing manager**: The canonical organization role stored as
  `billing_manager`; product conversations may call it billing admin.

## Users And Jobs

### Primary Users

- Organization owners accountable for overall enterprise usage.
- Organization admins managing day-to-day organization policy.
- Billing managers responsible for invoices and spend oversight.
- Finance or operations recipients who may not hold a Kilo account.

### Jobs To Be Done

1. Notify different stakeholders at different monthly spend amounts.
2. Route alerts to the people who monitor cost, even if they are not Kilo users.
3. Review and manage all organization alerts in one predictable place.
4. Understand that an alert informs me without changing service availability.
5. Avoid repeated email from one alert after its threshold has crossed.

## User Experience

### Alerts Surface

1. The canonical organization account destination MUST be named **Alerts**.
2. **Alerts** MUST appear in organization account navigation for authorized
   billing users regardless of Monthly Spending eligibility, including for
   downgraded organizations and organizations with no configured alerts.
3. The surface MUST list Monthly Spending alerts with stable row identity and
   enough information to distinguish them: type, threshold, enabled/disabled
   state, and recipient summary.
4. The list MUST use cursor pagination or equivalent incremental loading. It
   MUST NOT fetch all alerts or use an unbounded response because the product
   imposes no count limit.
5. Active and disabled alerts MUST appear in the default list. Archived alerts
   MUST be hidden by default and MAY be available through an explicit filter.
6. Create and edit experiences SHOULD follow the organization Group Policy
   interaction model and use `DrawerStack`: list actions open a drawer; nested
   selection or editor panels push and pop without losing list context.
7. The New Alert drawer MUST contain an **Alert type** dropdown defaulted to
   **Monthly Spending**.
8. The type selector MUST show disabled **More coming soon** affordance and MUST
   NOT imply that another type is selectable.
9. Type selection MUST dispatch to a type-specific editor through a typed
   registry/discriminated model comparable to Group Policy editors. Shared
   lifecycle chrome MAY be generic; Monthly Spending fields and validation MUST
   remain owned by its editor.
10. The UI MUST not present an organization-wide maximum alert count.

### Monthly Spending Editor

1. The editor MUST explain before save that the alert is informational and does
   not stop usage or cap charges.
2. It MUST accept one positive USD amount with no more than two decimal places.
3. An enabled alert MUST contain at least one and no more than 10 valid recipient
   email addresses.
4. The editor SHOULD initially suggest the creating user's email address while
   allowing it to be removed or replaced.
5. It MUST disclose that every listed address may receive the organization name
   and measured month-to-date AI usage spend. Saving a new alert or adding any
   recipient address MUST require explicit confirmation.
6. Links delivered to recipients MUST require normal Kilo authentication and
   authorization. Possession of a link MUST NOT grant organization access.
7. The editor MUST show that spending is measured over a UTC calendar month.
8. Saving MUST state that Kilo evaluates the full current month asynchronously
   and may queue email immediately when the threshold is already crossed.
9. Saving MUST NOT require synchronous usage aggregation.
10. If 10 distinct recipients have already been admitted for the alert-period,
    the editor MUST explain that a newly added address without an existing claim
    cannot receive that alert until the next period.
11. Edit actions MUST clearly distinguish **Disable** from terminal **Archive**.
12. Archive MUST require confirmation that the alert cannot be restored.

### Existing Low-Balance Alert

1. **Alerts** MUST also represent the existing low-balance alert so users do not
   need to know a second canonical destination for organization alerts.
2. For this release it remains one legacy organization setting and retains its
   existing editor, persistence, crossing, and delivery behavior. The Alerts
   surface MAY render it as a dedicated legacy row/card that opens the existing
   editor; it MUST NOT synthesize collection alert identities for it.
3. Existing payment-details entry points MAY remain as links that open or route
   to the low-balance control on Alerts. No broader payment-details redesign is
   required.
4. The UI MUST distinguish the opposite conditions: Monthly Spending means AI
   usage spend became high; Low Balance means available balance became low.

### Alert Email

1. The subject MUST state that the organization's monthly AI usage spend crossed
   the configured threshold.
2. The body MUST include organization name, configured threshold, measured
   month-to-date AI usage spend as of evaluation, UTC monthly period, a link to
   usage or Alerts, and a statement that usage is not interrupted or capped.
3. The email MUST describe the amount as AI usage spend, not an exact invoice
   total, and concisely indicate that other Kilo products and charges are
   excluded.
4. It MUST NOT expose member-level usage or sensitive attribution.
5. It SHOULD concisely state what crossed, for which organization, what effect
   it has, and where to manage the alert.

## Functional Rules

Unless a rule explicitly mentions the existing low-balance setting, this
section governs collection-backed Monthly Spending alerts only. Low Balance
retains its existing authorization, configuration, persistence, and delivery
contract for this release.

### Eligibility And Authorization

1. Only Enterprise organizations MUST be able to create or enable Monthly
   Spending alerts, add recipients, or change threshold or period.
2. Subject to the entitlement rules below, owners, admins, and billing managers
   MUST be able to view, create, edit, disable, re-enable, and archive alerts.
   `canManageOrganizationBilling` is the authoritative role predicate.
3. Ordinary members MUST NOT be able to view recipient addresses or manage
   alerts.
4. Authorization MUST be enforced by the server, not route visibility alone.
5. Existing parent-to-direct-child billing authority inheritance MUST apply.
   It MUST NOT change spend scope, which remains the exact target organization.
6. Creating or enabling an alert, adding any recipient address, or changing
   threshold or period MUST use the effective subscription/trial eligibility
   required by other billing mutations.
7. Authorized billing users MUST be able to disable, archive, or remove
   recipients after active entitlement is lost or the organization is
   downgraded. Loss of entitlement MUST NOT trap a disclosure configuration.
8. Evaluation and dispatch require an existing, non-deleted Enterprise
   organization and an enabled alert. They do not independently require an
   active seat subscription because already-recorded usage may still cross.
9. On downgrade from Enterprise, all enabled Monthly Spending alerts MUST be
   retained and disabled. Returning to Enterprise MUST NOT re-enable them.

### Alert Identity And Persistence

1. An organization MAY create any number of Monthly Spending alerts. There is
   no product or API count ceiling.
2. Every created alert MUST receive a new immutable alert identity, even when
   its configuration exactly matches a current or archived alert.
3. Alert identity MUST remain stable across edits, disable/re-enable cycles,
   recipient changes, threshold changes, and plan downgrades.
4. Alert type MUST be immutable after creation. Selecting a different type
   requires creating an alert with a new identity.
5. Monthly Spending alerts MUST use dedicated collection persistence, not
   organization JSON settings. Persistence MUST support organization ownership,
   type, type-specific configuration, lifecycle state, configuration version,
   creation/update/archive timestamps, and actor/audit attribution.
6. Delivery attempts/claims MUST use dedicated durable persistence with a
   uniqueness invariant over delivery identity. They MUST NOT rely only on the
   current alert row or ephemeral job state.
7. Organization deletion MUST remove or irreversibly anonymize recipient PII in
   accordance with organization retention policy while preserving only the
   operational evidence policy permits.
8. Queries MUST scope alert identity by organization authorization even if the
   identifier is globally unique.

### Configuration

1. Each Monthly Spending alert has exactly one threshold and one explicit
   period definition.
2. Threshold MUST be greater than zero, represented as integer microdollars at
   persistence and calculation boundaries, and remain within JavaScript's safe
   integer range after conversion.
3. Recipient addresses MUST be validated, trimmed, case-normalized for identity,
   and deduplicated within an alert.
4. An enabled alert MUST have 1-10 current recipients. A disabled alert MAY have
   zero recipients to permit safe disclosure removal.
5. At most 10 distinct recipients may be admitted to delivery for one alert and
   period, including addresses removed or replaced after a claim. This bound is
   alert-scoped, not organization-scoped, and admission MUST enforce it
   atomically under concurrent evaluators.
6. One address MAY be configured on any number of alerts. Recipient limits and
   delivery history on one alert MUST NOT consume capacity or suppress delivery
   on another alert.
7. Period definition MUST be explicit; monthly behavior MUST NOT be inferred
   from a missing field or 30-day duration.
8. Every material change MUST increment configuration version and create an
   audit event identifying actor and material change. Audit output MUST minimize
   recipient PII while recording recipient count and disclosure confirmation.
9. Concurrent edits MUST not silently overwrite a newer configuration; the API
   MUST use optimistic concurrency or equivalent conflict detection.

### Lifecycle

1. Create MUST atomically persist a new alert identity and initial configuration.
   A successfully created alert is enabled unless the user explicitly saves it
   disabled.
2. Edit MUST mutate the same alert identity, increment configuration version,
   and re-evaluate the current period asynchronously when relevant.
3. Disable MUST retain identity, configuration, history, and delivery claims;
   stop new evaluation and claims; and cancel not-yet-submitted stale work.
4. Re-enable MUST retain identity and delivery history. It MUST NOT create a
   second delivery identity for that alert-period. An existing claim may resume
   only under the retry rules in Delivery.
5. Archive MUST be terminal, retain identity and audit/delivery history, stop
   evaluation, and make the alert unavailable for edit or re-enable.
6. To replace an archived alert, the user creates a new alert. Recreation MUST
   receive a new identity and therefore MAY deliver in the same period even if
   threshold and recipients match the archived alert.
7. Lifecycle changes MUST be idempotent under retries. Invalid transitions,
   including editing or enabling an archived alert, MUST be rejected.

### Period Semantics

1. The first release MUST support one period definition, `calendar_month_utc`.
2. A monthly period MUST use `[period start, period end)`. Usage exactly at the
   start is included; usage exactly at the next start is excluded.
3. A monthly period MUST NOT be implemented as a rolling 30-day duration.
4. Evaluation MUST consume a resolved occurrence identity and interval rather
   than embed month arithmetic in threshold or delivery logic.
5. Definition type and version MUST be part of occurrence identity so different
   timezone, anchor, or policy semantics cannot collide.
6. Unsupported period definitions MUST be rejected, not interpreted as monthly.
7. Future rolling or overlapping windows MUST define episode/reset semantics;
   a moving interval MUST NOT create a new occurrence on every evaluation.

### Spend Semantics

1. Measured AI usage spend MUST equal signed canonical
   `microdollar_usage.cost` attributed to the exact organization in the period.
2. It MUST use billed cost, not estimated market cost.
3. It MUST include usage earlier in the current period when an alert is created
   later in that period.
4. Corrective rows MUST affect spend according to their signed canonical cost.
5. Exa, Coding Plans, KiloClaw compute, seats, balance purchases, grants,
   transfers, expirations, and refunds MUST NOT count as measured AI usage.
6. Parent and child organizations MUST be measured independently.
7. Displayed and emailed amounts MAY lag recent usage and MUST NOT promise
   real-time or invoice-final accuracy.

### Crossing And Reconfiguration

1. An alert is crossed when measured spend is greater than or equal to its
   threshold. No claim may be created below threshold.
2. A new or changed enabled alert MUST be evaluated against the full current
   period. If already crossed, eligible recipients are queued on the next
   successful evaluation.
3. A recipient MUST have at most one delivery claim for the same alert identity,
   period occurrence, and channel, regardless of edits or disable/re-enable.
4. Separate alert identities are separate customer instructions. If two alerts
   cross, an address configured on both MAY receive one email from each, even
   when threshold and other configuration are identical.
5. Adding a recipient after crossing makes that recipient eligible if fewer than
   10 recipients have been admitted for that alert-period. An existing claim for
   the recipient MUST be reused rather than creating a second delivery identity.
6. Removing a recipient prevents an unclaimed delivery and cancels an existing
   claim that has not been submitted. Provider-accepted work cannot be recalled.
7. Editing a threshold MUST NOT create a second delivery identity for an
   already-admitted recipient in that alert-period. An unsubmitted or retryable
   claim may proceed only if the current threshold is crossed.
8. A new period makes all current recipients independently eligible for each
   enabled alert.
9. Evaluation MUST cover only the open current period. It MUST NOT send a closed
   prior-period alert using current configuration.
10. An outage spanning a period boundary MAY omit prior-period email. The missed
    evaluation MUST be observable; historical configuration catch-up is deferred.

### Pagination And Evaluation

1. Customer list APIs MUST use deterministic keyset/cursor pagination with a
   documented stable order and bounded page size. Offset pagination SHOULD NOT
   be used for the unbounded alert collection.
2. Scheduled evaluation MUST discover enabled alerts through bounded pages or
   partitions. No query, transaction, or invocation may load every alert.
3. Each page, aggregation query, enqueue operation, and worker invocation MUST
   have explicit size/runtime bounds and a resumable cursor or checkpoint.
4. Concurrent creation, edits, disablement, and archival MUST not permanently
   skip an alert. Checkpoint design MUST tolerate mutations and periodically
   start a complete new scan or use a due-time index.
5. Work SHOULD be partitioned or queued so one organization with many alerts
   cannot starve others. Spend MAY be aggregated once per organization-period
   and compared against paginated alerts without merging alert identities.
6. Under normal operation every enabled alert SHOULD be evaluated at least
   hourly, regardless of total alert count. Backlog age and oldest unevaluated
   alert MUST be observable.
7. The system MUST apply backpressure rather than create unbounded jobs or run
   past platform limits. Capacity, not a hidden customer count cap, is the
   remedy for sustained backlog.

### Delivery

1. Under normal operation, first delivery attempt SHOULD begin within two hours
   after Kilo's recorded usage crosses an alert threshold.
2. Claim creation and per-recipient dispatch MUST be idempotent under concurrent
   evaluators, retries, and overlapping jobs.
3. The system MUST durably claim delivery identity before calling the provider.
   Before the provider call it MUST durably mark that attempt as submitting.
   Expired pre-submission work MAY be reclaimed; expired submitting work without
   a recorded outcome is ambiguous and MUST NOT be retried automatically.
4. A definitive failure before provider acceptance MUST be observable and
   retryable without permanently suppressing delivery.
5. An ambiguous provider outcome MUST retain its claim and MUST NOT retry
   automatically, because retry could duplicate email.
6. Provider acceptance MUST retain the claim so later evaluation cannot submit
   that delivery identity again.
7. Email failure MUST NOT affect usage recording.
8. Before send, dispatch MUST re-read organization and alert. Alert identity,
   claimed configuration version, threshold, period, enabled state, plan
   eligibility, and recipient MUST still match. Here plan eligibility means the
   organization remains Enterprise, not that its seat subscription is active.
   Stale work MUST be canceled. If submission has not begun and the provider is
   known not to have accepted it, the same claim MAY be atomically refreshed for
   current eligible configuration; stale workers MUST be unable to submit the
   refreshed claim, and a second claim MUST NOT be created.
9. Logs MUST use stable organization, alert, and delivery identifiers without
   recipient addresses or unnecessary PII.
10. Exactly-once receipt cannot be guaranteed after provider acceptance. An
    ambiguous delivery is preferably omitted rather than automatically duplicated.
11. The recipient component of persisted delivery identity MUST NOT expose the
    email address or use a guessable unkeyed digest.

## Error Handling

1. Invalid thresholds, unsupported periods, missing recipients on enabled
   alerts, and invalid addresses MUST be rejected before persistence.
2. Unauthorized requests MUST be rejected without revealing alert existence or
   recipient addresses.
3. Spend-query failure MUST skip affected work, remain observable, and retry in
   a later evaluation.
4. Failure for one organization, alert, page, or recipient MUST NOT prevent all
   other evaluation or delivery.
5. If current plan, lifecycle, or configuration cannot be confirmed before
   provider submission begins, dispatch MUST fail closed. That pre-submission
   work remains retryable; work with an ambiguous provider outcome does not.
6. Invalid or expired list cursors MUST produce a recoverable client response;
   clients MUST be able to restart pagination without data loss or duplication
   causing a mutation.
7. Evaluation after a period boundary MUST use the new open period and MUST NOT
   attribute new-period usage to the closed period.

## Success Measures

The initial release is successful when:

1. Authorized users can create and independently manage multiple alerts without
   a product count limit, and list latency remains within the product SLO at the
   maximum supported page size.
2. At least 95% of crossed alerts without provider failure begin first delivery
   attempt within two hours, measured per alert identity.
3. Persistence uniqueness prevents repeated or concurrent evaluation from
   creating a second claim or concurrent provider call for one delivery
   identity; any later attempt reuses the claim under the retry rules.
4. Tests and production evidence confirm that two crossed alerts may each email
   the same normalized recipient while edits to one alert cannot resend its own
   delivery identity.
5. Evaluation remains bounded and resumable, and backlog metrics demonstrate
   that every enabled alert is reached within the evaluation cadence at expected
   production volume.
6. Configuration and delivery failures do not affect usage ingestion or service
   availability.
7. Support can determine whether a specific alert was created, changed,
   crossed, attempted, sent, skipped, disabled, or archived without inspecting
   recipient PII in application logs.
8. Qualitative feedback shows recipients understand email is informational and
   users can distinguish Monthly Spending from Low Balance.

Adoption, alerts per organization, recipient overlap, and threshold changes
will inform future alert types and delivery channels. These metrics MUST NOT be
used to impose an undocumented count ceiling.

## High-Level Implementation Approach

### Alert Domain And API

Introduce dedicated organization-alert persistence with an immutable ID,
organization ID, discriminated type, lifecycle state, type-specific
configuration, configuration version, and lifecycle timestamps. Store normalized
recipients with the alert configuration so they can be validated and revalidated.
Keep delivery claims/history in dedicated persistence unique on alert, period
occurrence, normalized-recipient identity, and channel.

Expose cursor-paginated list and authorized create/get/update/disable/enable/
archive operations. Use optimistic concurrency for edits. New types register
their schema, editor, evaluator, and presentation metadata through explicit
discriminated boundaries rather than conditionals spread across generic UI.

Record actor and material change in the existing organization audit log with new
alert lifecycle actions, the way Group Policy does, rather than in a per-alert
audit table. That surface already carries actor identity, is filterable by the
organization audit log UI, and already strips actor PII on user deletion. Alert
rows themselves carry no actor columns and no recipient plaintext beyond the
configured recipients they must revalidate.

### Alerts UI

Use the Group Policy and `DrawerStack` patterns as interaction prior art: a
paginated Alerts list remains mounted while create/edit drawers and nested
panels are pushed. The New Alert panel owns the type dropdown, defaults to
Monthly Spending, displays disabled **More coming soon**, and renders the
registered Monthly Spending editor. Do not build controls for unavailable types.

Render the existing low-balance control on this surface through an adapter to
its existing modal/settings API. Do not migrate its data or delivery path in
this release.

### Period Resolution And Spend Evaluation

Resolve a period definition and timestamp to stable occurrence identity,
inclusive start, and exclusive end. Spend aggregation, crossing, and delivery
consume that representation.

Scan due alerts in bounded keyset pages/partitions. Aggregate current UTC period
spend by organization where practical, then compare it independently with each
alert. A due-time index, resumable cursor, queue, or equivalent MUST prevent
full-table loading and starvation. The exact page size and partition strategy
should follow production query plans and platform runtime limits.

The existing `microdollar_usage_daily` rollup may reduce reads for completed
UTC days but is asynchronously repaired. A reliable strategy can combine safe
completed-day rollups with canonical current-day usage and confirm canonical
spend near a threshold. Do not add alert writes to usage-ingestion transactions.

### Idempotency And Email

Use focused delivery persistence because alert lifecycle, alert-scoped
deduplication, bounded retries, and support diagnosis are first-class domain
requirements. Claim a deterministic alert-scoped delivery identity before send;
durably distinguish pre-submission from submitting work; refresh or retry only
when the provider is known not to have accepted it; and retain ambiguous or
accepted claims according to recipient PII policy.

Uniqueness on delivery identity is what prevents duplicate claims. The separate
10-recipient admission cap needs serialized counting, not more columns: take a
per-alert transaction-scoped advisory lock, as organization Group Policy does,
count that alert-period's existing claims, and insert within the same
transaction. Prune old claims on a retention cutoff over existing timestamps,
the way other Kilo retention jobs do.

Create a dedicated template and sender. Link to organization usage or Alerts,
never the discontinued Cost Insights route.

### Observability

Expose page/partition progress, scan duration, checkpoint age, oldest due alert,
configurations evaluated, crossings, claims, duplicate claims, sends, failures,
stale cancellations, and ineligible skips. Capture stable organization, alert,
and delivery identifiers without recipient PII.

## Prior Art And Constraints

### Existing Low-Balance Alert

Kilo stores one organization minimum-balance threshold and recipient emails in
organization settings, authorizes changes through billing procedures, and sends
when balance crosses below the threshold. Its configuration UI is useful prior
art, but it remains a separate legacy alert integrated into Alerts at the
presentation/navigation layer only.

### Group Policy And DrawerStack

Organization Group Policy provides the intended extensibility model: shared
collection and lifecycle presentation dispatches to a discriminated,
type-specific editor. `DrawerStack` provides nested create/edit navigation while
preserving list context. Alerts SHOULD follow these patterns rather than use one
large editor with optional fields for hypothetical alert types.

### Discontinued Cost Insights

The former Cost Insights system included personal and organization thresholds,
rolling windows, rollups, anomaly detection, suggestions, event state, and an
outbox. It was removed in August 2026. This feature MUST treat it as design prior
art, not a subsystem to restore.

Retain integer microdollars, half-open windows, durable crossing identities,
separation of alert and delivery identity, retryable claims, and recipient
revalidation. Do not restore rolling-window fragmentation, anomaly machinery,
personal ownership, Cost Insights routes, or ingestion coupling.

### External Prior Art

Anthropic and OpenAI distinguish informational spend alerts from limits. Cursor
supports multiple custom absolute alerts. GitHub, Google Cloud, and AWS show the
eventual breadth and operational demands of budget systems but are not the MVP
scope. Research sources from the initial draft:

- [Anthropic rate and spend limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Cursor spend alerts](https://cursor.com/help/account-and-billing/spend-alerts)
- [GitHub budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)
- [OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
- [Google Cloud budgets and alerts](https://cloud.google.com/billing/docs/how-to/budgets)
- [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)

## Risks And Mitigations

1. **Duplicate or unintentionally suppressed email.** Key durable uniqueness by
   alert identity, occurrence, recipient, and channel; never organization alone.
2. **Unbounded collection work.** Use keyset pagination, bounded partitions,
   resumable checkpoints, fair scheduling, backpressure, and backlog metrics.
3. **Customers interpret alerts as caps.** Use alert/threshold language and
   repeat the informational disclaimer in UI and email.
4. **Emails reach unintended recipients.** Limit each Monthly Spending alert to
   10 recipients, confirm disclosure, audit the actor, revalidate before send,
   and disable on downgrade.
5. **Spend differs from invoices.** Label AI usage spend, document exclusions,
   and link to usage rather than invoices.
6. **Rollup lag or boundary outage misses crossings.** Confirm near-threshold
   canonical totals and monitor evaluation age; do not send prior-period mail
   without historical evidence.
7. **Generic alert architecture revives Cost Insights.** Keep one implemented
   type, one period, one channel, and type-owned editors/evaluators.
8. **Low-balance migration expands scope.** Integrate only its navigation and
   presentation; preserve its current persistence and behavior.

## Future Opportunities

Future evidence may justify other alert types, windows, role-based recipients,
webhooks, parent/child scopes, percentage milestones, or forecasts. The type
registry and period boundary permit those additions without promising them now.

Hard caps remain a separate product requiring request-path enforcement,
in-flight usage semantics, blocked-user UX, recovery rules, and availability
safeguards. They MUST NOT be inferred from this design.

## Acceptance Scenarios

1. An enterprise admin creates alerts A at $500 and B at $1,000 for the same
   organization. Both have immutable, distinct identities and appear in Alerts.
2. New Alert opens with type **Monthly Spending** selected and a Monthly
   Spending editor. **More coming soon** is visible but cannot be selected.
3. The organization has $499.99 direct AI usage spend. Neither alert sends.
4. Spend reaches exactly $500. In a successful provider interaction, one
   informational email per recipient on A is accepted; B does not send.
5. Spend reaches $1,000. One email per recipient on B is accepted. A does not
   send again.
6. The same normalized address is on A and B. One email from each alert may be
   accepted because delivery identities contain different alert IDs.
7. Concurrent/repeated evaluation above both thresholds creates no second claim
   or concurrent provider call for either alert-recipient-period identity. Any
   later attempt reuses its claim and follows the retry rules.
8. An admin lowers A after it has sent, or disables and re-enables A in the same
   month. No second delivery identity or provider submission is created for a
   recipient whose prior claim was accepted or ambiguous.
9. An admin adds a new recipient to crossed A. That recipient is eligible if A
   has admitted fewer than 10 distinct recipients this period. Recipient counts
   and history on B do not affect A.
10. An admin archives A. A disappears from the default list, cannot be edited or
    enabled, and produces no new claims.
11. The admin recreates A's exact threshold and recipients. The new alert C has
    a new identity and may send in the current period independently of A's
    history.
12. Active and disabled alert lists load in bounded cursor pages with stable
    ordering. Creating or archiving alerts during pagination does not cause
    permanent evaluator omission.
13. An organization has more alerts than fit in one evaluation page. Resumable,
    fair processing reaches every page without loading all records or starving
    another organization.
14. At the next UTC month boundary, prior usage no longer applies and current
    recipients become independently eligible for every enabled alert.
15. A child organization crosses an alert. Parent spend is excluded and parent
    alerts are unaffected.
16. Downgrading to Teams disables all enabled Monthly Spending alerts and a
    return to Enterprise does not re-enable them.
17. A definitive provider failure or expired pre-submission attempt retries
    without affecting usage. An expired submitting attempt without a recorded
    outcome is ambiguous, retains its claim, and requires operator reconciliation.
18. A threshold or recipient edit races with claimed work. Stale version work
    is canceled before submission; the same claim may be refreshed if the
    current configuration remains eligible.
19. An ordinary member and non-member cannot read recipient lists or mutate an
    alert. Billing authority follows `canManageOrganizationBilling`, including
    its direct-child rules.
20. Usage at the exact UTC month start is included; usage at the next month
    start is excluded. Exa, KiloClaw, Coding Plans, and seats do not advance the
    threshold.
21. Organization account navigation opens Alerts for an authorized billing user.
    The surface shows Low Balance as a distinct legacy control and opens its
    existing editor without moving its settings or changing its delivery.
22. After 10 distinct recipients are admitted for A in one period, replacing
    addresses cannot create more A deliveries until the next period. Another
    alert remains independently eligible for up to 10 recipients.
23. An entitled organization creates two otherwise identical alerts. Both are
    retained as intentional independent rules rather than deduplicated at save.
24. An archived-alert edit, enable, or reuse-ID request is rejected. Retried
    disable/archive requests are idempotent.

## Open Implementation Questions

These do not change the product contract and should be resolved from production
evidence:

1. Exact maximum page size, evaluation partition size, and checkpoint strategy.
2. Whether enabled-alert volume favors organization-first spend aggregation or
   due-alert-first grouping.
3. Whether canonical grouped queries suffice or completed-day rollups plus
   canonical current-day reads are required.
4. The threshold input maximum below the safe-integer ceiling.

## Changelog

### 2026-08-26 -- Corrected collection contract

- Replaced the singleton threshold with any number of independently identified
  alerts on the general organization Alerts surface.
- Defined type-selecting DrawerStack UI, stable identity, dedicated persistence,
  complete lifecycle semantics, and new identity on recreation.
- Scoped recipient limits and delivery deduplication to alert identity so
  separate alerts may intentionally email the same address.
- Required paginated listing and bounded, resumable, fair evaluation without a
  product count limit.
- Integrated existing Low Balance at the surface only, without migrating its
  persistence or behavior.

### 2026-08-24 -- Initial draft

- Defined alert-only direct organization AI usage spend, UTC calendar-month
  semantics, billing authorization, recipient privacy, and email guarantees.
- Recorded prior art and the decision not to restore Cost Insights.
