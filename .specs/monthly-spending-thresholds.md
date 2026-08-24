# Enterprise Organization Monthly Spending Thresholds

## Role of This Document

This document is a PRD/spec hybrid for enterprise organization spending alerts.
It defines the customer problem, product scope, success criteria, business rules,
and system guarantees for the first release. It also describes the intended
implementation at a high level so scope and architectural boundaries can be
reviewed together.

This document is the source of truth for _what_ the feature must guarantee.
Names of handlers, database columns, components, and queries belong in a later
implementation plan and in code.

## Status

Draft -- created 2026-08-24.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
"SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174]
when, and only when, they appear in all capitals, as shown here.

All monetary amounts in the first release are in USD.

## Summary

Enterprise organization owners, admins, and billing managers need advance
notice when AI usage spend becomes unexpectedly high. Today they can inspect
usage after the fact and configure a low-balance alert, but they cannot ask Kilo
to notify selected people when month-to-date organization AI usage crosses a
chosen dollar amount.

The first release adds one **monthly spending threshold** per enterprise
organization. An authorized billing user chooses a positive USD amount and one
or more email recipients. Kilo sends each recipient one informational email
when the organization's AI usage spend reaches or exceeds that amount during
the UTC calendar month. The alert does not interrupt usage or cap charges.

The product exposes only a monthly window initially. Internally, alert
configuration and evaluation use an explicit period definition and a half-open
time interval so future alert windows can be added without redefining threshold
or delivery semantics.

## Customer Problem

Enterprise usage can change quickly as an organization adds members, enables
agents, or adopts more capable models. The people accountable for cost are not
always the people generating usage, and they may not visit usage analytics
frequently. A delayed surprise can require urgent internal investigation and
can reduce trust in usage-based billing.

The highest-value intervention is timely awareness, not automatic disruption.
Finance and engineering leaders can investigate usage, communicate with their
teams, adjust policy, or contact Kilo without Kilo taking a potentially
availability-impacting action on their behalf.

## Product Principles

1. **Warn without disrupting.** The first release is informational only.
2. **Use explicit language.** A threshold or alert is not a budget, limit, or
   cap.
3. **Make one simple promise.** A configured recipient is notified at most once
   per organization and period, after the selected threshold is crossed.
4. **Match existing billing authority.** The people who can manage organization
   billing can manage spending alerts.
5. **Keep the first release narrow.** Build on current usage, organization
   settings, email, audit, and idempotency infrastructure rather than reviving a
   general cost-management platform.
6. **Preserve a path to other windows.** Period calculation is separate from
   spend calculation, crossing detection, and delivery.

## Goals

1. Let enterprise organization owners, admins, and billing managers configure,
   update, or disable a monthly spending threshold.
2. Let the configuring user choose the email addresses that receive the alert,
   including finance aliases or other addresses that are not Kilo members.
3. Notify recipients reliably and without duplicate alert emails when
   month-to-date AI usage spend reaches the configured amount.
4. Make the email immediately understandable and actionable.
5. Establish period and delivery semantics that can support future windows
   without implementing those windows now.
6. Deliver these outcomes with the smallest reasonable amount of new storage,
   aggregation, and operational machinery.

## Non-Goals

The first release does not include:

1. Hard spending caps, request blocking, model blocking, throttling, or agent
   cancellation.
2. Percentage milestones such as 50%, 80%, and 100% of a target.
3. Multiple thresholds for one organization.
4. Per-member, group, child-organization, project, repository, model, provider,
   or product thresholds.
5. Parent-plus-child consolidated spending.
6. Daily, weekly, rolling, billing-cycle, quarterly, annual, or custom windows
   in the customer UI.
7. Forecasts, anomaly detection, burn-rate alerts, recommendations, or spend
   attribution in the alert email.
8. Slack, Teams, SMS, push, webhook, or PagerDuty delivery.
9. Repeated reminders while spending remains above the threshold.
10. A new Cost Insights dashboard or restoration of the discontinued Cost
    Insights product.
