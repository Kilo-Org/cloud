import { getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  agent_configs,
  security_findings,
  security_finding_notifications,
} from '@kilocode/db/schema';
import {
  SecurityAuditLogAction,
  SecurityFindingAuditSourceContext,
} from '@kilocode/db/schema-types';
import {
  SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
  deriveSecurityFindingAuditEventKey,
  insertSecurityFindingAuditEvent,
  type SecurityFindingAuditEventFinding,
  type SecurityFindingAuditOwner,
} from '@kilocode/worker-utils/security-finding-audit';
import {
  SecurityNotificationPolicySchema,
  calculateSlaWarningBoundary,
  getEligibleSlaNotificationKind,
  meetsSecurityNotificationSeverityMinimum,
  type SecurityNotificationPolicy,
} from '@kilocode/worker-utils/security-notification-policy';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  isOrganizationNotificationOwner,
  resolveNotificationRecipientUserIds,
  type SecurityNotificationOwner,
} from './recipients';

const STUCK_CLAIM_RECOVERY_MINUTES = 5;
const MAX_SLA_MATERIALIZATION_PER_TICK = 1000;
const MAX_DISPATCH_PER_TICK = 100;
const DISPATCH_CONCURRENCY = 10;
const DISPATCH_TIMEOUT_MS = 10_000;
const INVALID_POLICY_RETRY_DELAY_MINUTES = 60;
const STAGED_RECOVERY_LIMIT = 500;
const INELIGIBLE_EVALUATION_LIMIT = 5000;
const PENDING_SELECTION_LIMIT = 250;
const MAX_ATTEMPTS = 4;

type SecretBinding = { get(): Promise<string> };

export type SecurityNotificationSweepEnv = {
  HYPERDRIVE?: { connectionString: string };
  BACKEND_API_URL?: string;
  INTERNAL_API_SECRET?: SecretBinding;
  SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED?: string;
  SECURITY_NOTIFICATION_DISPATCH_ENABLED?: string;
};

type OwnerKey = `org:${string}` | `user:${string}`;

type OwnerConfigState =
  | { state: 'enabled'; owner: SecurityNotificationOwner; policy: SecurityNotificationPolicy }
  | { state: 'disabled'; owner: SecurityNotificationOwner }
  | { state: 'malformed'; owner: SecurityNotificationOwner };

type NotificationFindingRow = {
  notificationId: string;
  findingId: string;
  recipientUserId: string;
  kind: 'new_finding' | 'sla_warning' | 'sla_breach';
  status: 'staged' | 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attemptCount: number;
  ownedByOrganizationId: string | null;
  ownedByUserId: string | null;
  repoFullName: string;
  findingStatus: string;
  severity: string;
  slaDueAt: string | null;
  ignoredReason: string | null;
};

const dbTimestampSchema = z.union([z.string(), z.date()]);
const nullableDbTimestampSchema = dbTimestampSchema.nullable();
const securityFindingStatusSchema = z.enum(['open', 'fixed', 'ignored']);
const securitySeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);
const supersededSecurityFindingResultSchema = z.object({
  findingId: z.string().uuid(),
  previousStatus: securityFindingStatusSchema.nullable(),
  previousSeverity: securitySeveritySchema.nullable(),
  effectiveStatus: securityFindingStatusSchema,
  effectiveSeverity: securitySeveritySchema,
  findingCreatedAt: dbTimestampSchema,
  ownedByUserId: z.string().nullable(),
  ownedByOrganizationId: z.string().uuid().nullable(),
  source: z.string(),
  sourceId: z.string(),
  repoFullName: z.string(),
  title: z.string(),
  packageName: z.string(),
  packageEcosystem: z.string(),
  manifestPath: z.string().nullable(),
  patchedVersion: z.string().nullable(),
  ghsaId: z.string().nullable(),
  cveId: z.string().nullable(),
  cweIds: z.array(z.string()).nullable(),
  cvssScore: z.union([z.string(), z.number()]).nullable(),
  dependabotHtmlUrl: z.string().nullable(),
  firstDetectedAt: dbTimestampSchema,
  fixedAt: nullableDbTimestampSchema,
  slaDueAt: nullableDbTimestampSchema,
  canonicalFindingId: z.string().uuid(),
});
type SupersededSecurityFindingResult = z.infer<typeof supersededSecurityFindingResultSchema>;

type KindCount = {
  kind: 'new_finding' | 'sla_warning' | 'sla_breach';
  status: 'staged' | 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  count: number;
};

type SweepResult = {
  recovered: number;
  stagedRecovered: number;
  cancelled: number;
  materialized: number;
  reactivated: number;
  processed: number;
  sent: number;
  retried: number;
  failed: number;
  deferred: number;
  dispatchCapReached: boolean;
  materializationCapReached: boolean;
  countsByKindAndStatus: KindCount[];
  oldestStagedAgeMsByKind: Partial<Record<'new_finding' | 'sla_warning' | 'sla_breach', number>>;
  oldestPendingAgeMsByKind: Partial<Record<'new_finding' | 'sla_warning' | 'sla_breach', number>>;
  oldestEligibleSlaCandidateAgeMsByKind: Partial<Record<'sla_warning' | 'sla_breach', number>>;
  durationMs: number;
};

const EndpointResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('sent') }),
  z.object({
    outcome: z.literal('cancelled'),
    reason: z.enum([
      'not_sending',
      'finding_ineligible',
      'security_agent_disabled',
      'recipient_not_authorized',
      'notification_kind_ineligible',
    ]),
  }),
  z.object({
    outcome: z.literal('deferred'),
    reason: z.literal('invalid_notification_config'),
  }),
  z.object({
    outcome: z.literal('retryable_failure'),
    reason: z.enum(['provider_unavailable', 'endpoint_timeout', 'unexpected_response']),
  }),
  z.object({
    outcome: z.literal('permanent_failure'),
    reason: z.enum(['no_usable_email', 'email_verification_rejected']),
  }),
]);

type EndpointResponse = z.infer<typeof EndpointResponseSchema>;

function ownerKey(owner: SecurityNotificationOwner): OwnerKey {
  return isOrganizationNotificationOwner(owner)
    ? `org:${owner.organizationId}`
    : `user:${owner.userId}`;
}

function rowOwner(row: {
  ownedByOrganizationId: string | null;
  ownedByUserId: string | null;
}): SecurityNotificationOwner | null {
  if (row.ownedByOrganizationId) return { organizationId: row.ownedByOrganizationId };
  if (row.ownedByUserId) return { userId: row.ownedByUserId };
  return null;
}

function ownerPredicate(owner: SecurityNotificationOwner) {
  return isOrganizationNotificationOwner(owner)
    ? eq(security_findings.owned_by_organization_id, owner.organizationId)
    : eq(security_findings.owned_by_user_id, owner.userId);
}

function ownerPartitionColumn(owner: SecurityNotificationOwner) {
  return isOrganizationNotificationOwner(owner)
    ? security_findings.owned_by_organization_id
    : security_findings.owned_by_user_id;
}

function parseRolloutFlag(value: string | undefined, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false' || value === undefined) return false;
  console.warn('[security-notifications] malformed rollout flag; treating as disabled', { name });
  return false;
}

function isSuperseded(row: { ignoredReason: string | null }): boolean {
  return (row.ignoredReason ?? '').startsWith('superseded:');
}

function getAgeMs(now: Date, value: string | Date | null): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return Math.max(0, now.getTime() - date.getTime());
}

function recordOldestAge<K extends string>(
  target: Partial<Record<K, number>>,
  key: K,
  ageMs: number | null
): void {
  if (ageMs === null) return;
  target[key] = Math.max(target[key] ?? 0, ageMs);
}

async function loadBacklogObservability(
  db: Pick<WorkerDb, 'execute'>,
  now: Date
): Promise<
  Pick<
    SweepResult,
    'countsByKindAndStatus' | 'oldestStagedAgeMsByKind' | 'oldestPendingAgeMsByKind'
  >
> {
  const result = await db.execute<{
    kind: 'new_finding' | 'sla_warning' | 'sla_breach';
    status: 'staged' | 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
    count: number;
    oldestCreatedAt: string | Date | null;
  }>(sql`
    SELECT
      kind,
      status,
      count(*)::int AS count,
      min(created_at) AS "oldestCreatedAt"
    FROM security_finding_notifications
    GROUP BY kind, status
    ORDER BY kind, status
  `);

  const oldestStagedAgeMsByKind: SweepResult['oldestStagedAgeMsByKind'] = {};
  const oldestPendingAgeMsByKind: SweepResult['oldestPendingAgeMsByKind'] = {};
  const countsByKindAndStatus = result.rows.map(row => {
    const count = Number(row.count);
    const ageMs = getAgeMs(now, row.oldestCreatedAt);
    if (row.status === 'staged') {
      recordOldestAge(oldestStagedAgeMsByKind, row.kind, ageMs);
    }
    if (row.status === 'pending') {
      recordOldestAge(oldestPendingAgeMsByKind, row.kind, ageMs);
    }
    return { kind: row.kind, status: row.status, count };
  });

  return { countsByKindAndStatus, oldestStagedAgeMsByKind, oldestPendingAgeMsByKind };
}

async function loadOwnerConfigStates(db: WorkerDb): Promise<Map<OwnerKey, OwnerConfigState>> {
  const rows = await db
    .select({
      ownedByOrganizationId: agent_configs.owned_by_organization_id,
      ownedByUserId: agent_configs.owned_by_user_id,
      isEnabled: agent_configs.is_enabled,
      config: agent_configs.config,
    })
    .from(agent_configs)
    .where(
      and(eq(agent_configs.agent_type, 'security_scan'), eq(agent_configs.platform, 'github'))
    );

  const states = new Map<OwnerKey, OwnerConfigState>();
  for (const row of rows) {
    const owner = rowOwner(row);
    if (!owner) continue;
    const key = ownerKey(owner);
    if (!row.isEnabled) {
      states.set(key, { state: 'disabled', owner });
      continue;
    }
    const parsed = SecurityNotificationPolicySchema.safeParse(row.config ?? {});
    if (!parsed.success) {
      console.warn('[security-notifications] malformed owner policy', {
        ownerType: isOrganizationNotificationOwner(owner) ? 'org' : 'user',
        error: parsed.error.message,
      });
      states.set(key, { state: 'malformed', owner });
      continue;
    }
    states.set(key, { state: 'enabled', owner, policy: parsed.data });
  }
  return states;
}

