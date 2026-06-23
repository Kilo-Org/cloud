# Context

## Scope

Kilo Code Cloud hosts Kilo Code agents, integrations, and automation. This contract defines Code Reviewer and Security Agent language plus ownership boundaries used across review execution, analytics, sync, web, email, remediation, tests, and product documentation.

## Contexts

| Context | Owns | Location | Notes |
|---|---|---|---|
| **Code Reviewer** | Pull request and merge request review execution, Code Review Findings, review settings, and Review Analytics | `apps/web/src/lib/code-reviews/`, `apps/web/src/components/code-reviews/` | A Code Reviewer owner is either one user or one organization; Review Analytics collection is organization- and platform-scoped |
| **Security Agent** | Security Findings, owner-scoped policy, settings, Auto Remediation, and user-visible outcomes | `apps/web/src/lib/security-agent/`, `apps/web/src/components/security-agent/`, `.specs/security-agent.md` | A Security Agent owner is either one user or one organization |
| **Security Sync** | Dependabot synchronization, finding persistence, notification eligibility, recipient intent materialization, and durable notification state | `services/security-sync/` | Event state remains owner-scoped; email sending does not occur inside finding persistence transactions |
| **Security Agent Email Delivery** | Dispatch-time revalidation, email rendering, owner-aware links, and Mailgun delivery | `apps/web/src/app/api/internal/security-agent/`, `apps/web/src/lib/email.ts`, `apps/web/src/emails/` | Accepts notification identity only and loads current data before sending |
| **Shared Security Notification Policy** | Canonical config parsing, defaults, severity thresholds, and pure event eligibility rules | `packages/worker-utils/src/security-notification-policy.ts` | Web and Worker must use same policy contract |

## Canonical Terms

| Term | Agent meaning | Use this when | Avoid |
|---|---|---|---|
| **Code Reviewer** | Agent that reviews pull requests and merge requests and may raise Code Review Findings | Naming the product capability, settings, review execution, and analytics | Security Agent, review bot |
| **Code Review Finding** | Model-generated issue newly raised by Code Reviewer during one review execution | Referring to Code Reviewer output or its controlled analytics taxonomy | Security Finding, confirmed bug, verified vulnerability |
| **Review Analytics** | Organization-only, opt-in prospective collection of bounded classifications for completed reviews and newly raised Code Review Findings | Referring to the Code Reviewer Analytics tab, collection setting, coverage, or aggregate metrics | Security Agent analytics, historical backfill |
| **AI-estimated impact** | Code Reviewer's low, medium, or high estimate of a change's reach and consequence, independent of diff size, change type, complexity, and finding count | Referring to impact classifications or derived impact points | Developer quality, individual performance, delivered impact |
| **Security Agent** | Agent that syncs, analyzes, and helps resolve repository Security Findings | Naming product capability, settings, routes, and behavior | Security Reviews |
| **Security Finding** | Vulnerability item owned by one user or organization for a repository, usually synced from Dependabot | Referring to Kilo's persisted vulnerability domain object | Security review, alert |
| **Auto Remediation** | Security Agent feature that automatically starts Security Remediations for eligible Security Findings | Referring to policy-driven remediation admission | Auto Fix |
| **Security Remediation** | Security Agent-owned remediation task created from a Security Finding after analysis determines that a pull request is right next step | Referring to remediation task and its lifecycle | Auto Fix ticket |
| **Security Remediation Attempt** | One attempt to remediate a Security Finding through Cloud Agent, including session and pull request outcome | Referring to individual execution or retry | Auto Fix run |
| **Cloud Agent Write Identity** | Identity Cloud Agent uses to push remediation branches and open pull requests for Security Remediations | Referring to Git write attribution | Security Agent Bot |
| **Security Agent Notification** | Durable per-finding, per-recipient event with one specific notification kind | Referring to event identity, eligibility, deduplication, or durable state | Notification email, reminder, alert |
| **New-finding Notification** | Security Agent Notification admitted only when eligible finding is first inserted into Kilo | Referring to first-insertion event, including initial import of existing source alerts | New alert email, discovery reminder |
| **SLA Warning Notification** | Security Agent Notification admitted after eligible finding enters configured warning window and before persisted deadline | Referring to pre-deadline SLA event | SLA reminder, deadline alert |
| **SLA Breach Notification** | Security Agent Notification admitted when eligible finding reaches or passes persisted SLA deadline | Referring to at-or-after-deadline event | Overdue alert, breach reminder |
| **Notification Recipient** | User authorized to receive one Security Agent Notification: personal owner or current organization owner | Referring to per-user event identity and authorization | Subscriber, watcher, all organization members |
| **Email Delivery** | Attempt to render and send one Security Agent Notification through Mailgun | Referring to provider side effect, retry, or acceptance | Notification event |
| **Security Finding Activity Event** | Immutable record of one material user, system-policy, or source-driven action or outcome that changes or explains a Security Finding | Referring to evidence included in a Security Agent Audit Report | Page view, unchanged sync observation, queue claim, heartbeat |
| **Security Agent Audit Report** | Owner-scoped, period-bounded audit view of Security Finding Activity Events grouped by Security Finding | Referring to the interactive audit report | Generic audit-log export, activity dump |

