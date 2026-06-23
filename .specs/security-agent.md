# Security Agent

## Role of This Document

This spec defines the business rules and outcome guarantees for Security Agent Auto Remediation, Security Agent Notifications, and Security Agent Audit Reports. It is the source of truth for what users should be able to rely on when Security Agent creates or manages remediation work, sends New-finding, SLA Warning, or SLA Breach Notifications, and reports recorded Security Finding activity.

This document deliberately does not specify database tables, queue design, worker names, router names, UI layout, email markup, or prompt implementation details. Those belong in plans and code.

## Status

Draft -- created 2026-06-09; notification rules added 2026-06-11; audit report rules added 2026-06-12.

## Scope

This spec covers three Security Agent capabilities:

- Auto Remediation;
- New-finding, SLA Warning, and SLA Breach Notifications;
- Security Agent Audit Reports.

It does not backfill the complete Security Agent product spec. Existing Security Agent behavior such as finding sync, Auto Analysis, Auto Dismiss, dashboard statistics, SLA calculation, and Dependabot writeback is included only where it affects Auto Remediation, notification outcomes, or audit report evidence.

## Conventions

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 RFC 2119 and RFC 8174 when, and only when, they appear in all capitals.

BDD-style scenarios use "Given", "When", and "Then" to describe user-visible behavior. They are not intended to be exhaustive unit-test cases.

## Definitions

- **Security Finding**: A vulnerability item owned by a user or organization for a repository.
- **Auto Remediation**: The Security Agent feature that automatically starts Security Remediations for eligible Security Findings.
- **Security Remediation**: A Security Agent-owned remediation task for a Security Finding.
- **Security Remediation Attempt**: A single attempt to remediate a Security Finding through Cloud Agent.
- **Manual Remediation**: A user-triggered Security Remediation started from an eligible finding.
- **Automatic Remediation**: A Security Remediation started by Auto Remediation policy without a per-finding user click.
- **Bulk Existing Remediation**: Automatic remediation of already-analyzed findings included because the user enabled the include-existing setting.
- **Sandbox Analysis**: The completed codebase-level analysis that determines whether a finding is exploitable in the repository and whether opening a PR is the recommended action.
- **Security Agent Notification**: A durable per-finding, per-recipient identity with one notification kind.
- **New-finding Notification**: A Security Agent Notification admitted when an eligible finding is first inserted into Kilo.
- **SLA Warning Notification**: A Security Agent Notification admitted when an eligible open finding enters its configured pre-deadline warning window.
- **SLA Breach Notification**: A Security Agent Notification admitted when an eligible open finding reaches or passes its persisted SLA deadline.
- **Notification Recipient**: The personal owner or a current organization owner authorized to receive a notification for a finding.
- **Email Delivery**: An attempt to render and send one Security Agent Notification through the email provider.
- **Security Finding Activity Event**: An immutable owner-scoped record of one material user, system-policy, or source-driven action or outcome that changes or explains a Security Finding.
- **Security Agent Audit Report**: An owner-scoped, period-bounded audit view of Security Finding Activity Events grouped by Security Finding.

## Auto Remediation configuration

Auto Remediation MUST be off by default.

Users MUST be able to configure:

- whether Auto Remediation is enabled;
- the minimum severity threshold for automatic remediation;
- whether existing analyzed findings should be included;
- the model used for remediation.

The severity threshold MUST use the same severity vocabulary as Auto Analysis: `critical`, `high`, `medium`, and `all`. The default threshold SHOULD be `high`.

The remediation model setting MUST be visible even when Auto Remediation is disabled. If no remediation model has been chosen yet, the system SHOULD default it from the Security Agent analysis model and then treat it as independently configurable.

### Scenario: Auto Remediation Is Explicitly Enabled

Given a user has Security Agent configured
When the user has not enabled Auto Remediation
Then Security Agent MUST NOT automatically start remediation work for findings.

Given a user enables Auto Remediation
When a future analysis produces an eligible finding at or above the configured severity threshold
Then Security Agent MUST automatically start a Security Remediation unless another safety, permission, or duplicate-suppression rule blocks it.

### Scenario: Auto Remediation Is Disabled

Given Auto Remediation was enabled
When the user disables Auto Remediation
Then Security Agent MUST stop starting new automatic remediations.