async function resolveRecipientsForEnabledOwners(
  db: WorkerDb,
  states: Map<OwnerKey, OwnerConfigState>
): Promise<Map<OwnerKey, Set<string>>> {
  const recipients = new Map<OwnerKey, Set<string>>();
  for (const [key, state] of states) {
    if (state.state !== 'enabled') continue;
    recipients.set(key, new Set(await resolveNotificationRecipientUserIds(db, state.owner)));
  }
  return recipients;
}

function recipientIsAuthorized(
  row: NotificationFindingRow,
  recipients: Map<OwnerKey, Set<string>>
) {
  const owner = rowOwner(row);
  if (!owner) return false;
  return recipients.get(ownerKey(owner))?.has(row.recipientUserId) ?? false;
}

function notificationStillEligible(
  row: NotificationFindingRow,
  policy: SecurityNotificationPolicy,
  recipients: Map<OwnerKey, Set<string>>,
  now: Date
): boolean {
  if (!recipientIsAuthorized(row, recipients)) return false;
  if (row.findingStatus !== 'open' || isSuperseded(row)) return false;

  if (row.kind === 'new_finding') {
    return (
      policy.new_finding_notifications_enabled &&
      meetsSecurityNotificationSeverityMinimum(
        row.severity,
        policy.new_finding_notification_min_severity
      )
    );
  }

  const eligibleKind = getEligibleSlaNotificationKind({
    status: row.findingStatus,
    isAgentEnabled: true,
    slaEnabled: policy.sla_enabled,
    slaNotificationsEnabled: policy.sla_notifications_enabled,
    severity: row.severity,
    minimumSeverity: policy.sla_notification_min_severity,
    slaDueAt: row.slaDueAt,
    warningDays: policy.sla_notification_warning_days,
    now,
    isSuperseded: isSuperseded(row),
  });

  return eligibleKind === row.kind;
}

async function recoverStuckClaims(db: WorkerDb): Promise<number> {
  const rows = await db
    .update(security_finding_notifications)
    .set({ status: 'pending', claimed_at: null, updated_at: sql`now()` })
    .where(
      and(
        eq(security_finding_notifications.status, 'sending'),
        sql`${security_finding_notifications.claimed_at} < now() - (${STUCK_CLAIM_RECOVERY_MINUTES} * interval '1 minute')`
      )
    )
    .returning({ id: security_finding_notifications.id });
  return rows.length;
}

async function recoverStagedRows(
  db: WorkerDb,
  states: Map<OwnerKey, OwnerConfigState>,
  recipients: Map<OwnerKey, Set<string>>,
  now: Date
): Promise<{ stagedRecovered: number; cancelled: number }> {
  const rows = await selectNotificationRows(db, ['staged'], STAGED_RECOVERY_LIMIT);
  let stagedRecovered = 0;
  let cancelled = 0;

  await canonicalizeStagedOwnerRepos(db, rows, states);

  for (const row of rows) {
    const owner = rowOwner(row);
    if (!owner) continue;
    const state = states.get(ownerKey(owner));
    if (!state) {
      cancelled += await cancelNotification(db, row.notificationId, 'security_agent_disabled');
      continue;
    }
    if (state.state === 'malformed') continue;
    if (state.state === 'disabled') {
      cancelled += await cancelNotification(db, row.notificationId, 'security_agent_disabled');
      continue;
    }
    const nextStatus = notificationStillEligible(row, state.policy, recipients, now)
      ? 'pending'
      : 'cancelled';
    const updated = await db
      .update(security_finding_notifications)
      .set({ status: nextStatus, updated_at: sql`now()` })
      .where(
        and(
          eq(security_finding_notifications.id, row.notificationId),
          eq(security_finding_notifications.status, 'staged')
        )
      )
      .returning({ id: security_finding_notifications.id });
    if (updated.length > 0) {
      if (nextStatus === 'pending') stagedRecovered += 1;
      else cancelled += 1;
    }
  }
  return { stagedRecovered, cancelled };
}

async function canonicalizeStagedOwnerRepos(
  db: Pick<WorkerDb, 'transaction'>,
  rows: NotificationFindingRow[],
  states: Map<OwnerKey, OwnerConfigState>
): Promise<void> {
  const seen = new Set<string>();
  for (const row of rows) {
    const owner = rowOwner(row);
    if (!owner) continue;

    const key = ownerKey(owner);
    const state = states.get(key);
    if (state?.state !== 'enabled') continue;

    const canonicalizationKey = `${key}:${row.repoFullName}`;
    if (seen.has(canonicalizationKey)) continue;
    seen.add(canonicalizationKey);

    await supersedeDuplicateFindings(db, row.repoFullName, owner);
  }
}

