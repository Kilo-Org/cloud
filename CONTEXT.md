# Context

## Scope

Kilo Code Cloud hosts Kilo Code agents, integrations, and automation. This contract currently defines Security Agent language and notification ownership boundaries used across sync, web, email, remediation, tests, and product documentation.

## Contexts

| Context | Owns | Location | Notes |
|---|---|---|---|
| **Security Agent** | Security Findings, owner-scoped policy, settings, Auto Remediation, and user-visible outcomes | `apps/web/src/lib/security-agent/`, `apps/web/src/components/security-agent/`, `.specs/security-agent.md` | A Security Agent owner is either one user or one organization |
| **Security Sync** | Dependabot synchronization, finding persistence, notification eligibility, recipient intent materialization, and durable notification state | `services/security-sync/` | Event state remains owner-scoped; email sending does not occur inside finding persistence transactions |
| **Security Agent Email Delivery** | Dispatch-time revalidation, email rendering, owner-aware links, and Mailgun delivery | `apps/web/src/app/api/internal/security-agent/`, `apps/web/src/lib/email.ts`, `apps/web/src/emails/` | Accepts notification identity only and loads current data before sending |
| **Shared Security Notification Policy** | Canonical config parsing, defaults, severity thresholds, and pure event eligibility rules | `packages/worker-utils/src/security-notification-policy.ts` | Web and Worker must use same policy contract |

## Canonical Terms

| Term | Agent meaning | Use this when | Avoid |
|---|---|---|---|
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

## Relationships

- A **Security Finding** belongs to exactly one Security Agent owner: one user or one organization.
- A **Security Finding** can create at most one **Security Agent Notification** of each kind per **Notification Recipient**.
- A **New-finding Notification** depends on first insertion into Kilo, not source alert creation time.
- An **SLA Warning Notification** and **SLA Breach Notification** use persisted `sla_due_at`; warning does not suppress later breach.
- A **Notification Recipient** for an organization finding is a current organization member with role `owner`.
- An **Email Delivery** realizes a durable **Security Agent Notification** and may be retried without creating new event identity.
- A **Security Remediation** belongs to one **Security Finding** and can have one or more **Security Remediation Attempts**.

## Agent Rules

- Use **Security Finding** for Kilo's persisted domain object. Use "Dependabot alert" only for external source object at GitHub boundary.
- Use exact notification kind when discussing eligibility or history: **New-finding Notification**, **SLA Warning Notification**, or **SLA Breach Notification**.
- Treat "new" as first insertion for owner in Kilo. Updates and reopening do not make finding new again.
- Distinguish **Security Agent Notification** from **Email Delivery**. Event deduplication does not guarantee provider-level exactly-once delivery.
- Use "Security Agent owner" for user/organization policy boundary and "organization owner" for membership role.
- Keep notification eligibility and outbox transitions in **Security Sync**. Keep rendering and Mailgun access in **Security Agent Email Delivery**.
- Keep notification config parsing and pure eligibility semantics in **Shared Security Notification Policy** so web and Worker cannot drift.
- Do not call organization members or billing managers **Notification Recipients** unless they also hold current organization `owner` role.

## Ambiguities

| Ambiguous term | Problem | Canonical decision |
|---|---|---|
| alert | Can mean external Dependabot alert, persisted Security Finding, or outgoing notification | Use "Dependabot alert" at source boundary, **Security Finding** after persistence, and exact notification kind for outgoing event |
| notification email | Conflates durable semantic event with retryable provider side effect | Use **Security Agent Notification** for event and **Email Delivery** for send attempt |
| new finding | Can mean newly created at source, first observed, inserted, updated, or reopened | For notification policy, it means first insertion into Kilo for owner |
| owner | Can mean Security Agent policy owner or organization membership role | Use "Security Agent owner" for user/organization boundary and "organization owner" for role |
| SLA reminder | Does not distinguish warning before deadline from breach at/after deadline | Use **SLA Warning Notification** or **SLA Breach Notification** |

## Context Boundaries

- **Security Agent** owns product policy, settings, permissions, and user-visible finding/remediation outcomes.
- **Security Sync** owns finding synchronization, notification event admission, recipient intent materialization, deduplication, and durable state transitions.
- **Security Agent Email Delivery** may revalidate and deliver an existing notification but must not create notification eligibility or copy mutable finding data into Worker request.
- **Shared Security Notification Policy** defines common parsing and pure eligibility behavior; it does not perform persistence or recipient lookup.
- Cross-context dispatch sends only stable notification ID from **Security Sync** to authenticated **Security Agent Email Delivery** boundary.

## Decision References

- `.specs/security-agent.md` defines Security Agent Auto Remediation and notification guarantees.
- `.plans/security-agent-notifications.md` records notification implementation and rollout design.