Given a remediation attempt is already running
When Auto Remediation is disabled
Then the running attempt MUST NOT be stopped solely because the setting changed.

Given Auto Remediation is disabled
When a user manually starts remediation for an eligible finding
Then the manual remediation MAY proceed.

## Eligibility

Security Agent MUST NOT start remediation unless the finding has a completed Sandbox Analysis.

A finding is eligible for automatic remediation only when all safety conditions are true:

- the finding is still open;
- the finding belongs to the current user or organization context;
- the repository is currently in Security Agent scope;
- the latest relevant Sandbox Analysis is fresh enough for the current finding data;
- the Sandbox Analysis says the finding is exploitable;
- the Sandbox Analysis recommends opening a PR;
- the analysis provides a concrete enough remediation path.

Findings whose analysis recommends `manual_review` MUST NOT be remediated automatically. Manual Remediation MAY proceed after the user reviews the finding when the analysis or source metadata still provides a concrete remediation path.

Findings whose analysis recommends `monitor` MUST NOT be remediated automatically or manually through the one-click remediation flow.

Findings whose exploitability is unknown MUST NOT be remediated automatically. Manual Remediation MAY proceed after the user reviews the finding when the analysis recommends opening a PR or manual review and the analysis or source metadata provides a concrete remediation path.

Triage-only analysis MUST NOT be enough to start remediation.

### Scenario: Eligible Finding

Given a finding is open
And Sandbox Analysis says the finding is exploitable
And Sandbox Analysis recommends opening a PR
And the analysis describes an actionable remediation
When the finding is inside Security Agent scope
Then Security Agent MAY offer remediation for that finding.

### Scenario: Ineligible Finding

Given a finding is open
And the latest analysis says manual review is required
When the user views the finding
Then Security Agent MUST NOT automatically start remediation for that finding.
And Security Agent MAY offer manual remediation if a concrete remediation path is available.

Given a finding is open
And only triage analysis has completed
When the user views the finding
Then Security Agent MUST require Sandbox Analysis before remediation is available.

### Scenario: Stale Analysis

Given a finding was analyzed
And the finding's source data changed after that analysis
When a user or policy attempts remediation
Then Security Agent MUST require fresh analysis before starting remediation.

## Automatic Remediation

Automatic Remediation MUST respect the enabled setting and severity threshold.

Automatic Remediation MUST act on every eligible finding that meets current policy unless duplicate suppression or another explicit exclusion applies.

Automatic Remediation MUST only act on findings that become eligible through completed analysis after Auto Remediation was enabled, unless the include-existing setting applies.

Automatic Remediation MUST NOT create duplicate remediation work for the same finding and same analysis result.

### Scenario: Post-Analysis Automatic Remediation

Given Auto Remediation is enabled
And the finding severity meets the configured threshold
When Sandbox Analysis completes and says the finding is exploitable and should be fixed with a PR
Then Security Agent MUST start a Security Remediation automatically unless duplicate suppression or another explicit exclusion applies.

Given Auto Remediation is enabled
And the finding severity is below the configured threshold
When Sandbox Analysis completes and recommends opening a PR
Then Security Agent MUST NOT automatically start remediation.
And the user MAY still manually start remediation if the safety gates pass.

### Scenario: Auto Dismiss Takes Precedence

Given analysis determines a finding should be dismissed
When Auto Dismiss dismisses the finding
Then Auto Remediation MUST NOT start remediation for that finding.

## Include Existing Findings

Auto Remediation MUST support an include-existing setting that mirrors Auto Analysis behavior at the product level.

When include-existing is enabled, Security Agent MUST apply Auto Remediation to all already-analyzed eligible findings under the current settings, including findings analyzed before Auto Remediation was enabled.

Include-existing MUST be idempotent. Re-saving settings or re-enabling Auto Remediation MUST NOT create duplicate remediation attempts for a finding and analysis result that has already produced active or terminal remediation work.

### Scenario: Include Existing Is Enabled

Given Auto Remediation is enabled
And include-existing is turned on
When existing analyzed findings satisfy the Auto Remediation eligibility rules
Then Security Agent MUST start Security Remediations for all of those findings unless duplicate suppression or another explicit exclusion applies.

### Scenario: Threshold Changes While Include Existing Is On

Given Auto Remediation is enabled
And include-existing is enabled
When the user lowers the severity threshold
Then existing analyzed findings that newly meet the threshold MUST become eligible for Auto Remediation under include-existing.