async function supersedeDuplicateFindings(
  db: Pick<WorkerDb, 'transaction'>,
  repoFullName: string,
  owner: SecurityNotificationOwner
): Promise<void> {
  const partitionColumn = ownerPartitionColumn(owner);
  await db.transaction(async tx => {
    const result = await tx.execute<Record<string, unknown>>(sql`
      WITH ranked AS (
        SELECT
          ${security_findings.id} AS id,
          ${security_findings.status} AS previous_status,
          ${security_findings.severity} AS previous_severity,
          ROW_NUMBER() OVER (
            PARTITION BY ${partitionColumn},
                         ${security_findings.repo_full_name},
                         ${security_findings.source},
                         ${security_findings.ghsa_id},
                         ${security_findings.package_name},
                         ${security_findings.manifest_path}
            ORDER BY CASE
              WHEN ${security_findings.source_id} ~ '^[0-9]+$' THEN ${security_findings.source_id}::int
              ELSE 0
            END DESC
          ) AS rn,
          FIRST_VALUE(${security_findings.id}) OVER (
            PARTITION BY ${partitionColumn},
                         ${security_findings.repo_full_name},
                         ${security_findings.source},
                         ${security_findings.ghsa_id},
                         ${security_findings.package_name},
                         ${security_findings.manifest_path}
            ORDER BY CASE
              WHEN ${security_findings.source_id} ~ '^[0-9]+$' THEN ${security_findings.source_id}::int
              ELSE 0
            END DESC
          ) AS canonical_id
        FROM ${security_findings}
        WHERE ${security_findings.repo_full_name} = ${repoFullName}
          AND ${ownerPredicate(owner)}
          AND ${security_findings.source} = 'dependabot'
          AND ${security_findings.ghsa_id} IS NOT NULL
          AND ${security_findings.status} = 'open'
      ),
      superseded AS (
        UPDATE ${security_findings}
        SET
          ${sql.identifier(security_findings.status.name)} = 'ignored',
          ${sql.identifier(security_findings.ignored_reason.name)} = 'superseded:' || ranked.canonical_id,
          ${sql.identifier(security_findings.ignored_by.name)} = 'system',
          ${sql.identifier(security_findings.updated_at.name)} = now()
        FROM ranked
        WHERE ${security_findings.id} = ranked.id
          AND ranked.rn > 1
        RETURNING
          ${security_findings.id} AS "findingId",
          ranked.previous_status AS "previousStatus",
          ranked.previous_severity AS "previousSeverity",
          ${security_findings.status} AS "effectiveStatus",
          ${security_findings.severity} AS "effectiveSeverity",
          ${security_findings.created_at} AS "findingCreatedAt",
          ${security_findings.owned_by_user_id} AS "ownedByUserId",
          ${security_findings.owned_by_organization_id} AS "ownedByOrganizationId",
          ${security_findings.source} AS "source",
          ${security_findings.source_id} AS "sourceId",
          ${security_findings.repo_full_name} AS "repoFullName",
          ${security_findings.title} AS "title",
          ${security_findings.package_name} AS "packageName",
          ${security_findings.package_ecosystem} AS "packageEcosystem",
          ${security_findings.manifest_path} AS "manifestPath",
          ${security_findings.patched_version} AS "patchedVersion",
          ${security_findings.ghsa_id} AS "ghsaId",
          ${security_findings.cve_id} AS "cveId",
          ${security_findings.cwe_ids} AS "cweIds",
          ${security_findings.cvss_score} AS "cvssScore",
          ${security_findings.dependabot_html_url} AS "dependabotHtmlUrl",
          ${security_findings.first_detected_at} AS "firstDetectedAt",
          ${security_findings.fixed_at} AS "fixedAt",
          ${security_findings.sla_due_at} AS "slaDueAt",
          ranked.canonical_id AS "canonicalFindingId"
      )
      SELECT * FROM superseded
    `);
    const superseded = result.rows.map(row => supersededSecurityFindingResultSchema.parse(row));
    const occurredAt = new Date().toISOString();
    for (const finding of superseded) {
      await insertSecurityFindingAuditEvent(tx, {
        owner: toSecurityFindingAuditOwner(owner),
        finding: toAuditEventFinding(finding),
        actor: SECURITY_FINDING_AUDIT_SYSTEM_ACTOR,
        action: SecurityAuditLogAction.FindingSuperseded,
        occurredAt,
        eventKey: deriveSecurityFindingAuditEventKey([
          ownerAuditKeyPart(owner),
          finding.findingId,
          SecurityAuditLogAction.FindingSuperseded,
          finding.canonicalFindingId,
        ]),
        sourceContext: SecurityFindingAuditSourceContext.SecuritySync,
        snapshotExtras: { canonical_finding_id: finding.canonicalFindingId },
        beforeState: { status: finding.previousStatus ?? 'open' },
        afterState: {
          status: finding.effectiveStatus,
          reason_code: 'superseded',
          canonical_finding_id: finding.canonicalFindingId,
        },
        metadata: {
          repo_full_name: finding.repoFullName,
          source_alert_number: finding.sourceId,
        },
      });
    }
  });
}

function toSecurityFindingAuditOwner(owner: SecurityNotificationOwner): SecurityFindingAuditOwner {
  return isOrganizationNotificationOwner(owner)
    ? { type: 'organization', organizationId: owner.organizationId }
    : { type: 'user', userId: owner.userId };
}

function ownerAuditKeyPart(owner: SecurityNotificationOwner): string {
  return isOrganizationNotificationOwner(owner)
    ? `organization:${owner.organizationId}`
    : `user:${owner.userId}`;
}

