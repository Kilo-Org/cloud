# Security Agent

## Role of This Document

This spec defines the business rules and outcome guarantees for Security Agent Auto Remediation. It is the source of truth for what users should be able to rely on when Security Agent creates or manages remediation work for security findings.

This document deliberately does not specify database tables, queue design, worker names, router names, UI layout, or prompt implementation details. Those belong in plans and code.

## Status

Draft -- created 2026-06-09.

## Scope

This spec covers the Auto Remediation capability of Security Agent.

It does not backfill the complete Security Agent product spec. Existing Security Agent behavior such as finding sync, Auto Analysis, Auto Dismiss, dashboard statistics, SLA calculation, and Dependabot writeback is included only where it affects Auto Remediation outcomes.

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

## Configuration

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

## V1 Exclusions

The following are intentionally outside the guaranteed v1 behavior:

- PR lifecycle sync after the PR is opened.
- Automatically marking findings fixed because a remediation PR exists.
- Retrying `pr_opened` attempts after the user manually closes a PR.
- Combining multiple Security Findings into one planned remediation.
- GitLab security finding remediation.
- Settings-time or launch-time repository write-permission preflight by Security Agent.
- Backfilling complete specifications for Security Agent features unrelated to Auto Remediation.