Given the user changes only the remediation model
When include-existing is enabled
Then Security Agent MUST NOT start new remediation work solely because the model changed.

## Manual Remediation

Users MUST be able to manually start remediation for eligible findings.

Manual Remediation MUST bypass automatic policy gates and MAY use the reviewed-finding override described above:

- Auto Remediation does not need to be enabled;
- the finding does not need to meet the automatic severity threshold;
- the analysis does not need to have completed after Auto Remediation was enabled.
- the analysis MAY have unknown exploitability or recommend manual review when the user chooses to proceed and a concrete remediation path exists.

Manual Remediation MUST still honor ownership, scope, freshness, concrete-fix, active-attempt, and duplicate-PR safety gates.

### Scenario: Manual Start Below Threshold

Given a finding is eligible for remediation
And its severity is below the Auto Remediation threshold
When the user views the finding
Then Security Agent SHOULD offer "Start remediation".

### Scenario: Manual Start While Auto Remediation Is Disabled

Given Auto Remediation is disabled
And a finding is otherwise eligible for remediation
When the user clicks "Start remediation"
Then Security Agent SHOULD start a manual Security Remediation.

### Scenario: Manual Start Is Unavailable

Given a finding is not eligible for remediation
When the user views the finding
Then Security Agent SHOULD explain why remediation is unavailable.

### Scenario: Manual Start After Review

Given a finding is open
And Sandbox Analysis completed with unknown exploitability or a manual-review recommendation
And the finding has a concrete dependency patch path or suggested fix
When the user reviews the finding and clicks "Start remediation"
Then Security Agent MAY start a manual Security Remediation.

Given a finding has unknown exploitability or a manual-review recommendation
And the finding has no concrete dependency patch path or suggested fix
When the user views the finding
Then Security Agent SHOULD explain that remediation needs a concrete fix path.

## Remediation Execution

Cloud Agent is responsible for making the code changes and opening the PR.

Security Agent MUST record the remediation outcome and expose it to the user.

Cloud Agent SHOULD create the smallest safe change that addresses the finding. It MAY update manifests, lockfiles, Dockerfiles, CI configuration, or build/deploy files when those changes are directly required to remediate the vulnerable dependency.

Cloud Agent SHOULD run the narrowest useful validation it can identify. Passing validation MUST NOT be required before a PR can be opened, but incomplete validation or meaningful risk SHOULD cause the PR to be opened as draft.

Cloud Agent MUST NOT open a no-change PR. If no changes are needed, Security Agent MUST show a no-changes-needed outcome rather than a PR.

### Scenario: PR Opened

Given Cloud Agent successfully remediates a finding
When Cloud Agent opens a pull request
Then Security Agent MUST show the PR link on the finding.
And the finding MUST remain open until the source of truth reports it fixed or the user dismisses it.

### Scenario: Draft PR

Given Cloud Agent creates a concrete fix
And validation is incomplete or risk is nontrivial
When Cloud Agent opens the PR as draft
Then Security Agent MUST still treat the remediation as PR opened.
And Security Agent SHOULD label the PR as draft.

### Scenario: No Changes Needed

Given Cloud Agent determines no code changes are required
When no PR is opened
Then Security Agent MUST show a no-changes-needed outcome.
And Security Agent MUST NOT mark the finding fixed.
And automatic policy MUST NOT retry the same analysis result unless the finding is re-analyzed.

### Scenario: Cloud Agent Cannot Remediate

Given Cloud Agent cannot access the repository, cannot determine a safe change, or cannot open a PR
When the remediation attempt ends
Then Security Agent MUST show a failed or blocked outcome with a user-understandable reason.

## PR Outcome Integrity

Security Agent MUST NOT mark a remediation as PR opened unless it has a trustworthy PR outcome.

The PR outcome MUST belong to the expected repository and remediation branch. If the structured result is malformed but Security Agent can unambiguously recover the PR from the expected branch, Security Agent MAY record the PR and show a warning internally. If no trustworthy PR can be identified, the attempt MUST be treated as failed.

### Scenario: Malformed Result With Recoverable PR

Given Cloud Agent opened a PR from the expected remediation branch
And the final result is malformed
When Security Agent can uniquely identify the PR
Then Security Agent MAY show the remediation as PR opened.

### Scenario: Malformed Result Without Recoverable PR