## Relationships

- A **Code Review Finding** belongs to one captured Code Reviewer review result and contains only controlled taxonomy values in Review Analytics.
- **Review Analytics** enrollment is available only to organization-owned reviews and is snapshotted when a Code Reviewer execution attempt is dispatched; changing the setting does not change an in-flight attempt.
- **AI-estimated impact** describes a reviewed change and remains independent from Code Review Finding counts.
- A **Security Finding** belongs to exactly one Security Agent owner: one user or one organization.
- A **Security Finding** can create at most one **Security Agent Notification** of each kind per **Notification Recipient**.
- A **New-finding Notification** depends on first insertion into Kilo, not source alert creation time.
- An **SLA Warning Notification** and **SLA Breach Notification** use persisted `sla_due_at`; warning does not suppress later breach.
- A Security Agent Audit Report may show a persisted SLA deadline and recorded outcome when trustworthy evidence exists. V1 does not redefine live SLA behavior or calculate authoritative historical SLA compliance.
- A **Notification Recipient** for an organization finding is a current organization member with role `owner`.
- An **Email Delivery** realizes a durable **Security Agent Notification** and may be retried without creating new event identity.
- A **Security Remediation** belongs to one **Security Finding** and can have one or more **Security Remediation Attempts**.
- A **Security Finding Activity Event** belongs to one Security Agent owner and one Security Finding, including after that finding is deleted.
- A **Security Finding Activity Event** falls into a report period based on when Kilo recorded or applied it. External source timestamps are supporting evidence and do not determine report inclusion.
- A **Security Agent Audit Report** groups every matching reportable **Security Finding Activity Event** recorded by Kilo in the selected period.
- V1 reports persisted SLA evidence only when it can do so from trustworthy recorded data. It does not calculate historical SLA compliance percentages or introduce new SLA lifecycle semantics.
- A personal **Security Agent Audit Report** is available only to its owning user. An organization report is available to organization owners, billing managers, and audited Kilo platform admins, not ordinary members.
- Security Agent Audit Report access has no separate plan or active-subscription gate; authorized owners retain read-only historical access after cancellation or disablement.
- A **Security Agent Audit Report** includes owner history from current, deselected, unavailable, and deleted repository scope. Current Security Agent repository selection does not limit historical evidence; an explicit report repository filter may narrow displayed Security Finding groups by exact recorded repository full name.
- Human activity in a **Security Agent Audit Report** uses an event-time display name and stable typed actor reference; automated activity uses explicit system attribution. Actor and notification recipient emails are not report evidence.
- Deleting an actor's Kilo account anonymizes their dedicated identity fields in organization-owned Security Finding Activity Events while preserving stable non-PII attribution and event evidence. Identity-bearing values do not belong in event snapshots or arbitrary metadata.
- Superseded Security Findings remain separate report groups and show their canonical Security Finding ID when recorded; canonical remediation evidence is not copied into superseded groups.
- Each v1 report range is capped at 90 inclusive calendar days.
- A report displays its reliable event-coverage start and labels supplemental legacy activity as potentially incomplete.
- Disabling Security Agent or its integration does not hide authorized historical Security Agent Audit Reports.
- `security_audit_log` is the canonical ledger for Security Finding Activity Events; finding events are distinguished by stable finding identity.
- A reportable local Security Finding state transition and its Security Finding Activity Event are atomic. External side effects use a durable request event and terminal outcome event without keeping database transactions open across network calls.
- Security Agent Audit Reports include structured, sanitized analysis and remediation outcomes, not prompts, raw analysis markdown, transcripts, assistant messages, full execution logs, or recipient-level notification history.