11. Seat subscription charges, Kilo Pass purchases, KiloClaw compute, Exa,
    Coding Plans, top-ups, taxes, discounts, grants, transfers, expirations,
    refunds, or other balance movements in the measured amount.

## Definitions

- **Monthly spending threshold**: The positive USD amount selected by an
  authorized user for the current organization. It is an alert trigger, not an
  enforced maximum.
- **Spend alert**: An informational notification created after measured AI
  usage spend reaches or exceeds the configured threshold.
- **Measured AI usage spend**: The sum of billed organization AI usage cost
  represented by canonical organization-attributed `microdollar_usage.cost`
  records in the applicable period. It is the same cost basis used by the
  default Cost metric in organization usage analytics and is not the
  organization's total invoice or all-product Credit consumption.
- **Direct organization spend**: Measured AI usage spend attributed to the exact
  organization ID. It excludes spend attributed to parent, child, sibling, or
  unrelated organizations.
- **Period definition**: A typed and versioned description that resolves an
  evaluation time to one stable occurrence identity and one half-open interval.
- **Monthly period**: The UTC calendar month beginning at 00:00:00 UTC on its
  first day and ending at 00:00:00 UTC on the first day of the next month.
- **Period occurrence identity**: A stable identifier for one occurrence of a
  versioned period definition, such as `calendar_month_utc:v1:2026-08`.
- **Threshold crossing**: The condition in which measured AI usage spend for a
  period is greater than or equal to the configured threshold.
- **Alert recipient**: A normalized email address explicitly selected in the
  alert configuration. A recipient does not need to be an organization member.
- **Billing manager**: The canonical organization role stored as
  `billing_manager`. Product conversations may refer to this role as a billing
  admin.
- **Configuration version**: A stable revision that changes whenever the
  threshold, period definition, enabled state, or recipient set changes.
- **Delivery identity**: The organization, period occurrence identity,
  normalized recipient, and delivery channel that together identify one alert
  delivery. Threshold amount is deliberately excluded so editing a crossed
  threshold cannot repeatedly email the same recipient in one period.

## Users And Jobs

### Primary Users

- Organization owners accountable for overall enterprise usage.
- Organization admins managing day-to-day organization policy.
- Billing managers responsible for invoices and spend oversight.
- Finance or operations recipients who may not hold a Kilo account.

### Jobs To Be Done

1. When organization usage grows, notify me before the end of the month so I can
   investigate and respond.
2. Let me route the alert to the people who actually monitor cost, even if they
   are not Kilo users.
3. Make it clear whether the alert changed service availability or merely
   informed me.
4. Avoid sending the same warning repeatedly after the threshold has already
   been crossed.

## User Experience

### Configuration

1. The organization billing or payment-details experience MUST expose a
   **Monthly spending threshold** control to enterprise organization owners,
   admins, and billing managers.
2. The control MUST explain before save that the alert is informational and
   does not stop usage or cap charges.
3. The control MUST accept one positive USD amount with no more than two decimal
   places.
4. The control MUST accept at least one valid recipient email address when the
   alert is enabled.
5. The control MUST accept no more than 10 recipient email addresses.
6. The control SHOULD initially suggest the configuring user's email address,
   while allowing it to be removed or replaced.
7. The control MUST disclose that every listed address will receive the
   organization name and measured month-to-date AI usage spend. Saving MUST
   require explicit confirmation of this disclosure.
8. Links delivered to recipients MUST require normal Kilo authentication and
   authorization before displaying organization data. Possession of the email
   link MUST NOT grant organization access.
9. The control MUST show that spending is measured over a UTC calendar month.
10. The user MUST be able to update the threshold, update recipients, or disable
    the alert.
11. No more than 10 distinct recipient addresses may receive an alert for one
    organization and period, including addresses removed or replaced after
    delivery. The UI MUST explain when a newly added address cannot receive a
    current-period alert because this bound has been reached.