Given Cloud Agent's final result is missing or malformed
And Security Agent cannot uniquely identify the expected PR
When the attempt completes
Then Security Agent MUST show the attempt as failed rather than inventing a PR link.

## Duplicate Suppression and Retry

Security Agent MUST NOT run more than one active remediation attempt for the same finding.

Security Agent MUST NOT create a second remediation PR for a finding when it already knows a PR has been opened for that finding.

If another open remediation PR likely covers the same repository, package, and manifest, Security Agent SHOULD block later same-package remediation rather than opening a competing PR.

Users MAY retry failed, blocked, no-changes-needed, or cancelled attempts if the finding still satisfies safety gates and no PR is already open.

Automatic Remediation MUST NOT retry terminal semantic outcomes for the same analysis result. Manual retry MAY.

### Scenario: Active Attempt Exists

Given a finding already has a queued or running remediation attempt
When the user views the finding
Then Security Agent MUST NOT offer another "Start remediation" action.
And Security Agent SHOULD show the current remediation state.

### Scenario: PR Already Opened

Given Security Agent knows a remediation PR was opened for a finding
When the user views that finding
Then Security Agent MUST show the PR link.
And Security Agent MUST NOT offer retry in v1.

### Scenario: Retry After Failure

Given a remediation attempt failed
And the finding still satisfies safety gates
And no remediation PR is already open
When the user retries remediation
Then Security Agent SHOULD create a new attempt.

## Cancellation

Users SHOULD be able to cancel queued or running remediation attempts.

Cancelling a queued attempt SHOULD stop it locally.

Cancelling a running attempt SHOULD ask Cloud Agent to interrupt the running work. A cancellation request does not guarantee Cloud Agent stops before it creates a PR.

### Scenario: Cancel Queued Attempt

Given a remediation attempt is queued
When the user cancels it
Then Security Agent SHOULD mark the attempt as cancelled.
And Cloud Agent SHOULD NOT be launched for that attempt.

### Scenario: Cancel Running Attempt

Given a remediation attempt is running
When the user cancels it
Then Security Agent SHOULD show that cancellation has been requested.

Given Cloud Agent confirms interruption after cancellation was requested
When the attempt finishes
Then Security Agent MUST mark the attempt as cancelled.

Given Cloud Agent opens a PR after cancellation was requested
When Security Agent receives the PR outcome
Then Security Agent MUST show the PR as opened.

## Permissions

Personal remediation actions MUST be available only to the user who owns the finding.

Organization Auto Remediation settings and include-existing policy changes MUST be restricted to users allowed to change Security Agent settings for that organization.

Organization manual remediation actions MAY be available to organization members. Manual remediation MUST NOT require that the member is also a GitHub repository collaborator, because Cloud Agent uses the organization's configured integration path.

### Scenario: Organization Member Starts Remediation

Given a user is an organization member
And the user can access the organization's Security Agent findings
When the user starts remediation for an eligible finding
Then Security Agent MAY start a manual Security Remediation.

### Scenario: Settings Permission

Given a user is not allowed to change organization Security Agent settings
When the user tries to enable Auto Remediation or include existing findings
Then Security Agent MUST reject the settings change.

## Finding Status and User Interface Outcomes

Security Findings MUST remain open while remediation is queued, running, blocked, failed, no-changes-needed, cancelled, or PR-opened. A remediation PR is not the same as a fixed finding.

Finding lists SHOULD show remediation state for open findings, including PR links when available.

Finding detail SHOULD show remediation history, requester information for manual actions, validation evidence, risk notes, and failure/block reasons.

The UI SHOULD derive action availability from server-provided capability state and reason codes rather than reimplementing eligibility rules client-side.

### Scenario: PR Opened Finding Remains Open

Given a remediation PR has been opened
When the user views open findings
Then the finding MUST still be counted as open.
And the finding SHOULD show a PR-opened remediation badge or link.

### Scenario: Unavailable Remediation Reason

Given a finding cannot currently be remediated
When the user views the finding
Then Security Agent SHOULD show a concise reason such as analysis required, sandbox analysis required, not exploitable, manual review required, stale analysis, remediation active, or PR already opened.

## Audit and Traceability

Security Agent MUST preserve enough history for users and operators to understand why a remediation happened and what outcome it produced.

Manual start, retry, and cancel actions MUST record the requesting user.