function toAuditEventFinding(
  finding: SupersededSecurityFindingResult
): SecurityFindingAuditEventFinding {
  return {
    id: finding.findingId,
    owned_by_user_id: finding.ownedByUserId,
    owned_by_organization_id: finding.ownedByOrganizationId,
    source: finding.source,
    source_id: finding.sourceId,
    repo_full_name: finding.repoFullName,
    title: finding.title,
    severity: finding.effectiveSeverity,
    status: finding.effectiveStatus,
    package_name: finding.packageName,
    package_ecosystem: finding.packageEcosystem,
    manifest_path: finding.manifestPath,
    patched_version: finding.patchedVersion,
    ghsa_id: finding.ghsaId,
    cve_id: finding.cveId,
    cwe_ids: finding.cweIds,
    cvss_score: finding.cvssScore,
    dependabot_html_url: finding.dependabotHtmlUrl,
    first_detected_at: finding.firstDetectedAt,
    fixed_at: finding.fixedAt,
    sla_due_at: finding.slaDueAt,
  };
}

async function selectNotificationRows(
  db: WorkerDb,
  statuses: Array<'staged' | 'pending' | 'sending'>,
  limit: number
): Promise<NotificationFindingRow[]> {
  return db
    .select({
      notificationId: security_finding_notifications.id,
      findingId: security_finding_notifications.finding_id,
      recipientUserId: security_finding_notifications.recipient_user_id,
      kind: security_finding_notifications.kind,
      status: security_finding_notifications.status,
      attemptCount: security_finding_notifications.attempt_count,
      ownedByOrganizationId: security_findings.owned_by_organization_id,
      ownedByUserId: security_findings.owned_by_user_id,
      repoFullName: security_findings.repo_full_name,
      findingStatus: security_findings.status,
      severity: security_findings.severity,
      slaDueAt: security_findings.sla_due_at,
      ignoredReason: security_findings.ignored_reason,
    })
    .from(security_finding_notifications)
    .innerJoin(
      security_findings,
      eq(security_findings.id, security_finding_notifications.finding_id)
    )
    .where(inArray(security_finding_notifications.status, statuses))
    .orderBy(security_finding_notifications.created_at, security_finding_notifications.id)
    .limit(limit);
}

async function cancelIneligibleRows(
  db: WorkerDb,
  states: Map<OwnerKey, OwnerConfigState>,
  recipients: Map<OwnerKey, Set<string>>,
  now: Date
): Promise<number> {
  const rows = await selectNotificationRows(db, ['pending'], INELIGIBLE_EVALUATION_LIMIT);
  let cancelled = 0;
  for (const row of rows) {
    const owner = rowOwner(row);
    if (!owner) {
      cancelled += await cancelNotification(db, row.notificationId, 'finding_ineligible');
      continue;
    }
    const state = states.get(ownerKey(owner));
    if (!state || state.state === 'disabled') {
      cancelled += await cancelNotification(db, row.notificationId, 'security_agent_disabled');
      continue;
    }
    if (state.state === 'malformed') continue;
    if (!notificationStillEligible(row, state.policy, recipients, now)) {
      cancelled += await cancelNotification(db, row.notificationId, 'finding_ineligible');
    }
  }
  return cancelled;
}

async function cancelNotification(
  db: WorkerDb,
  notificationId: string,
  reason: string
): Promise<number> {
  const rows = await db
    .update(security_finding_notifications)
    .set({ status: 'cancelled', claimed_at: null, error_message: reason, updated_at: sql`now()` })
    .where(
      and(
        eq(security_finding_notifications.id, notificationId),
        inArray(security_finding_notifications.status, ['staged', 'pending', 'sending'])
      )
    )
    .returning({ id: security_finding_notifications.id });
  return rows.length;
}