12. Saving a configuration MUST state that Kilo will asynchronously evaluate
    the full current month and may queue an alert if the threshold is already
    crossed. Saving MUST NOT require a synchronous usage aggregation.
13. The UI SHOULD coexist with the existing low-balance alert while clearly
   distinguishing their opposite conditions:
   - Monthly spending threshold: AI usage spend has become high.
   - Low-balance alert: available organization balance has become low.

### Alert Email

1. The email subject MUST state that the organization's monthly AI usage spend
   crossed its configured threshold.
2. The email body MUST include:
   - Organization name.
   - Configured threshold.
   - Measured month-to-date AI usage spend as of evaluation.
   - UTC monthly period.
   - A direct link to the current organization usage or alert-settings surface.
   - An explicit statement that the email is informational and usage is not
     interrupted or capped.
3. The email MUST NOT imply an exact invoice total. It MUST describe the amount
   as AI usage spend and provide a concise indication that other Kilo products
   and charges are excluded.
4. The email MUST NOT expose member-level usage or other sensitive attribution.
5. The email SHOULD match the concise structure of the supplied Anthropic
   example: what crossed, for which organization, what effect it has, and where
   to change the setting.

## Functional Rules

### Eligibility And Authorization

1. Only organizations on the Enterprise plan MUST be able to enable or modify a
   monthly spending threshold.
2. An organization owner, admin, or billing manager MUST be able to view,
   enable, modify, and disable the setting. The shared
   `canManageOrganizationBilling` role predicate is authoritative for this
   feature.
3. An ordinary organization member MUST NOT be able to view recipient addresses
   or modify the setting.
4. Authorization MUST be enforced by the server and MUST NOT rely on route or
   control visibility alone.
5. The repository's existing parent-to-direct-child billing authority
   inheritance MUST apply. A parent owner, admin, or billing manager may manage
   the direct child's alert through `canManageOrganizationBilling`; inheritance
   MUST NOT change spend scope, which remains the exact target organization.
6. Enabling an alert, increasing its recipient set, or changing its threshold or
   period MUST use the same effective subscription/trial eligibility required by
   other organization billing mutations.
7. An authorized billing user MUST be able to disable an alert or remove
   recipients even when the organization no longer has active subscription or
   trial entitlement. Loss of entitlement MUST NOT trap an active disclosure
   configuration that its billing users cannot stop.
8. Evaluation and dispatch require an existing, non-deleted Enterprise
   organization with an enabled alert. They do not independently require an
   active seat subscription because an authorized customer may still need an
   end-of-period alert for already-recorded usage.
9. When an organization changes from Enterprise to Teams, the system MUST retain
   its threshold and recipients, set the alert to disabled, stop evaluating and
   sending alerts, and hide the Enterprise-only setting. Returning to Enterprise
   MUST NOT resume delivery until an authorized user explicitly re-enables it.
   This privacy-sensitive notification is an intentional exception to automatic
   reactivation of retained Enterprise policy settings.

### Configuration

1. An organization MUST have at most one enabled monthly spending threshold.
2. The threshold MUST be greater than zero.
3. The threshold MUST be represented as integer microdollars at persistence and
   calculation boundaries.
4. The threshold MUST remain within JavaScript safe-integer range after USD to
   microdollar conversion.
5. Recipient addresses MUST be validated, trimmed, case-normalized for identity,
   deduplicated, and limited to 10.
6. The system MUST enforce a maximum of 10 distinct delivery identities per
   organization and period, regardless of recipient-list replacement.
7. The persisted configuration MUST explicitly identify its period definition;
   monthly behavior MUST NOT be inferred from a missing field or from a
   30-day duration.
8. Configuration changes MUST preserve unrelated organization settings.
9. Every material configuration change MUST create a new configuration version.
10. Enabling, changing, and disabling the alert MUST create an organization audit
   event identifying the actor and material change. Audit output MUST avoid
   unnecessary recipient PII but MUST retain enough accountable evidence to
   identify the actor, recipient count, and that external financial disclosure
   was confirmed.

