# Security Agent Audit Log — SOC2 Compliance Plan

## Background

For users of the Security Agent feature, an important promise is to provide an audit log for SOC2 compliance. This document proposes how an audit log feature could look and work to help users with their SOC2 compliance efforts.

## Current State

### Data Model

- The Security Agent stores findings in a `security_findings` table (38 columns, `src/db/schema.ts:2311–2414`) with statuses: `open`, `fixed`, `ignored` (defined in `src/lib/security-agent/core/types.ts:30–34`).
- Agent settings use the shared `agent_configs` table (`src/db/schema.ts:1628–1694`) filtered by `agent_type = 'security_scan'`.
- Two parallel tRPC routers (personal + org) with 18 procedures each:
  - `src/routers/security-agent-router.ts` (personal)
  - `src/routers/organizations/organization-security-agent-router.ts` (org)

### Existing Analytics

- **8 PostHog analytics events** exist (defined in `src/lib/security-agent/posthog-tracking.ts`) — these are third-party analytics, _not_ a proper audit trail:
  - `security_agent_enabled` — agent enabled/disabled
  - `security_agent_config_saved` — config saved
  - `security_agent_sync` — manual single-repo or all-repo sync
  - `security_agent_analysis_started` — Tier 1 triage begins
  - `security_agent_analysis_completed` — analysis finishes (triage-only or full sandbox)
  - `security_agent_finding_dismissed` — manual finding dismissal
  - `security_agent_auto_dismiss` — auto-dismiss (single or bulk)
  - `security_agent_full_sync` — system cron full-sync job

### Existing Audit Log Infrastructure

Two audit log tables already exist in the codebase — neither covers security agent actions:

- **`organization_audit_logs`** (`src/db/schema.ts:1192`) — org-level actions (settings, invites, SSO, etc.) with a service at `src/lib/organizations/organization-audit-logs.ts` and router at `src/routers/organizations/organization-audit-log-router.ts`.
- **`kilo_pass_audit_log`** (`src/db/schema.ts:321`) — Stripe/billing events.

The `organization_audit_logs` pattern is the closest precedent: nullable `actor_id` (text), `actor_email`, `actor_name`, `organization_id` (uuid), `message` (text), cursor-based pagination, and GDPR-compliant anonymization in `softDeleteUser`.

### Gaps

- No audit log coverage for security agent actions — actions are only tracked in PostHog.
- No immutable, tamper-evident record of who did what and when.
- No export/report capability for auditors.
- Status history is not stored in the database (only the current status is persisted).

---

## Proposal

### 1. New `security_audit_log` Table

Add to `src/db/schema.ts` using drizzle-orm, following the `organization_audit_logs` pattern for actor fields and the `security_findings`/`agent_configs` XOR ownership pattern:

```ts
export const security_audit_log = pgTable(
  'security_audit_log',
  {
    id: idPrimaryKeyColumn,
    // Ownership follows the same XOR pattern as security_findings / agent_configs:
    // exactly one of owned_by_organization_id or owned_by_user_id must be set.
    owned_by_organization_id: uuid().references(() => organizations.id, { onDelete: 'cascade' }),
    owned_by_user_id: text().references(() => kilocode_users.id, { onDelete: 'cascade' }),
    // actor_id is text to match kilocode_users.id; nullable for system-initiated actions
    actor_id: text(),
    actor_email: text(),
    actor_name: text(),
    action: text().$type<SecurityAuditLogAction>().notNull(),
    resource_type: text().notNull(), // 'security_finding' | 'agent_config' | 'audit_log'
    resource_id: text().notNull(), // text to accommodate both uuid and composite IDs
    before_state: jsonb().$type<Record<string, unknown>>(),
    after_state: jsonb().$type<Record<string, unknown>>(),
    metadata: jsonb().$type<Record<string, unknown>>(),
    created_at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
  },
  table => [
    // XOR ownership constraint (matches security_findings pattern)
    check(
      'security_audit_log_owner_check',
      sql`(${table.owned_by_user_id} IS NOT NULL AND ${table.owned_by_organization_id} IS NULL) OR (${table.owned_by_user_id} IS NULL AND ${table.owned_by_organization_id} IS NOT NULL)`
    ),
    enumCheck('security_audit_log_action_check', table.action, SecurityAuditLogAction),
    index('IDX_security_audit_log_org_created').on(
      table.owned_by_organization_id,
      table.created_at
    ),
    index('IDX_security_audit_log_user_created').on(table.owned_by_user_id, table.created_at),
    index('IDX_security_audit_log_resource').on(table.resource_type, table.resource_id),
    index('IDX_security_audit_log_actor').on(table.actor_id, table.created_at),
    index('IDX_security_audit_log_action').on(table.action, table.created_at),
  ]
);
```

The `SecurityAuditLogAction` values should be defined as a TypeScript enum (following the `kilo_pass_audit_log` pattern) and registered in `SCHEMA_CHECK_ENUMS` so the schema snapshot test tracks value changes.

**Design decisions:**