async function materializeSlaNotifications(
  db: WorkerDb,
  states: Map<OwnerKey, OwnerConfigState>,
  recipients: Map<OwnerKey, Set<string>>,
  now: Date
): Promise<{
  materialized: number;
  reactivated: number;
  capReached: boolean;
  oldestEligibleSlaCandidateAgeMsByKind: SweepResult['oldestEligibleSlaCandidateAgeMsByKind'];
}> {
  let materialized = 0;
  let reactivated = 0;
  const oldestEligibleSlaCandidateAgeMsByKind: SweepResult['oldestEligibleSlaCandidateAgeMsByKind'] =
    {};

  for (const [key, state] of states) {
    if (state.state !== 'enabled') continue;
    if (!state.policy.sla_enabled) continue;
    if (!state.policy.sla_notifications_enabled) continue;
    const recipientIds = recipients.get(key);
    if (!recipientIds || recipientIds.size === 0) continue;

    const remaining = MAX_SLA_MATERIALIZATION_PER_TICK - materialized - reactivated;
    if (remaining <= 0) {
      return { materialized, reactivated, capReached: true, oldestEligibleSlaCandidateAgeMsByKind };
    }

    const candidates = await db
      .select({
        findingId: security_findings.id,
        status: security_findings.status,
        severity: security_findings.severity,
        slaDueAt: security_findings.sla_due_at,
        ignoredReason: security_findings.ignored_reason,
      })
      .from(security_findings)
      .where(
        and(
          ownerPredicate(state.owner),
          eq(security_findings.status, 'open'),
          isNotNull(security_findings.sla_due_at),
          sql`COALESCE(${security_findings.ignored_reason}, '') NOT LIKE 'superseded:%'`,
          sql`${security_findings.sla_due_at} <= (${now.toISOString()}::timestamptz + (${state.policy.sla_notification_warning_days} * interval '1 day'))`
        )
      )
      .orderBy(
        sql`CASE WHEN ${security_findings.sla_due_at} <= ${now.toISOString()}::timestamptz THEN 0 ELSE 1 END`,
        security_findings.sla_due_at,
        security_findings.id
      )
      .limit(remaining);

    for (const candidate of candidates) {
      const kind = getEligibleSlaNotificationKind({
        status: candidate.status,
        isAgentEnabled: true,
        slaEnabled: state.policy.sla_enabled,
        slaNotificationsEnabled: state.policy.sla_notifications_enabled,
        severity: candidate.severity,
        minimumSeverity: state.policy.sla_notification_min_severity,
        slaDueAt: candidate.slaDueAt,
        warningDays: state.policy.sla_notification_warning_days,
        now,
        isSuperseded: (candidate.ignoredReason ?? '').startsWith('superseded:'),
      });
      if (!kind) continue;
      if (!candidate.slaDueAt) continue;
      const eligibleAt =
        kind === 'sla_breach'
          ? candidate.slaDueAt
          : calculateSlaWarningBoundary(
              candidate.slaDueAt,
              state.policy.sla_notification_warning_days
            );
      recordOldestAge(oldestEligibleSlaCandidateAgeMsByKind, kind, getAgeMs(now, eligibleAt));

      for (const recipientUserId of recipientIds) {
        if (materialized + reactivated >= MAX_SLA_MATERIALIZATION_PER_TICK) {
          return {
            materialized,
            reactivated,
            capReached: true,
            oldestEligibleSlaCandidateAgeMsByKind,
          };
        }
        const reactivatedRows = await reactivateSlaNotification(db, {
          findingId: candidate.findingId,
          recipientUserId,
          kind,
          now,
        });
        if (reactivatedRows > 0) {
          reactivated += reactivatedRows;
          continue;
        }

        const inserted = await db
          .insert(security_finding_notifications)
          .values({
            finding_id: candidate.findingId,
            recipient_user_id: recipientUserId,
            kind,
            status: 'pending',
            next_attempt_at: now.toISOString(),
          })
          .onConflictDoNothing()
          .returning({ id: security_finding_notifications.id });
        materialized += inserted.length;
      }
    }
  }

  return { materialized, reactivated, capReached: false, oldestEligibleSlaCandidateAgeMsByKind };
}

async function reactivateSlaNotification(
  db: WorkerDb,
  params: {
    findingId: string;
    recipientUserId: string;
    kind: 'sla_warning' | 'sla_breach';
    now: Date;
  }
): Promise<number> {
  const rows = await db
    .update(security_finding_notifications)
    .set({
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: params.now.toISOString(),
      claimed_at: null,
      sent_at: null,
      error_message: null,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_finding_notifications.finding_id, params.findingId),
        eq(security_finding_notifications.recipient_user_id, params.recipientUserId),
        eq(security_finding_notifications.kind, params.kind),
        eq(security_finding_notifications.status, 'cancelled')
      )
    )
    .returning({ id: security_finding_notifications.id });
  return rows.length;
}

async function selectPendingDue(db: WorkerDb): Promise<NotificationFindingRow[]> {
  return db
    .select({
      notificationId: security_finding_notifications.id,
      findingId: security_finding_notifications.finding_id,
      recipientUserId: security_finding_notifications.recipient_user_id,
      kind: security_finding_notifications.kind,
      status: security_finding_notifications.status,
      attemptCount: security_finding_notifications.attempt_count,
      ownedByOrganizationId: security_findings.owned_by_organization_id,
      ownedByUserId: security_findings.owned_by_user_id,
      repoFullName: security_findings.repo_full_name,
      findingStatus: security_findings.status,
      severity: security_findings.severity,
      slaDueAt: security_findings.sla_due_at,
      ignoredReason: security_findings.ignored_reason,
    })
    .from(security_finding_notifications)
    .innerJoin(
      security_findings,
      eq(security_findings.id, security_finding_notifications.finding_id)
    )
    .where(
      and(
        eq(security_finding_notifications.status, 'pending'),
        lte(security_finding_notifications.next_attempt_at, sql`now()`)
      )
    )
    .orderBy(
      sql`CASE ${security_finding_notifications.kind}
        WHEN 'sla_breach' THEN 0
        WHEN 'sla_warning' THEN 1
        ELSE 2
      END`,
      security_finding_notifications.next_attempt_at,
      security_finding_notifications.created_at,
      security_finding_notifications.id
    )
    .limit(PENDING_SELECTION_LIMIT);
}

async function claimNotification(db: WorkerDb, notificationId: string): Promise<boolean> {
  const rows = await db
    .update(security_finding_notifications)
    .set({ status: 'sending', claimed_at: sql`now()`, error_message: null, updated_at: sql`now()` })
    .where(
      and(
        eq(security_finding_notifications.id, notificationId),
        eq(security_finding_notifications.status, 'pending'),
        lte(security_finding_notifications.next_attempt_at, sql`now()`)
      )
    )
    .returning({ id: security_finding_notifications.id });
  return rows.length > 0;
}