### Period Semantics

1. The first release MUST support the `calendar_month` period definition in
   UTC.
2. A monthly period MUST use the half-open interval `[period start, period
   end)`.
3. Usage exactly at the period start MUST be included. Usage exactly at the
   next period start MUST be excluded from the prior period.
4. A monthly period MUST NOT be implemented as a rolling 30-day duration.
5. Evaluation code MUST receive a resolved period occurrence identity and
   interval rather than embed calendar-month arithmetic in threshold or delivery
   logic.
6. The period definition's type and version MUST be part of the occurrence
   identity so different timezone, anchor, or policy semantics cannot collide.
7. The shared crossing and delivery contract supports non-overlapping calendar,
   fixed, or billing-anchored periods. A future rolling or overlapping window
   MUST additionally define its episode and reset semantics; a continuously
   moving interval MUST NOT generate a new occurrence identity on every
   evaluation.
8. Unsupported period definitions MUST be rejected rather than silently
   interpreted as monthly.

### Spend Semantics

1. Measured AI usage spend MUST equal the sum of `microdollar_usage.cost`
   attributed to the exact organization during the resolved period.
2. The calculation MUST use billed cost, not estimated market cost.
3. The calculation MUST include usage earlier in the current period even when
   the alert was enabled later in that period.
4. Corrective usage rows MUST affect measured AI usage spend according to their
   signed canonical cost.
5. Exa, Coding Plans, KiloClaw compute, seat subscriptions, balance purchases,
   grants, transfers, expirations, and refunds MUST NOT be interpreted as
   measured AI usage spend.
6. Parent and child organizations MUST be measured independently.
7. The displayed and emailed amount MAY lag recent usage. The UI and email MUST
   not promise real-time or invoice-final accuracy.

### Crossing And Reconfiguration

1. A threshold is crossed when measured AI usage spend is greater than or equal
   to the threshold.
2. The system MUST NOT send an alert while measured AI usage spend is below the
   threshold.
3. The system MUST evaluate a newly enabled or changed threshold against the
   full current period.
4. If a new or lowered threshold is already crossed, the system MUST queue an
   alert on the next successful evaluation rather than waiting for additional
   spend.
5. Each recipient MUST receive at most one email for the same organization,
   period occurrence identity, and channel, regardless of threshold edits.
6. Disabling and re-enabling the same threshold in the same period MUST NOT
   resend an already delivered alert to the same recipient.
7. Adding a recipient after the threshold is crossed MUST make that recipient
   eligible for one alert for the current period if that recipient has not
   already received one.
8. Removing a recipient MUST prevent a not-yet-claimed delivery. A delivery
   already accepted by the email provider cannot be recalled.
9. Changing to a different threshold amount MUST NOT make an already-alerted
   recipient eligible again in the same period. A recipient not yet alerted is
   eligible if the new threshold is crossed and fewer than 10 distinct
   recipients have been admitted in that organization-period.
10. The beginning of a new period MUST make all current recipients eligible for
    the configured threshold in that period.
11. The first release MUST evaluate only the open current period. It MUST NOT
    create a delayed alert for a closed prior period because the current settings
    may no longer represent the configuration or recipients that applied then.
12. A scheduled-evaluation outage that spans a period boundary MAY therefore
    omit a prior-period alert. Such missed evaluation MUST be observable to
    operators. Historical configuration and prior-period catch-up are deferred
    to avoid a configuration-history subsystem in the MVP.

### Delivery

1. The system SHOULD evaluate enabled alerts at least hourly.
2. Under normal operation, the first delivery attempt SHOULD begin within two
   hours after Kilo's recorded usage crosses the threshold.
3. Alert creation and per-recipient delivery MUST be idempotent under concurrent
   evaluators, retries, and overlapping scheduled jobs.
4. The system MUST claim a delivery identity durably before calling the email
   provider.
5. A definitive failure before provider acceptance MUST be observable and
   retryable without permanently suppressing the delivery.