- **XOR ownership** — matches the `security_findings` and `agent_configs` ownership model. The personal router operates without an organization (`SecurityReviewOwner = { userId }` — see `src/lib/security-agent/core/types.ts:323–325`), so `owned_by_organization_id` must be nullable. An XOR check constraint ensures exactly one owner is set.
- **`onDelete: 'cascade'`** — if an org or user is deleted, their audit log entries are also removed (matching `security_findings` FK behavior). For orgs that need SOC2 retention, org deletion itself should be gated — not the audit log FK.
- **No FK on `actor_id`** — matches `organization_audit_logs` pattern; avoids coupling to user lifecycle and simplifies GDPR handling (nullable, anonymized on user deletion rather than cascaded).
- **`actor_id` is `text`** — matches `kilocode_users.id` type.
- **`resource_id` is `text`** — `security_findings.id` is uuid but represented as text in drizzle; keeps flexibility.
- **Nullable actor fields** — system-initiated actions (sync cron, auto-dismiss) have no human actor.
- **`enumCheck` on `action`** — provides database-level enforcement of valid action values, following the `kilo_pass_audit_log` pattern rather than the looser `organization_audit_logs` pattern (which has no DB-level check).
- **Append-only** — enforced at the application layer (no update/delete queries). A PostgreSQL trigger to block UPDATE/DELETE can be added as a defense-in-depth measure.

### 2. Actions to Log

Action names follow a dot-separated convention loosely modeled on `organization_audit_logs` (which mostly uses `organization.entity.verb`, though not perfectly consistently). For security audit actions we use a consistent 3-segment `security.entity.verb` pattern:

| Action                                | Resource Type    | Trigger                                                    |
| ------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `security.finding.created`            | security_finding | New finding ingested during sync                           |
| `security.finding.status_change`      | security_finding | Status transition (`open` → `fixed` or `open` → `ignored`) |
| `security.finding.dismissed`          | security_finding | Finding dismissed with reason (manual)                     |
| `security.finding.auto_dismissed`     | security_finding | Finding auto-dismissed by triage/sandbox                   |
| `security.finding.analysis_started`   | security_finding | AI analysis triggered                                      |
| `security.finding.analysis_completed` | security_finding | AI analysis finished                                       |
| `security.finding.deleted`            | security_finding | Findings deleted by repository                             |
| `security.config.enabled`             | agent_config     | Security agent enabled                                     |
| `security.config.disabled`            | agent_config     | Security agent disabled                                    |
| `security.config.updated`             | agent_config     | Settings changed (thresholds, model, auto-dismiss, etc.)   |
| `security.sync.triggered`             | agent_config     | Manual sync triggered                                      |
| `security.sync.completed`             | agent_config     | Sync completed (manual or cron)                            |
| `security.audit_log.exported`         | audit_log        | Audit log exported (self-referential for completeness)     |

**Notes:**

- Every action maps to an existing mutation or service call in the codebase.
- `before_state`/`after_state` capture the relevant fields — not the entire row — to keep payload sizes manageable.
- System-initiated actions (auto-dismiss, cron sync) use `actor_id: null` with `metadata: { source: 'system' }`.

### 3. Implementation Approach

#### a) Logging Service

Create `src/lib/security-agent/services/audit-log-service.ts`, following the `createAuditLog` pattern from `src/lib/organizations/organization-audit-logs.ts`:

```ts
export async function createSecurityAuditLog({
  owner,
  actor_id,
  actor_email,
  actor_name,
  action,
  resource_type,
  resource_id,
  before_state,
  after_state,
  metadata,
  tx,
}: {
  owner: SecurityReviewOwner; // { organizationId } | { userId }
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
  action: SecurityAuditLogAction;
  resource_type: string;
  resource_id: string;
  before_state?: Record<string, unknown>;
  after_state?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  tx?: DrizzleTransaction;
}) {
  const owned_by_organization_id = 'organizationId' in owner ? owner.organizationId : null;
  const owned_by_user_id = 'userId' in owner ? owner.userId : null;
  // ... insert into security_audit_log
}
```

- Accepts `SecurityReviewOwner` (the existing discriminated union from `src/lib/security-agent/core/types.ts:323–325`) to match how both routers already resolve ownership.
- Accepts an optional `tx` (DrizzleTransaction) so audit writes can participate in the same transaction as the mutation they record.
- Existing PostHog tracking calls are **not replaced** — both fire in parallel.

#### b) Integration Points

Add `createSecurityAuditLog()` calls into:

- **Router mutations**: `dismissFinding`, `saveConfig`, `setEnabled`, `triggerSync`, `deleteFindingsByRepository`, `startAnalysis`, `autoDismissEligible` — in both personal and org routers. Each router already constructs a `SecurityReviewOwner`, which is passed directly to the audit log service.
- **Service functions**: `updateSecurityFindingStatus` (`src/lib/security-agent/db/security-findings.ts:494`), auto-dismiss service (`src/lib/security-agent/services/auto-dismiss-service.ts`), sync service (`src/lib/security-agent/services/sync-service.ts`), analysis callback route (`src/app/api/internal/security-analysis-callback/[findingId]/route.ts`).
- **System actor**: For automated actions (cron sync, auto-dismiss), pass `actor_id: null` with `metadata: { source: 'system', trigger: 'cron' | 'auto_dismiss_policy' }`.