async function dispatchNotification(
  backendUrl: string,
  internalSecret: string,
  notificationId: string
): Promise<EndpointResponse> {
  try {
    const response = await fetch(`${backendUrl}/api/internal/security-agent/notifications`, {
      method: 'POST',
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': internalSecret,
      },
      body: JSON.stringify({ notificationId }),
    });
    const body: unknown = await response.json().catch(() => null);
    const parsed = EndpointResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { outcome: 'retryable_failure', reason: 'unexpected_response' };
    }
    if (
      response.status === 200 &&
      ['sent', 'cancelled', 'deferred'].includes(parsed.data.outcome)
    ) {
      return parsed.data;
    }
    if (response.status === 503 && parsed.data.outcome === 'retryable_failure') return parsed.data;
    if (response.status === 422 && parsed.data.outcome === 'permanent_failure') return parsed.data;
    return { outcome: 'retryable_failure', reason: 'unexpected_response' };
  } catch (error) {
    const reason =
      error instanceof DOMException && error.name === 'TimeoutError'
        ? 'endpoint_timeout'
        : 'provider_unavailable';
    return { outcome: 'retryable_failure', reason };
  }
}

function retryDelayMs(attemptCountAfterFailure: number, notificationId: string): number {
  const baseDelays = [60_000, 5 * 60_000, 30 * 60_000] as const;
  const base =
    baseDelays[Math.max(0, Math.min(attemptCountAfterFailure - 1, baseDelays.length - 1))];
  const jitterSeed = [...notificationId].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return base + (jitterSeed % 30_000);
}

async function markSent(db: WorkerDb, notificationId: string): Promise<void> {
  await db
    .update(security_finding_notifications)
    .set({
      status: 'sent',
      sent_at: sql`now()`,
      claimed_at: null,
      error_message: null,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_finding_notifications.id, notificationId),
        eq(security_finding_notifications.status, 'sending')
      )
    );
}

async function markDeferredInvalidPolicy(db: WorkerDb, notificationId: string): Promise<void> {
  await db
    .update(security_finding_notifications)
    .set({
      status: 'pending',
      claimed_at: null,
      error_message: 'invalid_notification_config',
      next_attempt_at: sql`now() + (${INVALID_POLICY_RETRY_DELAY_MINUTES} * interval '1 minute')`,
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_finding_notifications.id, notificationId),
        eq(security_finding_notifications.status, 'sending')
      )
    );
}

async function markFailure(
  db: WorkerDb,
  row: NotificationFindingRow,
  reason: string,
  permanent: boolean,
  now: Date
): Promise<'retried' | 'failed'> {
  const attemptCount = row.attemptCount + 1;
  if (permanent || attemptCount >= MAX_ATTEMPTS) {
    await db
      .update(security_finding_notifications)
      .set({
        status: 'failed',
        attempt_count: attemptCount,
        claimed_at: null,
        error_message: reason,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(security_finding_notifications.id, row.notificationId),
          eq(security_finding_notifications.status, 'sending')
        )
      );
    return 'failed';
  }

  await db
    .update(security_finding_notifications)
    .set({
      status: 'pending',
      attempt_count: attemptCount,
      claimed_at: null,
      error_message: reason,
      next_attempt_at: new Date(
        now.getTime() + retryDelayMs(attemptCount, row.notificationId)
      ).toISOString(),
      updated_at: sql`now()`,
    })
    .where(
      and(
        eq(security_finding_notifications.id, row.notificationId),
        eq(security_finding_notifications.status, 'sending')
      )
    );
  return 'retried';
}

async function dispatchPendingRows(
  db: WorkerDb,
  states: Map<OwnerKey, OwnerConfigState>,
  recipients: Map<OwnerKey, Set<string>>,
  backendUrl: string,
  internalSecret: string,
  now: Date
): Promise<
  Pick<
    SweepResult,
    'processed' | 'sent' | 'retried' | 'failed' | 'deferred' | 'cancelled' | 'dispatchCapReached'
  >
> {
  const pendingRows = await selectPendingDue(db);
  const rowsToDispatch: NotificationFindingRow[] = [];
  let cancelled = 0;

  for (const row of pendingRows) {
    if (rowsToDispatch.length >= MAX_DISPATCH_PER_TICK) break;
    const owner = rowOwner(row);
    if (!owner) {
      cancelled += await cancelNotification(db, row.notificationId, 'finding_ineligible');
      continue;
    }
    const state = states.get(ownerKey(owner));
    if (!state || state.state === 'disabled') {
      cancelled += await cancelNotification(db, row.notificationId, 'security_agent_disabled');
      continue;
    }
    if (state.state === 'malformed') continue;
    if (!notificationStillEligible(row, state.policy, recipients, now)) {
      cancelled += await cancelNotification(db, row.notificationId, 'finding_ineligible');
      continue;
    }
    rowsToDispatch.push(row);
  }

  let sent = 0;
  let retried = 0;
  let failed = 0;
  let deferred = 0;

  for (let i = 0; i < rowsToDispatch.length; i += DISPATCH_CONCURRENCY) {
    const batch = rowsToDispatch.slice(i, i + DISPATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async row => {
        const claimed = await claimNotification(db, row.notificationId);
        if (!claimed) return 'skipped' as const;
        const outcome = await dispatchNotification(backendUrl, internalSecret, row.notificationId);
        switch (outcome.outcome) {
          case 'sent':
            await markSent(db, row.notificationId);
            return 'sent' as const;
          case 'cancelled':
            await cancelNotification(db, row.notificationId, outcome.reason);
            return 'cancelled' as const;
          case 'deferred':
            await markDeferredInvalidPolicy(db, row.notificationId);
            return 'deferred' as const;
          case 'retryable_failure':
            return markFailure(db, row, outcome.reason, false, now);
          case 'permanent_failure':
            return markFailure(db, row, outcome.reason, true, now);
        }
      })
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[security-notifications] dispatch settle rejected', {
          errorType: result.reason instanceof Error ? result.reason.name : 'UnknownError',
        });
        failed += 1;
        continue;
      }
      if (result.value === 'sent') sent += 1;
      if (result.value === 'retried') retried += 1;
      if (result.value === 'failed') failed += 1;
      if (result.value === 'deferred') deferred += 1;
      if (result.value === 'cancelled') cancelled += 1;
    }
  }

  return {
    processed: rowsToDispatch.length,
    sent,
    retried,
    failed,
    deferred,
    cancelled,
    dispatchCapReached: rowsToDispatch.length >= MAX_DISPATCH_PER_TICK,
  };
}

