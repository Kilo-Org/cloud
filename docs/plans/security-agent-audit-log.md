# Security Agent Audit Log — SOC2 Compliance Plan

## Background

For users of the Security Agent feature, an important promise is to provide an audit log for SOC2 compliance. This document proposes how an audit log feature could look and work to help users with their SOC2 compliance efforts.

## Current State

### Data Model
- The Security Agent stores findings in a `security_findings` table (30+ columns) with an `agent_configs` table for settings.
- There are two parallel tRPC routers (personal + org) with ~16 procedures each.

### Existing Analytics
- **8 PostHog analytics events** exist — but these are third-party analytics, *not* a proper audit trail.
- Current events tracked:
  - `security_finding_analyze` — user triggers AI analysis
  - `security_finding_status_change` — status transitions (e.g., open → triaged)
  - `security_finding_dismiss` — finding dismissed
  - `security_finding_reopen` — finding reopened
  - `security_agent_config_update` — settings changed
  - `security_finding_create_task` — task created from finding
  - `security_finding_viewed` — finding detail viewed
  - `security_finding_list_viewed` — list page viewed

### Gaps
- No dedicated audit log table — actions are only tracked in PostHog.
- No immutable, tamper-evident record of who did what and when.
- No export/report capability for auditors.
- Status history is not stored in the database (only the current status is persisted).

---

## Proposal

### 1. New `security_audit_log` Table

Create a dedicated, append-only audit log table:

```sql
CREATE TABLE security_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  actor_id      UUID NOT NULL REFERENCES users(id),
  actor_email   TEXT NOT NULL,
  action        TEXT NOT NULL,        -- e.g., 'finding.status_change', 'config.update'
  resource_type TEXT NOT NULL,        -- e.g., 'security_finding', 'agent_config'
  resource_id   UUID NOT NULL,
  before_state  JSONB,               -- snapshot before change (null for creates)
  after_state   JSONB,               -- snapshot after change
  metadata      JSONB,               -- additional context (IP, user agent, etc.)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for common query patterns
CREATE INDEX idx_audit_log_org_created ON security_audit_log (org_id, created_at DESC);
CREATE INDEX idx_audit_log_resource ON security_audit_log (resource_type, resource_id);
CREATE INDEX idx_audit_log_actor ON security_audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON security_audit_log (action, created_at DESC);
```

**Key properties:**
- **Append-only** — no UPDATE or DELETE operations permitted (enforce via DB policy or application logic).
- **Immutable** — `before_state` / `after_state` JSONB snapshots capture the full diff.
- **Denormalized actor_email** — ensures the log is readable even if the user is later removed.

### 2. Actions to Log

| Action | Resource Type | Trigger |
|---|---|---|
| `finding.created` | security_finding | New finding ingested |
| `finding.status_change` | security_finding | Status transition (open → triaged → resolved, etc.) |
| `finding.dismissed` | security_finding | Finding dismissed with reason |
| `finding.reopened` | security_finding | Finding reopened |
| `finding.analyzed` | security_finding | AI analysis triggered |
| `finding.task_created` | security_finding | Task/ticket created from finding |
| `finding.assigned` | security_finding | Finding assigned to a user |
| `config.created` | agent_config | Security agent enabled/configured |
| `config.updated` | agent_config | Settings changed (severity thresholds, auto-analyze, etc.) |
| `config.deleted` | agent_config | Security agent config removed |
| `audit_log.exported` | audit_log | Audit log exported (self-referential for completeness) |

### 3. Implementation Approach

#### a) Logging Service
Create a shared `auditLog.write()` service function that:
- Accepts the action, actor, resource, and state snapshots.
- Inserts into `security_audit_log`.
- Continues to fire PostHog events in parallel (existing analytics are not replaced).

#### b) Integration Points
- Add `auditLog.write()` calls into each existing tRPC mutation (status change, dismiss, reopen, config update, etc.).
- For finding ingestion (automated), use a system actor ID.

#### c) Query & Export API
New tRPC procedures:
- `securityAuditLog.list` — paginated, filterable (by action, actor, resource, date range).
- `securityAuditLog.export` — CSV/JSON download for auditors.

#### d) UI
- New "Audit Log" tab within the Security Agent section.
- Table view with columns: Timestamp, Actor, Action, Resource, Details.
- Filters: date range, actor, action type, resource.
- Export button (CSV/JSON).

### 4. SOC2 Mapping

| SOC2 Trust Criteria | How Audit Log Addresses It |
|---|---|
| **CC6.1** — Logical access controls | Logs who accessed/changed findings and configs |
| **CC7.2** — Monitoring for anomalies | Provides a trail of all security finding lifecycle events |
| **CC7.3** — Evaluating security events | Records analysis actions and status transitions |
| **CC8.1** — Change management | Captures config changes with before/after state |
| **CC4.1** — Monitoring activities | Enables ongoing review of security operations |

### 5. Future Enhancements
- **Retention policies** — configurable per-org (e.g., 1 year, 3 years).
- **Tamper evidence** — hash chaining (each row includes a hash of the previous row) for cryptographic integrity.
- **Webhook/SIEM integration** — stream audit events to external systems (Splunk, Datadog, etc.).
- **Role-based access** — restrict audit log viewing to org admins / compliance roles.

---

## Summary

The core work is:
1. Add the `security_audit_log` table (migration).
2. Build the `auditLog.write()` service and integrate into existing mutations.
3. Add list/export API endpoints.
4. Build the audit log UI tab.

This gives users an immutable, queryable, exportable record of all security-related actions — directly addressing SOC2 audit requirements.