Bulk Existing Remediation MUST record the user who enabled or saved the include-existing setting that caused the work to be admitted.

Automatic Remediation started after analysis SHOULD be attributed to system policy, while retaining analysis metadata separately.

Remediation PRs SHOULD include a backlink to the Kilo Security Finding when a stable finding URL exists.

### Scenario: Manual Remediation Audit

Given a user manually starts remediation
When the remediation appears in history
Then Security Agent SHOULD show who requested it and when.

### Scenario: Automatic Remediation Audit

Given Auto Remediation starts a remediation after analysis
When the remediation appears in history
Then Security Agent SHOULD identify it as policy-driven automatic remediation.

## Security Agent Audit Reports

### Report purpose and evidence basis

Security Agent Audit Reports MUST report Security Finding activity recorded by Kilo. They MUST NOT claim that legacy history is complete, prove repository scan coverage, reconstruct activity Kilo did not record, or calculate authoritative historical SLA compliance.

The report evidence basis MUST be Security Finding Activity Events. A Security Finding Activity Event MUST belong to exactly one Security Agent owner and one Security Finding, including after that finding is deleted.

Security Agent MAY include supplemental legacy audit records when they can be mapped to a Security Finding without ambiguity. Legacy supplemental activity MUST be labeled as potentially incomplete. Ambiguous legacy records MUST NOT be guessed into a Security Finding group.

Every report MUST display the reliable event-coverage start. Baseline events for existing Security Findings, if produced, MUST use actual capture time and MUST NOT be backdated or presented as original creation events.

### Reportable activity

Security Agent Audit Reports MUST include material Security Finding activity when recorded during the selected period:

- finding imported into Kilo;
- severity changed;
- status changed, including reopened and fixed;
- finding manually dismissed, automatically dismissed, or superseded;
- terminal analysis completed or failed when the outcome explains a disposition or remediation decision;
- remediation requested;
- remediation ended with PR opened, failed, blocked, cancelled, or no changes needed;
- finding deleted.

Security Agent Audit Reports MUST NOT include reads, page views, unchanged sync observations, queue claims, heartbeats, retries with no new finding-level outcome, analysis admission or start, stale cleanup, recipient-level notification transitions, repository scan-coverage evidence, configuration timelines, or report-generation events inside the report itself.

### Periods and ordering

Reports MUST use UTC calendar-day boundaries. The default period SHOULD end on the current UTC calendar day and include the preceding 89 calendar days.

Report ranges MUST be valid, non-future, non-reversed, and no longer than 90 inclusive calendar days. Period inclusion MUST use when Kilo recorded or applied the event. External source timestamps MAY be shown as supporting evidence but MUST NOT determine report inclusion.

A report MUST include a Security Finding when at least one reportable Security Finding Activity Event falls inside the selected period. The report MUST group events by Security Finding. Events inside each Security Finding group MUST be chronological. Security Finding groups MUST be deterministically ordered by first in-period event, repository, title, and Security Finding ID.

The interactive report MUST let viewers filter Security Finding groups by severity, recorded state, and repository. Filters MUST retain the complete in-period timeline for every matching Security Finding group.

Repository filter options MUST come from repository names recorded in report evidence, not current Security Agent repository selection or current repository accessibility. Repository matching MUST use the exact recorded full name. Renamed or transferred repositories MAY appear as separate options when report evidence contains both names. Security Findings without recorded repository identity MUST remain visible when all repositories are selected.

### Authorization and availability

Personal Security Agent Audit Reports MUST be available only to the owning user.

Organization Security Agent Audit Reports MUST be available to organization owners, billing managers, and Kilo platform admins. Ordinary organization members and non-members MUST NOT access organization reports solely because they can access other organization surfaces.

Report access MUST NOT have a separate plan, active-subscription, enabled Security Agent, or active GitHub integration entitlement. Authorized viewers MUST retain read-only historical access after Security Agent or the GitHub integration is disabled.

Every platform-admin report generation MUST be audited after successful report assembly. Ordinary customer access MAY rely on existing operational request logs in v1.

### Report content

Successful reports MUST include every matching reportable Security Finding Activity Event recorded through the displayed cutoff. Timeout, over-budget, or query failure MUST return no report content and MUST NOT return a partial report.