async function readInternalSecret(env: SecurityNotificationSweepEnv): Promise<string | null> {
  if (!env.INTERNAL_API_SECRET) return null;
  try {
    const secret = await env.INTERNAL_API_SECRET.get();
    return secret || null;
  } catch {
    return null;
  }
}

export async function runSecurityNotificationSweep(
  env: SecurityNotificationSweepEnv
): Promise<SweepResult> {
  const startedAt = Date.now();
  const empty = {
    recovered: 0,
    stagedRecovered: 0,
    cancelled: 0,
    materialized: 0,
    reactivated: 0,
    processed: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    deferred: 0,
    dispatchCapReached: false,
    materializationCapReached: false,
    countsByKindAndStatus: [],
    oldestStagedAgeMsByKind: {},
    oldestPendingAgeMsByKind: {},
    oldestEligibleSlaCandidateAgeMsByKind: {},
    durationMs: 0,
  };

  if (!env.HYPERDRIVE?.connectionString) {
    console.warn('[security-notifications] HYPERDRIVE not bound; skipping');
    return { ...empty, durationMs: Date.now() - startedAt };
  }

  const materializationEnabled = parseRolloutFlag(
    env.SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED,
    'SECURITY_NOTIFICATION_MATERIALIZATION_ENABLED'
  );
  const dispatchEnabled = parseRolloutFlag(
    env.SECURITY_NOTIFICATION_DISPATCH_ENABLED,
    'SECURITY_NOTIFICATION_DISPATCH_ENABLED'
  );
  const db = getWorkerDb(env.HYPERDRIVE.connectionString, { statement_timeout: 30_000 });
  const now = new Date();

  const recovered = await recoverStuckClaims(db);
  let stagedRecovered = 0;
  let cancelled = 0;
  let materialized = 0;
  let reactivated = 0;
  let materializationCapReached = false;
  let oldestEligibleSlaCandidateAgeMsByKind: SweepResult['oldestEligibleSlaCandidateAgeMsByKind'] =
    {};

  const shouldEvaluate = materializationEnabled || dispatchEnabled;
  const states = shouldEvaluate
    ? await loadOwnerConfigStates(db)
    : new Map<OwnerKey, OwnerConfigState>();
  const recipients = shouldEvaluate
    ? await resolveRecipientsForEnabledOwners(db, states)
    : new Map<OwnerKey, Set<string>>();

  if (shouldEvaluate) {
    const staged = await recoverStagedRows(db, states, recipients, now);
    stagedRecovered = staged.stagedRecovered;
    cancelled += staged.cancelled;
    cancelled += await cancelIneligibleRows(db, states, recipients, now);
  }

  if (materializationEnabled) {
    const result = await materializeSlaNotifications(db, states, recipients, now);
    materialized = result.materialized;
    reactivated = result.reactivated;
    materializationCapReached = result.capReached;
    oldestEligibleSlaCandidateAgeMsByKind = result.oldestEligibleSlaCandidateAgeMsByKind;
  }

  let processed = 0;
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let deferred = 0;
  let dispatchCapReached = false;

  if (dispatchEnabled) {
    const [backendUrl, internalSecret] = [env.BACKEND_API_URL, await readInternalSecret(env)];
    if (!backendUrl || !internalSecret) {
      console.warn(
        '[security-notifications] BACKEND_API_URL or internal secret missing; skipping dispatch'
      );
    } else {
      const dispatchResult = await dispatchPendingRows(
        db,
        states,
        recipients,
        backendUrl,
        internalSecret,
        now
      );
      processed = dispatchResult.processed;
      sent = dispatchResult.sent;
      retried = dispatchResult.retried;
      failed = dispatchResult.failed;
      deferred = dispatchResult.deferred;
      cancelled += dispatchResult.cancelled;
      dispatchCapReached = dispatchResult.dispatchCapReached;
    }
  }

  const backlog = shouldEvaluate
    ? await loadBacklogObservability(db, now)
    : {
        countsByKindAndStatus: [],
        oldestStagedAgeMsByKind: {},
        oldestPendingAgeMsByKind: {},
      };

  const result = {
    recovered,
    stagedRecovered,
    cancelled,
    materialized,
    reactivated,
    processed,
    sent,
    retried,
    failed,
    deferred,
    dispatchCapReached,
    materializationCapReached,
    ...backlog,
    oldestEligibleSlaCandidateAgeMsByKind,
    durationMs: Date.now() - startedAt,
  };
  console.info('[security-notifications] sweep completed', result);
  return result;
}
