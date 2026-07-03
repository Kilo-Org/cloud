# Context

## Scope

Kilo Code Cloud hosts Kilo Code agents, integrations, and automation. This contract defines Code Reviewer, Security Agent, and Cost Insights language plus ownership boundaries used across review execution, analytics, sync, web, email, remediation, billing alerts, tests, and product documentation.

## Contexts

| Context | Owns | Location | Notes |
|---|---|---|---|
| **Code Reviewer** | Pull request and merge request review execution, Code Review Findings, review settings, and Review Analytics | `apps/web/src/lib/code-reviews/`, `apps/web/src/components/code-reviews/` | A Code Reviewer owner is either one user or one organization; Review Analytics collection is organization- and platform-scoped |
| **Security Agent** | Security Findings, owner-scoped policy, settings, Auto Remediation, and user-visible outcomes | `apps/web/src/lib/security-agent/`, `apps/web/src/components/security-agent/`, `.specs/security-agent.md` | A Security Agent owner is either one user or one organization |
| **Security Sync** | Dependabot synchronization, finding persistence, notification eligibility, recipient intent materialization, and durable notification state | `services/security-sync/` | Event state remains owner-scoped; email sending does not occur inside finding persistence transactions |
| **Security Agent Email Delivery** | Dispatch-time revalidation, email rendering, owner-aware links, and Mailgun delivery | `apps/web/src/app/api/internal/security-agent/`, `apps/web/src/lib/email.ts`, `apps/web/src/emails/` | Accepts notification identity only and loads current data before sending |
| **Shared Security Notification Policy** | Canonical config parsing, defaults, severity thresholds, and pure event eligibility rules | `packages/worker-utils/src/security-notification-policy.ts` | Web and Worker must use same policy contract |
| **Cost Insights** | Spend evidence dashboard, Spend Alerts policy, alert history, and owner-scoped spend alerting | Billing, usage ingestion, usage analytics, and subscription-management surfaces | Applies to both personal users and organizations |

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
| **Cost Insights** | Dedicated Usage-adjacent surface for viewing spend evidence, configuring Spend Alerts, and acting on Cost Suggestions | Naming the product surface, dashboard, settings, routes, or sidebar item | Spend Protection, Cost Controls |
| **Spend Alerts** | Owner-scoped alerting capability for unusual or excessive Credit spend | Referring to alert evaluation, emails, banners, settings, or notification policy | Spend Protection, hard limit, spend blocker |
| **Cost Suggestion** | Optional owner-scoped recommendation based on observed Credit spend that may improve cost efficiency through an eligible Coding Plan or Kilo Pass | Referring to recommendation evaluation, dashboard cards, emails, CTA destinations, dismissal, or settings | Alert, warning, guaranteed savings, automatic optimization |
| **Suggestion dismissal** | Authorized owner action that hides one Cost Suggestion without changing billing or future suggestion eligibility | Referring to dismissing a recommendation | Alert acknowledgment, unsubscribe, disable suggestions |
| **Spend owner** | Personal user or organization whose credit balance is charged for Credit spend | Referring to the Spend Alerts policy and evaluation boundary | Account when personal/org ambiguity matters |
| **Spend Anomaly Alert** | Spend Alert triggered when short-window owner Credit spend exceeds that owner's normal usage pattern | Referring to hourly burst-detection Spend Alerts | Low-balance alert, threshold alert |
| **Variable Credit spend** | Credit spend created by request-metered product usage such as token usage or metered tool/API usage | Referring to spend that can burst unexpectedly during active usage | Scheduled Credit spend |
| **Scheduled Credit spend** | Predictable Credit spend created by subscription-like purchases, renewals, or hosting deductions | Referring to expected recurring or explicitly purchased credit deductions | Variable Credit spend |
| **Spend Threshold Alert** | Spend Alert triggered when owner Credit spend crosses a configured rolling 24-hour, rolling 7-day, or rolling 30-day spend threshold | Referring to threshold notification identity or review | Warning threshold, critical threshold, quota |
| **Spend threshold** | Optional configured rolling 24-hour, rolling 7-day, or rolling 30-day owner Credit-spend amount for Spend Threshold Alerts | Referring to any supported threshold window | Hard limit, budget cap, daily quota |
| **Alert acknowledgment** | Authorized owner action that marks the current alert episode as reviewed | Referring to review without changing settings | Email open, page view, passive acknowledge |
| **Cost Insight Event** | Durable owner-scoped record of Spend Alert notifications, reviews, configuration changes, and disablement | Referring to 90-day Cost Insights history | Raw usage row, provider log |

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
- **Spend Alerts** and **Cost Suggestions** belong to exactly one **Spend owner**: one personal user or one organization.
- All Credit spend charged to a **Spend owner** counts toward that owner's Spend Alerts and Cost Suggestion evaluation.
- **Cost Suggestions** are enabled by default, independent from Spend Alerts, and recommend an eligible Coding Plan or Kilo Pass when observed Credit spend indicates potential cost-efficiency benefit.
- Cost Suggestions are advisory. They do not guarantee savings, automatically purchase or change subscriptions, or alter spend behavior.
- Every active Cost Suggestion provides one destination CTA and a **Suggestion dismissal** action.
- Suggestion dismissal hides that specific recommendation, creates a **Cost Insight Event**, and does not disable future materially different Cost Suggestions.
- Disabling Cost Suggestions suppresses new suggestion emails and active dashboard suggestions but preserves prior suggestion activity history.
- During initial rollout, Cost Insights v1 is available only to users whose current Kilo platform user record has `is_admin` set to `true`; access does not depend on a release-toggle gate.
- **Spend Alerts** are inactive until a **Spend owner** explicitly enables them.
- **Spend Anomaly Alerts** are enabled by default whenever **Spend Alerts** are enabled, and Spend owners may opt out independently.
- First enable immediately evaluates each enabled alert sub-option: anomaly state plus configured rolling 24-hour, rolling 7-day, and rolling 30-day **Spend threshold** state.
- First enable can create alert email and banner when current spend already crosses enabled alert state.
- **Spend Alerts** are alert-only. They do not block spend, pause usage, throttle usage, suppress auto-top-up, reject paid requests, or return Spend Alerts-specific HTTP 402 responses.
- Existing low-balance and depleted-credit billing behavior remains separate from **Spend Alerts**.
- **Spend Anomaly Alerts** detect hourly Credit-spend bursts, not only daily spend increases.
- **Spend Anomaly Alerts** evaluate bursty **Variable Credit spend** separately from predictable **Scheduled Credit spend**.
- **Spend Anomaly Alerts** use a Postgres owner-hourly spend rollup, not warehouse-only hourly analytics.
- Spend Alerts hourly rollups are maintained for all **Spend owners**, including owners who have not enabled Spend Alerts.
- V1 **Spend Anomaly Alert** sensitivity is product-managed and fixed; users cannot configure sensitivity, custom multipliers, or custom floors.
- Default **Spend Anomaly Alert** baseline is trailing 7-day hourly p95 **Variable Credit spend**.
- Spend Anomaly Alert baseline uses completed prior UTC-hour buckets and excludes the current UTC hour.
- Owners with at least 24 completed hourly buckets use available-history p95 even before 7 full days exist.
- Owners without at least 24 hourly baseline buckets use a starter current-hour **Variable Credit spend** floor for **Spend Anomaly Alerts**.
- **Spend Anomaly Alerts** may fire at most once per owner per hour while anomalous spend persists.
- **Spend Threshold Alerts** use separate notification identity from **Spend Anomaly Alerts** and from each other threshold window.
- Spend owners may configure independent optional rolling 24-hour, rolling 7-day, and rolling 30-day **Spend thresholds**, stored as microdollars and displayed with cent precision.
- The threshold windows are exact half-open intervals: `[asOf - 24h, asOf)`, `[asOf - 7d, asOf)`, and `[asOf - 30d, asOf)`.
- Each **Spend Threshold Alert** evaluates all owner Credit spend in its configured rolling window, including **Variable Credit spend** and **Scheduled Credit spend**.
- Each threshold window maintains separate crossing, review, recovery, and notification identity; it fires once per below-to-above crossing and may fire again only after spend in that window drops below its threshold and later crosses it again.
- **Alert acknowledgment** reviews the current anomaly or threshold episode without requiring settings changes.
- Threshold review offers acknowledge and Manage threshold; management opens the matching 24-hour, 7-day, or 30-day Cost Insights setting where authorized managers can adjust or disable it.
- Active threshold alerts expose snapshotted top drivers from the exact evaluated rolling window across Variable and Scheduled Credit spend.
- **Spend Alerts** are sent only to Kilo platform admins: the admin personal user's email for personal owners, and active organization owners or billing managers who are also platform admins for organization owners.
- Spend Alerts store owner-scoped **Cost Insight Events** separately from per-recipient notification delivery rows.
- Spend Alerts snapshot intended notification recipients at event creation and revalidate recipient access before delivery.
- Spend Alerts notification delivery rows are deleted with their parent **Cost Insight Event** after 90 days.
- **Spend Alerts** v1 sends email and shows an owner-scoped in-app banner until **Alert acknowledgment**. It does not send mobile or push notifications in v1.
- Active Spend Alert banners and review actions are visible to all current authorized managers, regardless of original email recipient snapshot.
- Spend Alert emails deep-link to the Cost Insights dashboard review context, not settings-first flow.
- Cost Insights retains and displays 90 days of **Cost Insight Events**.
- **Cost Insight Events** include configuration changes, anomaly alerts, threshold alerts, reviews, and disablement.
- Cost Insight Event history remains fixed to 90 days even though hourly rollups are retained indefinitely.
- Cost Insight Events are deleted after 90 days rather than merely hidden.
- Cost Insight Event retention is enforced by daily app cron deletion.
- **Cost Insight Events** store summarized decision snapshots such as threshold, rolling spend totals, current-hour variable spend, baseline, and top driver dimensions. They do not copy raw request rows.
- Alert **Cost Insight Events** snapshot top 5 spend drivers at event creation time.
- Cost Insight Events store direct evaluated settings in snapshots and do not require config version tracking in v1.
- Spend Alert config events store changed fields plus resulting key settings, not full config snapshots.
- **Cost Insights** is the dedicated Usage-adjacent surface for Spend Alerts: `/cost-insights` and `/organizations/[id]/cost-insights` are dashboard routes; `/cost-insights/config` and `/organizations/[id]/cost-insights/config` are settings routes.
- Cost Insights dashboard shows current alert state, review actions, and spend evidence. Cost Insights settings owns Spend Alerts policy.
- Cost Insights appears directly below Usage in the personal and organization sidebars and shows attention state for unreviewed Spend Alerts and active Cost Suggestions.
- Organization Cost Insights identifies member spend drivers and links to existing organization member daily limit controls; v1 does not add per-member Spend Alert policy.
- Personal and organization Cost Insights routes, navigation, attention queries, and API procedures are visible only to users whose current Kilo platform user record has `is_admin` set to `true`.
- Kilo platform admins may inspect organization Spend Alerts under existing admin patterns, but v1 disable and settings changes require owner or billing-manager authority.
- Spend Alert config and review actions do not require reason text in v1; events record actor, action, old and new values where applicable, and timestamp.
- Disabling Spend Alerts keeps the owner config row disabled rather than deleting it.
- Re-enabling Spend Alerts reuses existing saved settings unless an authorized manager changes them.
- Re-enabling Spend Alerts immediately evaluates each enabled sub-option: current-hour anomaly state and all three configured rolling spend threshold windows.
- While Spend Alerts are disabled, settings changes save only and do not evaluate controls, create events, or send emails.
- Cost Insights dashboard shows read-only recent spend evidence even when Spend Alerts are disabled.
- Cost Insights dashboard default evidence shows a 24-hour spend summary plus a 7-day hourly chart.
- Cost Insights dashboard supports preset evidence ranges: current UTC hour, 24h, 7d, 30d, and 90d; the current-hour preset updates both spend evidence and top drivers.
- Active Spend Anomaly Alerts snapshot and expose the top current-hour Variable Credit spend drivers with their UTC-hour evidence window.
- Spend Alerts owner state stores active episode dedupe and review state separately from 90-day event history.
- Spend Alerts owner state stores minimal current episode markers for anomaly hour, threshold crossing state, and review status.
- Spend Alerts use dedicated normalized storage for owner configuration, owner state, hourly spend rollups, and **Cost Insight Events**.
- Cost Insights settings show Spend Anomaly Alerts, rolling 24-hour, rolling 7-day, and rolling 30-day **Spend thresholds** in that order as sub-options of Spend Alerts.
- Enabling Spend Alerts uses already-maintained owner hourly rollups for baseline data, with Postgres source-of-truth backfill or repair when rollups are missing.
- Threshold evaluation falls back to exact canonical Postgres source data when rolling 7-day or rolling 30-day rollup coverage is incomplete.
- Spend Alerts store owner-hour totals separately from compact owner-hour driver buckets.
- Spend Alerts owner-hour totals record all Credit spend and label spend category so anomaly evaluation can distinguish **Variable Credit spend** from **Scheduled Credit spend**.
- Spend Alerts owner-hour totals are keyed by spend category, with separate rows for Variable Credit spend and Scheduled Credit spend.
- Spend Alerts owner-hour buckets use UTC hour start timestamps.
- Spend Alerts driver buckets group owner-hour spend by compact dimensions such as product or feature, model or provider, and actor user where applicable.
- Spend Alerts driver buckets are keyed by spend category as well as source and driver dimensions.
- Spend Alerts driver buckets use controlled taxonomy values, with `other` for unknown source classification.
- V1 Spend Alerts source taxonomy is `ai_gateway`, `kiloclaw`, `coding_plan`, and `other`.
- Spend Alerts owner-hour totals and driver buckets are retained indefinitely in v1.
- Spend Alerts driver buckets may retain actor user IDs indefinitely because soft-deleted user rows are anonymized. Driver buckets and event snapshots must not copy actor email or actor display name.
- Spend Alerts store actor user IDs in driver buckets for both personal and organization spend; UI resolves member labels from current user rows at render time.
- Spend Alerts driver buckets store total spend and contributing spend-record count.
- Every Credit spend path updates the Spend Alerts hourly rollup atomically with spend recording.
- Credit spend must not commit unless the corresponding Spend Alerts hourly rollup update also commits.
- Spend Alerts evaluation runs asynchronously after Credit spend updates and through an hourly sweep that catches missed evaluations and rolling-window transitions.
- Async Spend Alerts evaluation uses current config at evaluation time.
- V1 Spend Alerts evaluation runs in `apps/web` through post-spend async execution and an app cron hourly sweep.
- Organization **Spend Alerts** are managed by organization owners and billing managers who are also Kilo platform admins during initial rollout.
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
- Use **Cost Insights** for the user-facing surface, **Spend Alerts** for the alerting capability, and **Cost Suggestion** for optional cost-efficiency recommendations. Do not call this feature Spend Protection or Cost Controls.
- Do not describe a Cost Suggestion as an alert, warning, guaranteed savings, automatic optimization, or required action.
- Use **Spend Threshold Alert** and **Spend threshold** for the independent rolling 24-hour, rolling 7-day, and rolling 30-day threshold windows. Do not introduce warning or critical threshold tiers.
- Keep Spend Alerts alert-only. Do not describe them as spend blocks, hard limits, pauses, throttles, or request admission controls.

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
- Spend Alerts email delivery may retry per-recipient delivery rows but must not create duplicate owner-scoped Cost Insight Events.
- Spend Alerts email delivery must not send to an organization recipient who no longer has authorized access at dispatch time.
- Treat active Spend Alerts banner visibility as current owner state, not notification-recipient history.
- **Shared Security Notification Policy** defines common parsing and pure eligibility behavior; it does not perform persistence or recipient lookup.
- Cross-context dispatch sends only stable notification ID from **Security Sync** to authenticated **Security Agent Email Delivery** boundary.
- **Spend Alerts** evaluate personal and organization Credit spend at the owner boundary, not per product by default.
- Do not assume Spend Alerts apply to owners who have not opted in.
- Do not make Spend Alerts block, pause, throttle, suppress auto-top-up, reject paid requests, or emit Spend Alerts-specific HTTP 402 responses.
- Do not hide v1 Cost Insights behind a release-toggle gate unless a later product decision supersedes public opt-in.
- Do not make Spend Alerts depend on Snowflake-only usage analytics for detection.
- During initial rollout, treat organization owners and billing managers as authorized managers for organization Spend Alerts only when they are also Kilo platform admins.
- Surface Spend Alerts through **Cost Insights** dashboard and settings routes, not as only an embedded usage, credits, or subscriptions control.

## Decision References

- `.specs/cost-insights.md` defines Cost Insights and Spend Alerts business rules.
- `.plans/code-review-analytics.md` defines prospective Review Analytics collection, taxonomy, persistence, and metric semantics.
- `.specs/security-agent.md` defines Security Agent Auto Remediation and notification guarantees.
- `.plans/security-agent-notifications.md` records notification implementation and rollout design.
- `.plans/security-agent-audit-report.md` records Security Agent Audit Report implementation and evidence design.