## Agent Rules

- Use **Code Review Finding** for an issue raised by Code Reviewer. Never call it a **Security Finding**, even when its category is `security`.
- Describe Review Analytics values as model-generated signals: use "findings raised" and **AI-estimated impact**, not confirmed bugs, verified vulnerabilities, or developer quality.
- Keep Review Analytics organization-only, prospective, and opt-in. Missing, invalid, or omitted structured results are unavailable coverage states, not zero-finding reviews.
- Do not persist finding prose, code, paths, lines, symbols, prompts, raw manifests, or full assistant output in Review Analytics.
- Use **Security Finding** for Kilo's persisted domain object. Use "Dependabot alert" only for external source object at GitHub boundary.
- Use exact notification kind when discussing eligibility or history: **New-finding Notification**, **SLA Warning Notification**, or **SLA Breach Notification**.
- Treat "new" as first insertion for owner in Kilo. Updates and reopening do not make finding new again.
- Distinguish **Security Agent Notification** from **Email Delivery**. Event deduplication does not guarantee provider-level exactly-once delivery.
- Use "Security Agent owner" for user/organization policy boundary and "organization owner" for membership role.
- Keep notification eligibility and outbox transitions in **Security Sync**. Keep rendering and Mailgun access in **Security Agent Email Delivery**.
- Keep notification config parsing and pure eligibility semantics in **Shared Security Notification Policy** so web and Worker cannot drift.
- Do not call organization members or billing managers **Notification Recipients** unless they also hold current organization `owner` role.
- Treat "all activity" in a **Security Agent Audit Report** as all material actions and outcomes recorded by Kilo, not every internal processing step or an attestation that legacy history is exhaustive. Exclude reads, unchanged sync observations, queue claims, heartbeats, and retries with no new finding-level outcome.
- A rollout baseline event records current state at actual capture time for an existing Security Finding; it is not a synthetic creation event and must not be backdated.

## Ambiguities

| Ambiguous term | Problem | Canonical decision |
|---|---|---|
| finding | Can mean Code Reviewer output or the Security Agent's persisted vulnerability object | Use **Code Review Finding** for Code Reviewer output and **Security Finding** only for the Security Agent domain object |
| impact | Can imply delivered business value, diff size, complexity, or individual performance | Use **AI-estimated impact** only for the model-generated reach-and-consequence classification |
| alert | Can mean external Dependabot alert, persisted Security Finding, or outgoing notification | Use "Dependabot alert" at source boundary, **Security Finding** after persistence, and exact notification kind for outgoing event |
| notification email | Conflates durable semantic event with retryable provider side effect | Use **Security Agent Notification** for event and **Email Delivery** for send attempt |
| new finding | Can mean newly created at source, first observed, inserted, updated, or reopened | For notification policy, it means first insertion into Kilo for owner |
| owner | Can mean Security Agent policy owner or organization membership role | Use "Security Agent owner" for user/organization boundary and "organization owner" for role |
| SLA reminder | Does not distinguish warning before deadline from breach at/after deadline | Use **SLA Warning Notification** or **SLA Breach Notification** |

## Context Boundaries

- **Code Reviewer** owns review execution, Code Review Findings, Review Analytics settings, and user-visible aggregate review signals.
- Review Analytics stores bounded taxonomy observations separately from Security Agent `security_findings` and does not establish a cross-review finding lifecycle.
- **Security Agent** owns product policy, settings, permissions, and user-visible finding/remediation outcomes.
- **Security Sync** owns finding synchronization, notification event admission, recipient intent materialization, deduplication, and durable state transitions.
- **Security Agent Email Delivery** may revalidate and deliver an existing notification but must not create notification eligibility or copy mutable finding data into Worker request.
- **Shared Security Notification Policy** defines common parsing and pure eligibility behavior; it does not perform persistence or recipient lookup.
- Cross-context dispatch sends only stable notification ID from **Security Sync** to authenticated **Security Agent Email Delivery** boundary.

## Decision References

- `.plans/code-review-analytics.md` defines prospective Review Analytics collection, taxonomy, persistence, and metric semantics.
- `.specs/security-agent.md` defines Security Agent Auto Remediation and notification guarantees.
- `.plans/security-agent-notifications.md` records notification implementation and rollout design.
- `.plans/security-agent-audit-report.md` records Security Agent Audit Report implementation and evidence design.