#### c) GDPR Compliance

Update `softDeleteUser` in `src/lib/user.ts` to handle `security_audit_log`:

```ts
// In softDeleteUser, add:

// 1. Rows where the deleted user is the OWNER are already cascade-deleted
//    via the owned_by_user_id FK (onDelete: 'cascade'). No action needed.

// 2. Rows where the deleted user is the ACTOR (but another org/user owns the row)
//    must have PII anonymized — matching the organization_audit_logs pattern:
await tx
  .update(security_audit_log)
  .set({ actor_email: null, actor_name: null })
  .where(eq(security_audit_log.actor_id, userId));
```

Add a corresponding test in `src/lib/user.test.ts`.

**Rationale:** Org-owned audit rows where the deleted user was the actor are retained for SOC2 continuity, but PII is stripped. The `actor_id` remains as a pseudonymous identifier — the user record it references will already be anonymized. User-owned audit rows are fully cascade-deleted since there is no org requiring SOC2 retention. This mirrors how `organization_audit_logs` handles GDPR today.

#### d) Query & Export API

New tRPC routers for both ownership contexts:

**Org context:** `src/routers/organizations/organization-security-audit-log-router.ts`, modeled on `organization-audit-log-router.ts` (which has `list`, `getActionTypes`, `getSummary`):

- **`list`** — cursor-based pagination (timestamp cursors, `PAGE_SIZE = 100`), filterable by `action`, `actorEmail`, `resourceType`, `resourceId`, `startTime`/`endTime`, fuzzy search on `metadata`.
- **`getActionTypes`** — returns the `SecurityAuditLogAction` enum values for filter dropdowns.
- **`getSummary`** — count + min/max timestamps for the current org.
- **Auth**: `organizationOwnerProcedure` (org owners only, matching existing audit log access control).

**Personal context:** `src/routers/security-audit-log-router.ts` — same endpoints scoped to the current user's `owned_by_user_id`.

**Export (net-new, no existing precedent):**

- **`export`** — CSV/JSON download for auditors. This does not exist in the current `organization-audit-log-router.ts` and is new functionality. Logs a self-referential `security.audit_log.exported` action. Implementation should stream rows to avoid loading entire audit history into memory.

#### e) UI

- New "Audit Log" tab within the Security Agent section.
- Table view with columns: Timestamp, Actor, Action, Resource, Details.
- Filters: date range, actor, action type, resource type.
- Export button (CSV/JSON).
- Follow the existing audit log UI patterns from the organization audit log page.

### 4. SOC2 Mapping

| SOC2 Trust Criteria                    | How Audit Log Addresses It                                |
| -------------------------------------- | --------------------------------------------------------- |
| **CC6.1** — Logical access controls    | Logs who accessed/changed findings and configs            |
| **CC7.2** — Monitoring for anomalies   | Provides a trail of all security finding lifecycle events |
| **CC7.3** — Evaluating security events | Records analysis actions and status transitions           |
| **CC8.1** — Change management          | Captures config changes with before/after state           |
| **CC4.1** — Monitoring activities      | Enables ongoing review of security operations             |

### 5. Future Enhancements

- **Retention policies** — configurable per-org (e.g., 1 year, 3 years).
- **Tamper evidence** — hash chaining (each row includes a hash of the previous row) for cryptographic integrity.
- **Webhook/SIEM integration** — stream audit events to external systems (Splunk, Datadog, etc.).
- **Role-based access** — restrict audit log viewing to specific org roles beyond owner.
- **Task creation from findings** — if/when this feature is built, add a `security.finding.task_created` action.
- **Finding assignment** — if/when this feature is built, add a `security.finding.assigned` action.

---

## Summary

The core work is:

1. Define `SecurityAuditLogAction` enum, add `security_audit_log` table to `src/db/schema.ts` with XOR ownership and `enumCheck`, register in `SCHEMA_CHECK_ENUMS`, and generate a drizzle-kit migration.
2. Build `createSecurityAuditLog()` in `src/lib/security-agent/services/audit-log-service.ts` accepting `SecurityReviewOwner`, and integrate into existing mutations and services in both personal and org routers.
3. Update `softDeleteUser` in `src/lib/user.ts` for GDPR compliance (anonymize actor PII on org-owned rows; user-owned rows cascade-delete via FK). Add test in `user.test.ts`.
4. Add list/summary tRPC endpoints in both personal and org audit log routers (modeled on existing `organization-audit-log-router.ts`). Add export endpoint (net-new — no existing precedent to follow).
5. Build the audit log UI tab for both personal and org contexts.

This gives users an immutable, queryable, exportable record of all security-related actions — directly addressing SOC2 audit requirements while aligning with existing codebase patterns and GDPR obligations.