Each Security Finding group SHOULD show stable Security Finding and source identity, repository, title, severity, status, safe advisory metadata, first detected time, canonical Security Finding ID when recorded, and deletion status when applicable.

Human actions MUST show an event-time display name and stable typed actor reference. Automated actions MUST show explicit system attribution. Actor email and notification recipient identity MUST NOT be report evidence.

Internal Kilo admin actors MUST be masked for non-admin viewers. Deleting an actor's Kilo account MUST anonymize dedicated identity fields in organization-owned Security Finding Activity Events while preserving stable non-PII attribution and event evidence.

Security Agent Audit Reports MAY show recorded SLA evidence for a Security Finding when trustworthy event or snapshot data exists:

- persisted SLA deadline;
- recorded terminal timestamp;
- whether terminal timestamp was before or at/after recorded deadline;
- whether an open finding was before or at/after recorded deadline at report cutoff;
- `unknown` when legacy or missing history prevents trustworthy classification.

Security Agent Audit Reports MUST NOT publish aggregate SLA compliance percentages. They MUST NOT classify ignored or superseded findings as compliant controls. They MUST NOT change SLA enable, disable, severity, warning, breach, reopen, or deadline behavior.

### Privacy and redaction

Security Finding Activity Event snapshots and metadata MUST contain only structured, sanitized evidence needed for the report. They MUST NOT contain actor identity, notification recipient identity, prompts, raw analysis markdown, transcripts, assistant messages, full execution logs, provider responses, raw source payloads, credentials, tokens, auth headers, cookies, webhook secrets, or unredacted raw errors.

External links in reports MUST be validated and rendered safely. Source-controlled text MUST be rendered as escaped text.

### Scenario: UTC report period

Given an authorized owner requests a same-day UTC report
When Security Agent assembles the report
Then events recorded at or after `00:00:00.000Z` on that day and before `00:00:00.000Z` on the next day MUST be eligible.
And events outside that range MUST NOT be included.

### Scenario: Invalid report period

Given an authorized owner requests a future, reversed, or longer-than-90-day range
When Security Agent validates the request
Then Security Agent MUST reject the request before scanning report events.

### Scenario: Complete query failure

Given a report scan has loaded some matching events
When a later page fails, times out, or exceeds the tested budget
Then Security Agent MUST discard accumulated data.
And Security Agent MUST return a complete-query failure state rather than a partial report.

### Scenario: Deleted finding remains reportable

Given a Security Finding has been deleted
And a deletion Security Finding Activity Event with a final compact snapshot was recorded
When an authorized owner requests a period containing that event
Then the report MUST show the deleted Security Finding from immutable event evidence.
And the report MUST NOT rely on joining through the mutable Security Finding row.

### Scenario: Organization report permissions

Given an organization has Security Finding Activity Events
When an organization owner, billing manager, or Kilo platform admin requests its report
Then Security Agent MUST allow the report.

Given an ordinary organization member or non-member requests the report
When Security Agent checks authorization
Then Security Agent MUST reject access before loading counts or report data.

### Scenario: Legacy coverage wording

Given a report period overlaps activity before reliable event coverage began
When Security Agent renders the report
Then the report MUST state that it contains activity recorded by Kilo.
And it MUST label supplemental legacy activity as potentially incomplete.

### Scenario: Repository report filter

Given a report contains Security Finding groups with recorded repository identity
When an authorized viewer selects one repository
Then the report MUST show only groups whose recorded repository full name matches that selection.
And every event in each matching group's in-period timeline MUST remain visible.
And current Security Agent repository selection or accessibility MUST NOT remove recorded repository options from the report.

## Security Agent Notifications

### Delivery and policy ownership

Security Agent notifications MUST use email as the only delivery channel in v1. The system MUST NOT expose a channel selector until another complete delivery destination is supported.

Notification evaluation and Email Delivery are asynchronous. V1 does not guarantee real-time email delivery. A delivery failure MUST NOT roll back or cause replay of a successful source synchronization.

Notification policy MUST follow the existing Security Agent owner boundary:

- a personal Security Agent policy belongs to its owning user;
- an organization Security Agent policy belongs to the organization;
- organization notification settings MUST use the same settings permissions as the rest of the organization Security Agent configuration.

Personal notifications MUST be addressed only to the user who owns the finding. Organization notifications MUST be addressed to every current organization member with role `owner`. Members with role `member` or `billing_manager` MUST NOT receive organization Security Agent notifications solely because of those roles.