6. An ambiguous provider outcome, such as a timeout after request submission,
   MUST retain the claim and MUST NOT be retried automatically. It MUST be
   observable for operator reconciliation because automatic retry could create
   duplicate email.
7. A successful provider acceptance MUST retain the delivery claim so later
   evaluations do not send another email.
8. Email failure MUST NOT block, roll back, or otherwise affect usage recording.
9. The dispatcher MUST re-read the current organization and configuration before
   sending. The claimed configuration version, threshold, period definition,
   enabled state, plan eligibility, and recipient MUST still match. Stale work
   MUST be canceled so a later evaluation can claim eligible current work.
10. Operational logs MUST report aggregate outcomes and identifiers needed for
   diagnosis without logging recipient addresses or other unnecessary PII.
11. The system cannot guarantee exactly-once receipt after the email provider
    accepts a message. The system prefers a potentially omitted email over an
    automatic duplicate when provider acceptance is ambiguous.

## Error Handling

1. Invalid thresholds, unsupported period definitions, missing recipients, and
   invalid recipient addresses MUST be rejected before persistence.
2. Unauthorized configuration requests MUST be rejected without revealing
   recipient addresses.
3. A spend-query failure MUST skip alert creation for the affected organization,
   remain observable, and be retried by a later evaluation.
4. A failure for one organization or recipient MUST NOT prevent evaluation or
   delivery for all others.
5. If current plan or configuration eligibility cannot be confirmed before
   delivery, the system MUST fail closed and retry rather than send.
6. Delayed evaluation within an open period MUST use that period's exact resolved
   interval. Evaluation after the boundary MUST use the new open period and MUST
   NOT attribute new-period usage to or send an alert for the closed period.

## Success Measures

The initial release is successful when:

1. At least 95% of alerts with no provider failure begin their first delivery
   attempt within two hours of the recorded crossing.
2. A durable persistence uniqueness invariant prevents concurrent or repeated
   evaluation from producing duplicate provider submissions for one delivery
   identity.
3. Configuration and alert-delivery failures do not affect usage ingestion or
   customer service availability.
4. Support can determine whether an alert was configured, crossed, attempted,
   sent, skipped, or failed without inspecting recipient PII in application
   logs.
5. Qualitative feedback shows that recipients understand the email is
   informational rather than an enforced cap.

Adoption rate and the frequency of customers changing a threshold after an
alert will inform whether multiple thresholds, percentage milestones, or hard
caps merit future investment.

## High-Level Implementation Approach

### Configuration And API

Extend typed organization settings with a spending-alert configuration that
contains:

- Enabled state.
- Positive threshold in integer microdollars.
- Explicit versioned period definition, initially `calendar_month` with timezone
  `UTC`.
- Normalized recipient email addresses.
- Configuration version and effective timestamp.

Use the existing organization billing mutation authorization and audit patterns.
Keeping the first configuration in organization JSON settings avoids a new
configuration table while the product permits only one alert per organization.
A dedicated table can replace this representation later if multiple concurrent
alert policies require independent lifecycle or query patterns.

### Period Resolution

Introduce a small domain boundary that resolves a period definition and an
evaluation timestamp to:

- Stable period occurrence identity including definition type and version.
- Inclusive start.
- Exclusive end.

Spend aggregation, crossing detection, and delivery idempotency consume this
resolved representation. Adding another window should require a new resolver,
not changes to the crossing or email contract.

### Spend Evaluation

Run a bounded scheduled evaluator over enabled enterprise configurations. Query
the current UTC period's organization-attributed billed usage cost in grouped
batches where practical.

The existing `microdollar_usage_daily` rollup may reduce reads for completed UTC
days, but it is asynchronously repaired. A minimal reliable strategy can combine
completed-day rollups with canonical current-day usage and confirm spend from
canonical data near a threshold. The exact query strategy should be selected
from production query plans and enabled-organization volume during
implementation planning.

Do not add derived alert writes to usage-ingestion transactions. Scheduled
evaluation and retries must repair missed work without making usage recording
depend on alert availability.

