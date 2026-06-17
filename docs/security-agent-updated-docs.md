# Security Agent

Security Agent helps you manage dependency vulnerability alerts from GitHub Dependabot. It syncs alerts from selected repositories, creates Security Findings in Kilo, triages each finding with AI, runs sandbox analysis when project-specific evidence is needed, and helps you dismiss, remediate, notify, and audit those findings.

Use Security Agent when you need to know which Dependabot alerts are reachable in your codebase, which findings need action first, and which findings can be safely dismissed or fixed with a pull request.

## Prerequisites

Before enabling Security Agent, make sure you have:

1. The [KiloConnect GitHub App](https://kilo.ai/docs/automate/integrations#connecting-github) installed with the `vulnerability_alerts` permission.
2. [Dependabot alerts](https://docs.github.com/en/code-security/dependabot/dependabot-alerts) enabled on target repositories.
3. Kilo Code credits for AI model usage.

Security Agent currently works with GitHub Dependabot alerts. If the GitHub App loses required permissions, Security Agent prompts you to re-authorize the app before syncing or analyzing findings.

## Get Started

1. Open Security Agent from your personal dashboard or from an organization dashboard.
2. Connect GitHub from the Integrations page if you have not connected it yet.
3. Choose repository scope: all repositories available to the KiloConnect App, or selected repositories.
4. Turn on Security Agent.
5. Review General, Automation, Notifications, and SLA settings.

Turning on Security Agent queues an initial sync for the selected repository scope. After that, Security Agent syncs Dependabot alerts every 6 hours. You can also trigger a manual sync from the dashboard or Findings page.

## Organization Permissions

Organization members can view Security Agent dashboard, findings, and analysis evidence. Members can also trigger manual syncs, start or retry analysis, start or retry remediation, and request remediation cancellation.

Organization owners and billing managers can change Security Agent settings, turn the agent on or off, dismiss findings, clear orphaned findings, and access organization audit reports. Kilo platform admins can also access organization audit reports for audited support and operations.

Organization notification recipients are narrower than settings access. Organization Security Agent emails go only to current organization owners.

## How Security Agent Works

Security Agent processes dependency vulnerability alerts through several stages:

1. **Sync** pulls Dependabot alerts from repositories in scope and stores them as Security Findings in Kilo.
2. **Triage** runs a quick AI assessment of advisory metadata such as package, severity, vulnerable range, patched version, and advisory text.
3. **Sandbox analysis** runs a deeper codebase analysis in Cloud Agent when Security Agent needs project-specific evidence.
4. **Auto-dismiss** can dismiss findings that analysis determines are not exploitable, then sync the dismissal back to GitHub.
5. **Remediation** can start Cloud Agent work to create a pull request for eligible exploitable findings.
6. **Notifications** can email the right people about new findings and SLA events.
7. **Audit reports** show recorded Security Finding activity for a selected UTC period.

Security Agent treats Dependabot alerts as source data and Kilo Security Findings as the working record. A finding can stay open even after a remediation PR exists. The finding closes only when GitHub reports it fixed or someone dismisses it.

## Choose Analysis Mode

Analysis mode controls how much analysis Security Agent performs after a finding is synced.

| Mode | What happens |
|---|---|
| Auto | Run triage first, then sandbox analysis only when triage recommends it. |
| Shallow | Run triage only. Sandbox analysis does not run automatically. |
| Deep | Run sandbox analysis for every finding. |

Auto is the default. It balances evidence quality with credit usage by reserving sandbox analysis for findings that need project-specific code review.

## Use Dashboard

Dashboard gives a repository-filterable view of current security posture. Use repository filter to scope metrics to one repository or all repositories.

When SLA tracking is enabled, dashboard shows:

| Metric | Meaning |
|---|---|
| SLA compliance | Percentage of open findings with deadlines still inside SLA. |
| Deadline passed | Open findings whose persisted SLA deadline has passed. |
| Due this week | Open findings approaching deadline, including confirmed exploitable findings. |
| No deadline | Open findings without assigned SLA deadline evidence. |

When SLA tracking is disabled, dashboard focuses on action posture:

| Metric | Meaning |
|---|---|
| Open findings | Current open finding count by severity. |
| Confirmed exploitable | Findings where sandbox analysis confirmed project risk. |
| Needs your review | Findings needing human decision. |
| Analysis not complete | Findings whose project-specific risk is still unknown. |

Dashboard also highlights one finding to act on first. It prioritizes overdue findings, findings needing analysis, exploitable findings, and findings needing human review. Dashboard links take you to the Findings page with matching filters.

## Browse Findings

Findings page is where you work through vulnerability backlog.

Use filters and sorting to focus the list:

| Control | Options |
|---|---|
| Repository | All repositories or one repository in Security Agent scope. |
| Severity | Critical, High, Medium, Low. |
| Outcome | Not analyzed, Analysis failed, Exploitable, Not exploitable, Safe to dismiss, Needs review, Triage complete, Fixed, Dismissed. |
| Sort | Severity descending, severity ascending, or SLA due date when SLA tracking is enabled. |

Each row shows severity, title, package, analysis outcome, remediation status, and next action. Common actions include Analyze, Retry, Review, Fix, View PR, Retry fix, Cancel, and View details.

Findings page shows current analysis capacity and last sync time. It paginates at 20 findings per page and refreshes automatically while analysis or remediation work is active.

## Inspect Finding

Click a finding to open its detail dialog. Detail dialog has three tabs.

### Details

Details shows source vulnerability metadata:

- package name and ecosystem;
- CVE and GHSA identifiers;
- vulnerable version range and patched version;
- manifest path;
- severity and status;
- repository and Dependabot source link;
- detection, sync, and SLA timing when available.

If a finding was superseded by another finding, Details links the current canonical finding.

### Analysis

Analysis shows triage and sandbox-analysis evidence.

Triage can classify finding as Safe to dismiss, Needs analysis, or Needs review. Sandbox analysis can classify finding as Exploitable, Not exploitable, Monitor, Manual review, or Open PR depending on evidence.

Analysis tab shows current progress, failure state, model details, reasoning, usage locations, suggested fix, and next action. You can start analysis, retry failed analysis, restart active analysis when supported, or move to remediation when finding is eligible.

### Remediation

Remediation shows whether Security Agent can start a remediation attempt and why. It also shows remediation history, active attempts, PR outcomes, failure or blocked reasons, validation evidence, risk notes, cancellation state, and model used.

Available remediation actions depend on server-side safety checks. You may see Start remediation, Retry remediation, Cancel remediation, or View PR.

## Understand Statuses And Outcomes

Primary finding status tracks source lifecycle:

| Status | Meaning |
|---|---|
| Open | Active Security Finding that still needs resolution or dismissal. |
| Fixed | Dependabot reports the alert as fixed. |
| Dismissed | User or auto-dismiss closed the finding and synced dismissal to GitHub. |
| Superseded | Finding was replaced by a canonical finding after duplicate consolidation. |

Analysis outcome reflects what AI analysis determined:

| Outcome | Meaning |
|---|---|
| Not analyzed | No analysis has completed. |
| Queued | Analysis is waiting to run. |
| Analyzing | Analysis is running. |
| Analysis failed | Analysis did not complete. |
| Exploitable | Sandbox analysis confirmed reachable project risk. |
| Not exploitable | Sandbox analysis found no reachable vulnerable path. |
| Safe to dismiss | Triage recommends dismissal. |
| Needs review | Human decision required. |
| Triage complete | Triage finished and no sandbox result is present. |

Remediation status tracks Cloud Agent fix attempts:

| Status | Meaning |
|---|---|
| Queued | Remediation attempt accepted and waiting to run. |
| Starting | Cloud Agent launch is being prepared. |
| Running | Cloud Agent is working on the remediation. |
| Cancellation requested | User asked Cloud Agent to stop; cancellation is best effort. |
| PR opened | Security Agent verified a remediation PR for expected repository and branch. |
| No changes needed | Cloud Agent found no code change to make. Finding remains open. |
| Blocked | Security Agent or Cloud Agent could not proceed safely. |
| Failed | Attempt ended with failure. |
| Cancelled | Attempt stopped without opening a PR. |

## Dismiss Findings

You can dismiss a finding manually from finding details. Manual dismissal requires a reason:

- Fix started
- No bandwidth
- Tolerable risk
- Inaccurate
- Not used

You can optionally add a comment. Manual dismissal syncs back to GitHub and closes matching Dependabot alert.

Auto-dismiss can dismiss findings automatically when enabled. It dismisses findings that sandbox analysis determines are not exploitable. It can also dismiss triage-only findings that meet configured confidence threshold. Auto-dismissed alerts are written back to GitHub with a `[Kilo Code auto-dismiss]` prefix.

## Remediate Findings

Remediation creates a Security Remediation Attempt and asks Cloud Agent to prepare a fix. If Cloud Agent can make a safe change, it opens a pull request in the affected repository.

Starting remediation does not mark the Security Finding fixed. A remediation PR is evidence of work in progress. The finding remains open until Dependabot reports it fixed or someone dismisses it.

### Manual Remediation

Manual remediation can be started from an eligible finding even when Auto Remediation is disabled. Manual remediation does not need to meet Auto Remediation severity threshold.

Manual remediation still requires safety gates:

- finding is open;
- Security Agent is enabled;
- repository is still in Security Agent scope;
- sandbox analysis is complete and fresh for current finding data;
- analysis provides a concrete fix path;
- no active remediation attempt already exists;
- no known remediation PR already exists for finding.

Manual remediation can proceed from an unknown exploitability or manual-review result when a concrete fix path is available. Monitor-only findings are not eligible for one-click remediation.

### Auto Remediation

Auto Remediation is off by default. When enabled, Security Agent can automatically start remediation for findings that satisfy all automatic gates:

- finding is open;
- repository is in Security Agent scope;
- sandbox analysis is complete and fresh;
- finding is exploitable;
- analysis recommends opening a PR;
- analysis provides a concrete fix path;
- severity meets configured Auto Remediation threshold;
- no active attempt, known PR, or duplicate automatic terminal result exists.

Auto Remediation can act on future findings after analysis completes. If Include existing findings is enabled, Security Agent also queues already-analyzed eligible findings. Duplicate PRs and duplicate automatic attempts for same analysis result stay suppressed.

### Retry And Cancel

You can retry failed, blocked, cancelled, or no-changes-needed attempts when finding still passes safety gates and no PR has already opened.

You can cancel queued or running attempts. Cancellation is best effort. If Cloud Agent opens a verified PR before cancellation completes, Security Agent shows PR opened.

## Configure Security Agent

Settings are split into four tabs: General, Automation, Notifications, and SLA.

### General

General settings include:

| Setting | Default | Notes |
|---|---|---|
| Security Agent enabled | Off until you turn it on | Turning it on queues initial sync for selected repository scope. |
| Repository selection | Selected repositories during setup | Choose all accessible repositories or selected repositories. |
| Triage model | Kilo Balanced | Used for initial triage and exploitability recommendations. |
| Analysis model | Kilo Balanced | Used for sandbox analysis and result extraction. |
| Remediation model | Kilo Balanced | Used by Cloud Agent for remediation PR work. |
| Analysis mode | Auto | Auto, Shallow, or Deep. |

### Automation

Automation settings include:

| Setting | Default | Notes |
|---|---|---|
| Auto-analysis | Off | Automatically analyzes synced findings. |
| Auto-analysis minimum severity | High and above | Critical only, High and above, Medium and above, or All severities. |
| Auto-analysis include existing | Off | Queues previously synced eligible findings. |
| Auto-remediation | Off | Automatically opens PRs for eligible exploitable findings. |
| Auto-remediation minimum severity | High and above | Critical only, High and above, Medium and above, or All severities. |
| Auto-remediation include existing | Off | Queues already-analyzed eligible findings; duplicate PRs stay suppressed. |
| Auto-dismiss | Off | Automatically dismisses findings AI determines are not exploitable. |
| Auto-dismiss confidence threshold | High confidence only | High only, Medium or higher, or Any confidence. |

### Notifications

Notifications tab controls New-finding Notifications.

| Setting | Default | Notes |
|---|---|---|
| New-finding Notifications | Off | Sends email when Kilo first inserts an eligible open finding. |
| New-finding minimum severity | High and above | Critical, High, Medium, or Low minimum. |

For personal Security Agent, emails go to the owning user. For organization Security Agent, emails go to current organization owners only. Organization members and billing managers do not receive organization Security Agent notifications unless they are also organization owners.

Existing Dependabot alerts discovered during first Security Agent sync count as new because Kilo inserts them for first time during that sync. Enabling New-finding Notifications later does not replay historical insertions.

### SLA

SLA tab controls remediation deadlines and SLA notifications.

| Setting | Default | Notes |
|---|---|---|
| SLA tracking | On | Assigns persisted deadlines to open findings. |
| Critical deadline | 15 days | Editable from 1 to 365 days. |
| High deadline | 30 days | Editable from 1 to 365 days. |
| Medium deadline | 45 days | Editable from 1 to 365 days. |
| Low deadline | 90 days | Editable from 1 to 365 days. |
| SLA notifications | Off | Sends warning and breach emails. |
| SLA notification minimum severity | High and above | Critical, High, Medium, or Low minimum. |
| SLA warning lead time | 3 days | Whole number from 1 to 365 days. |

SLA Warning Notifications are eligible when an open finding reaches warning window before deadline. SLA Breach Notifications are eligible at or after persisted SLA deadline. Warning does not suppress later breach.

## Notification Delivery

Security Agent notifications use email in current implementation.

Notification kinds:

| Kind | When eligible |
|---|---|
| New-finding Notification | Kilo first inserts an eligible open finding. |
| SLA Warning Notification | Eligible open finding enters configured warning window before persisted SLA deadline. |
| SLA Breach Notification | Eligible open finding reaches or passes persisted SLA deadline. |

Security Agent creates at most one notification of each kind per finding and recipient. Repeated syncs and repeated sweeps do not intentionally create duplicate notification events.

Delivery is asynchronous. Before sending email, Kilo rechecks current finding state, Security Agent settings, severity thresholds, SLA state, and recipient authorization. If finding is fixed, dismissed, superseded, deleted, no longer meets threshold, or recipient is no longer authorized, unsent notification work is cancelled.

Email subjects are:

| Kind | Subject |
|---|---|
| New finding | Kilo Security Agent: New finding |
| SLA warning | Kilo Security Agent: SLA warning |
| SLA breach | Kilo Security Agent: SLA breached |

Emails include finding severity, repository, title, description, CVE/GHSA/CVSS metadata when available, SLA deadline for SLA emails, a link to Security Agent findings, and a link to relevant notification settings.

## Audit Reports

Audit report shows recorded Security Finding activity for an owner and UTC period. It is available from Security Agent navigation at:

- `/security-agent/audit-report`
- `/organizations/:organizationId/security-agent/audit-report`

Audit report is based on activity recorded by Kilo. It is not a proof that every historical event exists, not a repository scan-coverage report, and not an aggregate SLA compliance report.

### Report Period And Filters

Default report period is last 90 UTC calendar days ending today. A report period can include at most 90 inclusive UTC calendar days. Future and reversed ranges are rejected.

Filters:

| Filter | Options |
|---|---|
| UTC period | Date range up to 90 inclusive calendar days. |
| Severity | All, Critical, High, Medium, Low. |
| Recorded state | All, Open, Fixed, Dismissed, Superseded, Deleted. |
| Repository | All repositories or one repository recorded in report evidence. |

Filters keep complete in-period timeline for every matching finding group.

### Report Content

Report summary shows finding count, event count, superseded count, and finding counts by severity.

Each finding group can show:

- stable Security Finding ID and source identity;
- repository;
- title;
- severity;
- recorded state;
- package, ecosystem, and manifest path;
- patched version;
- CVE, GHSA, CWE, and CVSS metadata;
- Dependabot URL when recorded;
- first detected time;
- canonical finding ID when superseded;
- deletion status;
- recorded SLA evidence when trustworthy.

Each timeline event shows when Kilo recorded or applied activity, who or what performed it, and structured evidence such as status, severity, remediation state, failure reason, PR URL, or source timestamp.

### Reportable Activity

Audit report includes material Security Finding activity when recorded in selected period:

- finding imported into Kilo;
- severity changed;
- status changed, including reopened and fixed;
- manual dismissal, auto-dismissal, superseded, and deletion;
- terminal analysis completed or failed;
- remediation requested;
- remediation ended with PR opened, failed, blocked, cancelled, or no changes needed.

Audit report does not include reads, page views, unchanged sync observations, queue claims, heartbeats, retries with no new finding-level outcome, notification delivery history, repository scan-coverage appendices, configuration timelines, or report-generation events inside report itself.

Reliable event coverage begins at `2026-06-12T00:00:00.000Z`. Activity before reliable coverage may be incomplete when present as supplemental legacy activity.

If report query fails, times out, or exceeds budget, Kilo returns no partial report content. Choose a shorter UTC period and generate report again.

### Report Access

Personal audit reports are available to owning user.

Organization audit reports are available to organization owners, billing managers, and Kilo platform admins. Ordinary organization members can use other Security Agent surfaces but cannot access organization audit reports through current route permissions.

Security Agent does not need to be enabled to view an existing report. Report page loads after GitHub integration and initial Security Agent configuration exist. Setup-only states redirect to Settings.

## Clear Orphaned Findings

If repositories are removed from GitHub integration or become inaccessible, their findings can become orphaned. Settings page shows a cleanup card when orphaned repositories exist.

Clearing orphaned findings permanently deletes findings for selected repository. This cannot be undone. Use it only when repository will not be reconnected.

## Compare With Code Reviews

Security Agent and Code Reviews cover different security surfaces.

| Feature | What it covers |
|---|---|
| Code Reviews | Pull request diffs, including security patterns in new code. |
| Security Agent | Dependency vulnerability alerts across selected repositories, including reachability analysis and remediation for Dependabot findings. |

Use Code Reviews to catch risky changes before merge. Use Security Agent to manage dependency vulnerability backlog and determine which Dependabot alerts are exploitable in your codebase.

## Limitations

Current implementation has these limits:

- GitHub only. GitLab is not supported for Security Agent findings or remediation.
- Dependabot alerts only. npm audit, SBOM analysis, and other sources are not supported as Security Finding sources.
- Notification channel is email only.
- New-finding Notifications do not replay historical insertions after you enable them.
- Analysis and remediation run through queues and can be delayed by account capacity or worker backlog.
- Cloud Agent can open remediation PRs, but a PR does not mark a finding fixed.
- Security Agent does not automatically track full remediation PR lifecycle after PR creation.
- Security Agent does not combine multiple Security Findings into one planned remediation.
- Security Agent does not preflight repository write permission at settings time.
- Audit report ranges are limited to 90 days.
- Audit reports show recorded Kilo activity only. They do not reconstruct complete legacy history or publish aggregate historical SLA compliance percentages.
- Server-side stored report artifacts, PDFs, report caching, and exhaustive notification delivery history are not part of current audit report.