Per-member organization overrides are outside v1.

### Notification configuration

Users MUST be able to configure:

- whether New-finding Notifications are enabled;
- the minimum severity for New-finding Notifications;
- whether SLA tracking is enabled;
- whether SLA warning and breach notifications are enabled;
- the minimum severity for SLA notifications;
- the warning lead time in whole days.

The defaults MUST be:

| Setting | Default |
|---|---|
| New-finding Notifications enabled | `false` |
| New-finding minimum severity | `high` |
| SLA tracking enabled | `true` |
| SLA notifications enabled | `false` |
| SLA minimum severity | `high` |
| SLA warning lead time | `3` days |

Warning lead time MUST be a whole number from 1 through 365 days.

Notification severity settings MUST use `critical`, `high`, `medium`, and `low` as minimum thresholds:

| Minimum | Eligible severities |
|---|---|
| `critical` | critical |
| `high` | critical, high |
| `medium` | critical, high, medium |
| `low` | critical, high, medium, low |

Unknown severity or malformed notification settings MUST NOT be interpreted as a less restrictive policy. Missing notification fields in a legacy configuration MUST use the defaults above. If a stored notification value is present but invalid, Security Agent MUST withhold notification work for that owner until valid settings are saved. This quarantine MUST NOT block finding sync or notification processing for other owners. It MUST NOT discard unsent notification history solely because the stored setting is malformed. If malformed policy is detected after notification work has started, Security Agent MUST retain that unsent event for later evaluation without cancelling it or counting a delivery failure.

New-finding Notifications MUST be off by default. Enabling them affects only future inserted findings; enabling them later MUST NOT replay historical insertions.

### New-finding eligibility

A finding is eligible for a New-finding Notification only when all of these conditions are true:

- the finding is first inserted into Kilo rather than updated;
- its effective status is open;
- Security Agent is enabled for its owner;
- New-finding Notifications are enabled for its owner;
- its severity meets the configured new-finding minimum;
- it remains canonical after duplicate consolidation.

An existing source alert discovered during an owner's first Security Agent sync counts as new because that sync first inserts it into Kilo.

Security Agent MUST NOT create a New-finding Notification because an existing finding was unchanged, had its severity updated, was reopened, or later became eligible after a threshold was lowered. Fixed, ignored, and superseded findings MUST NOT produce New-finding Notifications.

### Scenario: First import counts as new

Given an open source alert has not previously been stored in Kilo for an owner
And New-finding Notifications are enabled for that owner
And its severity meets that owner's new-finding threshold
When Security Agent first imports the alert
Then Security Agent MUST treat it as an eligible new finding.

### Scenario: Existing finding is not new again

Given a finding was previously stored for an owner
When a later sync updates it or reopens it
Then Security Agent MUST NOT create another New-finding Notification for that finding and recipient.

### SLA warning eligibility

An open finding is eligible for an SLA Warning Notification only when all of these conditions are true:

- Security Agent is enabled for its owner;
- SLA tracking is enabled for its owner;
- SLA notifications are enabled;
- `sla_due_at` is present;
- severity meets configured SLA minimum;
- current time is at or after `sla_due_at` minus configured warning days;
- current time is before `sla_due_at`.

Notification policy MUST use persisted `sla_due_at`. It MUST NOT recalculate deadline from source timestamps during notification evaluation.

### SLA breach eligibility

An open finding is eligible for an SLA Breach Notification only when all of these conditions are true:

- Security Agent is enabled for its owner;
- SLA tracking is enabled for its owner;
- SLA notifications are enabled;
- `sla_due_at` is present;
- severity meets configured SLA minimum;
- current time is at or after `sla_due_at`.

A finding is breached at exact deadline equality.

### Scenario: Warning and breach boundaries

Given an eligible open finding has a persisted SLA deadline
When current time equals its warning boundary and remains before deadline
Then Security Agent MUST consider warning eligible.

Given current time equals or passes persisted SLA deadline
Then Security Agent MUST consider breach eligible.
And Security Agent MUST NOT create a stale warning if no warning was created before deadline.

### Event independence and repetition

Security Agent MUST admit at most one New-finding Notification, one SLA Warning Notification, and one SLA Breach Notification per finding and recipient.