### Idempotency And Email

Reuse the existing transactional email idempotency mechanism if it can atomically
claim a deterministic key before send, release that claim after a definitive
pre-acceptance failure, and retain it after success or ambiguous submission. The
recipient portion of the key MUST use a domain-separated HMAC with a server-held
secret over the normalized recipient and delivery context, not a plaintext
address or an unkeyed hash vulnerable to offline guessing. Derived delivery
identifiers SHOULD be retained for 13 months for support and duplicate diagnosis,
then deleted. Recipient addresses follow organization-settings retention and
MUST be removed when the organization is deleted.

Create a dedicated transactional email template and sender. Link to a current
organization usage or alert-settings page, never the discontinued Cost Insights
route.

If operational requirements outgrow the generic email log, introduce a focused
per-recipient delivery table with leased retries. Do not preemptively restore the
former Cost Insights event, episode, rollup, and outbox schema for this release.

### Observability

Expose scheduled-run counts for configurations evaluated, crossings found,
deliveries claimed, duplicate claims skipped, deliveries sent, deliveries
failed, and configurations skipped as ineligible. Capture errors by stable
organization or delivery identifiers without recipient PII.

## Prior Art

Research was performed on 2026-08-24 using public first-party documentation and
the supplied Anthropic alert email.

### Anthropic Claude

The supplied email is the closest target experience. It communicates one
customer-selected absolute monthly threshold, selected recipients, purely
informational behavior, and a link to alert settings. Anthropic's public Console
documentation separately supports monthly spend limits and workspace spend
notifications, but does not publicly specify notification deduplication or
delivery cadence.

Sources:

- Supplied `claude-threshold.pdf`.
- [Anthropic rate and spend limits](https://platform.claude.com/docs/en/api/rate-limits)
- [Anthropic workspaces](https://platform.claude.com/docs/en/manage-claude/workspaces)
- [Anthropic Console roles and permissions](https://support.claude.com/en/articles/10186004-claude-console-roles-and-permissions)

### Cursor

Cursor supports custom absolute spend alerts and separate monthly soft or hard
limits. It also sends automatic notifications at percentage milestones for
limits and can route member alerts to the member, admins, or both. Its distinction
between an informational alert and a hard limit reinforces Kilo's terminology.
Percentage ladders and per-member controls add complexity that is not necessary
for Kilo's first release.

Sources:

- [Cursor spend alerts](https://cursor.com/help/account-and-billing/spend-alerts)
- [Cursor spend limits](https://cursor.com/help/account-and-billing/spend-limits)

### GitHub Copilot

GitHub supports monthly budgets across user, organization, cost-center, and
enterprise scopes, with notifications at 75%, 90%, and 100%. Some budgets can
optionally stop paid usage while user-level budgets always enforce. The breadth
and overlapping controls demonstrate why Kilo should avoid a budget hierarchy
until the organization alert proves demand.

Sources:

- [GitHub budgets for usage-based billing](https://docs.github.com/en/copilot/concepts/billing/budgets-for-usage-based-billing)
- [GitHub budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts)

### OpenAI

OpenAI distinguishes informational monthly spend alerts from optional hard
limits at organization and project scope. This supports an explicit alert-only
first release and reserving hard-cap terminology for future enforcement.

Sources:

- [OpenAI spend limits](https://developers.openai.com/api/docs/guides/spend-limits)
- [OpenAI rate limits and spend with Terraform](https://developers.openai.com/api/docs/guides/terraform/rate-limits-and-spend)

### Google Cloud And AWS

Google Cloud and AWS provide richer FinOps systems with arbitrary percentages,
actual or forecast spend, multiple periods, role and custom recipients, pub/sub
or SNS, and automated actions. They also document evaluation lag and the limits
of enforcement. These are useful long-term references, not an appropriate MVP
scope for one enterprise coding-platform alert.

Sources:

- [Google Cloud budgets and alerts](https://cloud.google.com/billing/docs/how-to/budgets)
- [Google Cloud spend cap budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps)
- [AWS Budgets](https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html)

## Internal Prior Art And Constraints

### Existing Low-Balance Alert

Kilo already stores an organization minimum-balance threshold and arbitrary
recipient emails in organization settings, authorizes its mutation through the
billing procedure, and sends an email when balance crosses below the threshold.
The monthly spending alert should reuse its configuration and UI patterns while
remaining a separate condition and email.

### Discontinued Cost Insights

Kilo previously implemented a much broader Cost Insights system with personal
and organization thresholds, rolling 24-hour, 7-day, and 30-day windows, hourly
rollups, anomaly detection, suggestions, event state, and a notification outbox.
It was intentionally removed in August 2026; the old routes now serve only a
discontinued notice and the database tables were dropped.

The repository records undesirable coupling between spend recording, derived
rollups, and unrelated maintenance, but does not record the product reason for
discontinuation. This feature MUST treat Cost Insights as design prior art, not
as a subsystem to restore.

Useful principles to retain are integer microdollars, explicit half-open
windows, durable crossing identities, separation of alert identity from email
delivery, retryable claims, and recipient revalidation. The first release MUST
NOT restore hourly owner rollups, rolling-window fragmentation, anomaly or
suggestion machinery, polymorphic personal ownership, or Cost Insights routes.

### Existing Usage And Delivery Infrastructure

- Organization usage analytics already defines billed Cost as
  `microdollar_usage.cost` and uses UTC, half-open time ranges.
- A daily AI usage rollup and repair process exists but is eventually
  consistent and must not be treated as immediately authoritative.
- The transactional email log provides a unique email type/idempotency key and
  an existing claim-before-send/delete-on-failure pattern. This feature may
  delete a claim only after a definitive pre-acceptance failure.
- Organization settings mutations and billing procedures already support owner,
  admin, and billing-manager authority.

## Risks And Mitigations

1. **Alert latency or missed crossings due to rollup lag or a month-boundary
   outage.** Combine rollups with canonical recent usage or confirm
   near-threshold totals; monitor evaluation age and failures. The MVP does not
   send prior-period catch-up mail without historical configuration evidence.
2. **Expensive aggregation over the raw usage table.** Batch enabled
   organizations, use completed-day rollups where safe, inspect production query
   plans, and add only evidence-based indexes.
3. **Customers interpret the threshold as a cap.** Use "threshold" and "alert,"
   repeat the informational disclaimer in settings and email, and avoid
   "budget," "limit," and "cap."
4. **Emails go to unintended or former recipients.** Cap and visibly confirm the
   recipient list and disclosed data, audit the accountable actor, disable alerts
   on plan downgrade, revalidate configuration before send, and keep emailed
   links authorization-protected. A future role-based recipient mode may be
   added if customer demand outweighs the value of arbitrary aliases.
5. **Duplicate email from retries or concurrent jobs.** Use a durable unique
   delivery identity claimed before provider submission.
6. **Spend differs from invoices or balance changes.** Label the value as AI
   usage spend, document its scope, and link to usage rather than invoices.
7. **The design accidentally revives Cost Insights complexity.** Keep the MVP
   organization-only, one threshold, one exposed period, one channel, and no
   dashboard or attribution pipeline.

## Future Opportunities

Future work should be driven by adoption and customer evidence. The period
definition boundary can support additional windows such as rolling durations,
calendar weeks or quarters, fixed contract intervals, or billing-anchored
periods. The same crossing and delivery model can support multiple thresholds,
percentage milestones, role-based recipients, webhooks, parent/child scopes, or
forecast alerts.

Hard caps remain a separate product. They require request-path enforcement,
in-flight usage semantics, overage disclosure, blocked-user UX, recovery rules,
and availability safeguards and MUST NOT be inferred from this alert design.

## Acceptance Scenarios

1. An enterprise admin configures a $1,000 monthly threshold for two normalized
   email addresses. The organization has $999.99 of direct AI usage spend in the
   current UTC month. No email is sent.
2. The same organization records usage that brings measured AI usage spend to
   exactly $1,000. Each recipient receives one informational email after
   evaluation.
3. Repeated and concurrent evaluations while spend remains above $1,000 do not
   produce another successful provider submission for either recipient.
4. An admin enables a $500 threshold when current month-to-date spend is $700.
   The UI states that Kilo will evaluate the full current month, and each
   recipient is queued on the next successful evaluation.
5. An admin disables and re-enables the same $500 threshold in the same month.
   Previously alerted recipients do not receive a duplicate.
6. An admin adds a new recipient after the $500 crossing. Only the new recipient
   is eligible for a current-period email if fewer than 10 distinct recipients
   have already been admitted in the organization-period.
7. An admin changes the threshold from $500 to $650 while spend is $700.
   Recipients already alerted in the month do not receive another email. A newly
   added recipient can receive one.
8. At 00:00:00 UTC on the first day of the next month, prior-month usage no
   longer applies. The configured threshold remains enabled for the new period.
9. A child organization crosses its threshold. Parent spend is not included,
   and the parent's own alert is unaffected.
10. The organization changes to Teams. Threshold and recipients remain stored,
    the alert becomes disabled, and returning to Enterprise does not send until
    an authorized user explicitly re-enables it.
11. Email provider submission definitively fails before acceptance. Usage
    recording remains successful, the failure is observable without logging the
    address, and a later run retries.
12. Email provider submission times out after the request might have been
    accepted. The claim remains, no automatic retry occurs, and the outcome is
    surfaced for operator reconciliation.
13. Evaluation is unavailable across the August-to-September boundary. On
    recovery, the evaluator checks only September and records the missed August
    evaluation for operators; it does not send a stale August alert using current
    settings.
14. An ordinary member and a non-member cannot read recipients or mutate the
    alert. Owner, admin, and billing-manager access follows
    `canManageOrganizationBilling`.
15. Usage at exactly the UTC month start is included; usage at exactly the next
    UTC month start is excluded. Exa, KiloClaw, Coding Plan, and seat charges do
    not advance measured AI usage spend.
16. A recipient entered twice with different email casing has one delivery
    identity and can receive only one email in the period.
17. A threshold or recipient change races with claimed delivery work. The stale
    configuration version is canceled before provider submission and eligible
    current work can be claimed by a later evaluation.
18. A parent owner, admin, or billing manager can manage a direct child's alert,
    but the child's measured AI usage spend excludes the parent. A child owner
    can manage the child alert but cannot manage the parent's alert through the
    child relationship.
19. After 10 distinct recipients have been admitted for an organization-period,
    replacing them with new addresses does not create additional deliveries
    until the next period.
20. An Enterprise organization loses active entitlement while an alert remains
    enabled. Its billing users can still remove recipients or disable the alert
    but cannot expand or otherwise change it without renewed entitlement.

## Open Implementation Questions

These questions do not change the product contract and should be resolved with
query plans and implementation detail:

1. Whether the generic transactional email log is sufficient for bounded retry
   operations or a focused delivery table is warranted.
2. Whether current enabled-organization volume permits canonical grouped queries
   or requires completed-day rollups plus current-day canonical reads.
3. The threshold input maximum below the safe-integer ceiling.
4. Whether the existing payment-details modal should contain two clearly named
   alert sections or monthly spending thresholds should have a dedicated
   settings surface.

## Changelog

### 2026-08-24 -- Initial draft

- Defined an alert-only enterprise MVP with one absolute monthly threshold and
  arbitrary email recipients.
- Defined direct organization usage-cost scope, UTC calendar-month semantics,
  authorization, reconfiguration, deduplication, and delivery behavior.
- Recorded external prior art and the decision not to restore the discontinued
  Cost Insights system.
- Added a generic period-resolution boundary to preserve future window
  extensibility without exposing or implementing arbitrary windows now.