A warning MUST NOT suppress later breach. A New-finding Notification MUST NOT suppress a warning or breach. A newly inserted finding that is already in warning window or already breached MAY produce both its New-finding Notification and current eligible SLA event. A breached finding MUST NOT also receive stale warning.

Repeated syncs and repeated scheduled evaluations MUST NOT intentionally create duplicate notification events. Reopening a finding or moving its SLA deadline MUST NOT reset sent notification history.

Email delivery is at least once. A provider acceptance followed by failure to record success MAY result in a duplicate email. This limitation does not permit the system to intentionally create duplicate semantic events.

### Scenario: Overlapping events

Given an eligible finding is first inserted into Kilo
And it is already past persisted SLA deadline
When notification eligibility is evaluated
Then Security Agent MAY send one New-finding Notification and one SLA Breach Notification.
And Security Agent MUST NOT send an SLA Warning Notification for that evaluation.

### Changes before delivery

Security Agent MUST recheck current finding state, enabled settings, severity policy, SLA boundary, and recipient authorization before sending an email.

Unsent notification work MUST be cancelled when it is no longer eligible, including when:

- finding is fixed, ignored, superseded, or deleted;
- Security Agent is disabled;
- relevant severity threshold is raised above finding severity;
- New-finding Notifications are disabled for new-finding work;
- SLA tracking is disabled for warning or breach work;
- SLA notifications are disabled for warning or breach work;
- recipient no longer owns personal finding or is no longer an organization owner.

A cancelled New-finding Notification MUST remain terminal. Lowering a threshold or re-enabling Security Agent later MUST NOT replay that historical insertion.

An unsent cancelled SLA warning or breach MAY become pending again when current policy, finding state, and recipient authorization make same event eligible. This applies when SLA notifications are re-enabled, SLA threshold is lowered, or organization owner authorization is restored. Sent and permanently failed notifications MUST NOT reactivate.

### Scenario: Policy changes before send

Given an SLA notification is waiting to be sent
When owner disables SLA notifications or raises threshold above finding severity
Then Security Agent MUST cancel unsent notification.

Given same warning or breach has not been sent
When owner later restores policy while finding remains in corresponding SLA window
Then Security Agent MAY reactivate same notification event.

Given a New-finding Notification was cancelled
When owner later lowers new-finding threshold, enables New-finding Notifications, or re-enables Security Agent
Then Security Agent MUST NOT reactivate historical New-finding Notification.

### Organization membership changes

Organization recipients MUST be based on current owner membership.

A person promoted to organization owner MUST NOT receive historical New-finding Notifications. They MAY receive current SLA warning or breach on next evaluation. A removed owner MUST NOT receive an unsent organization notification after removal.

### Repository selection

Removing a repository from Security Agent selection stops future syncs for that repository but does not, by itself, close persisted findings. Open persisted findings remain SLA-eligible until fixed, ignored, superseded, or deleted.

### Notification content

Notification emails SHOULD contain only information needed to act:

- severity;
- repository name;
- finding title;
- finding description;
- CVE, GHSA, and CVSS metadata when available;
- SLA deadline for warning and breach;
- one primary link to owner-appropriate Security Agent findings list;
- one link to manage relevant Security Agent notification settings.

Repository, CVE, and GHSA metadata MAY link to the canonical public GitHub repository, CVE record, and GitHub Security Advisory pages when those identifiers validate. These links are supporting metadata, not app navigation CTAs.

Notification email MUST NOT expose raw advisory payloads, internal credentials, or another owner's finding data.

## V1 Exclusions

The following are intentionally outside the guaranteed v1 behavior:

- PR lifecycle sync after the PR is opened.
- Automatically marking findings fixed because a remediation PR exists.
- Retrying `pr_opened` attempts after the user manually closes a PR.
- Combining multiple Security Findings into one planned remediation.
- GitLab security finding remediation.
- Settings-time or launch-time repository write-permission preflight by Security Agent.
- Notification channels other than email.
- Per-member organization notification overrides.
- Historical SLA compliance metrics.
- Repository scan-coverage appendices.
- Configuration policy appendices.
- Exhaustive notification delivery history in Audit Reports.
- Report ranges longer than 90 days.
- Server-side stored report artifacts or server-generated PDFs.
- Server-side report result caching.
- Backfilling complete specifications for Security Agent features unrelated to Auto Remediation, Security Agent Notifications, or Security Agent Audit Reports.
