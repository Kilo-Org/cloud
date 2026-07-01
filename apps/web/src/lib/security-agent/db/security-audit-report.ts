import 'server-only';
import { captureException, startSpan } from '@sentry/nextjs';
import { security_audit_log, security_findings } from '@kilocode/db/schema';
import {
  SecurityAuditLogAction,
  SecurityAuditLogActorType,
  SecuritySeverity,
} from '@kilocode/db/schema-types';
import { REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS } from '@kilocode/worker-utils/security-finding-audit';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import * as z from 'zod';
import { db, type DrizzleTransaction } from '@/lib/drizzle';

export const SECURITY_AGENT_AUDIT_REPORT_VERSION = 1;
export const SECURITY_AGENT_AUDIT_REPORT_PAGE_SIZE = 1000;
export const SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS = 10_000;
export const SECURITY_AGENT_AUDIT_REPORT_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
export const SECURITY_AGENT_AUDIT_REPORT_REQUEST_TIMEOUT_MS = 25_000;
export const SECURITY_AGENT_AUDIT_REPORT_QUERY_TIMEOUT_MS = 8_000;

const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
type SecurityAgentAuditReportFailureStage =
  | 'data_through'
  | 'count'
  | 'budget'
  | 'scan'
  | 'request';

export class SecurityAgentAuditReportQueryError extends Error {
  constructor(
    message = 'Report query did not finish',
    readonly stage: SecurityAgentAuditReportFailureStage = 'request'
  ) {
    super(message);
    this.name = 'SecurityAgentAuditReportQueryError';
  }
}

export const SecurityAgentAuditReportInputSchema = z.object({
  startDate: DateOnlySchema.optional(),
  endDate: DateOnlySchema.optional(),
});

const ReliableCoverageStartSchema = z.string().datetime({ offset: true });

export function resolveSecurityAgentAuditReliableCoverageStart(
  value = process.env.SECURITY_AGENT_AUDIT_RELIABLE_COVERAGE_START
): string {
  if (!value) {
    throw new SecurityAgentAuditReportQueryError(
      'SECURITY_AGENT_AUDIT_RELIABLE_COVERAGE_START is required',
      'request'
    );
  }

  const parsed = ReliableCoverageStartSchema.safeParse(value);
  if (!parsed.success) {
    throw new SecurityAgentAuditReportQueryError(
      'SECURITY_AGENT_AUDIT_RELIABLE_COVERAGE_START must be an ISO timestamp',
      'request'
    );
  }

  return new Date(parsed.data).toISOString();
}

export type SecurityAgentAuditReportInput = z.infer<typeof SecurityAgentAuditReportInputSchema>;

export type SecurityAgentAuditReportOwner =
  | { type: 'user'; id: string; displayName: string }
  | { type: 'organization'; id: string; displayName: string };

export type SecurityAgentAuditReportActor =
  | {
      type: 'user';
      id: string | null;
      displayName: string;
      masked: boolean;
    }
  | { type: 'system'; displayName: string; masked: false };

export type SecurityAgentAuditReportEvent = {
  id: string;
  action: SecurityAuditLogAction;
  label: string;
  occurredAt: string;
  sourceOccurredAt: string | null;
  recordedAt: string;
  actor: SecurityAgentAuditReportActor;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  legacySupplemental: boolean;
};

export type SecurityAgentAuditSlaEvidence =
  | { status: 'unknown'; deadline: string | null; reason: string }
  | {
      status: 'terminal_met' | 'terminal_missed' | 'open_within_deadline' | 'open_past_deadline';
      deadline: string;
      terminalAt: string | null;
    };

export type SecurityFindingAuditSection = {
  findingId: string;
  source: string | null;
  sourceId: string | null;
  repository: string | null;
  title: string;
  severity: SecuritySeverity | 'unknown';
  status: string | null;
  packageName: string | null;
  packageEcosystem: string | null;
  manifestPath: string | null;
  patchedVersion: string | null;
  ghsaId: string | null;
  cveId: string | null;
  cweIds: string[];
  cvssScore: string | number | null;
  dependabotUrl: string | null;
  firstDetectedAt: string | null;
  canonicalFindingId: string | null;
  deleted: boolean;
  sla: SecurityAgentAuditSlaEvidence;
  events: SecurityAgentAuditReportEvent[];
  hasLegacySupplementalActivity: boolean;
};

export type SecurityAgentAuditReport = {
  reportVersion: typeof SECURITY_AGENT_AUDIT_REPORT_VERSION;
  owner: SecurityAgentAuditReportOwner;
  period: {
    start: string;
    endExclusive: string;
    displayEnd: string;
    timeZone: 'UTC';
  };
  generatedAt: string;
  dataThrough: string;
  reliableCoverageStart: string;
  evidenceBasis: 'recorded_by_kilo';
  hasLegacySupplementalActivity: boolean;
  summary: {
    findingCount: number;
    activityCount: number;
    bySeverity: Record<SecuritySeverity, number>;
    byAction: Record<string, number>;
  };
  findings: SecurityFindingAuditSection[];
};

type NormalizedAuditReportPeriod = SecurityAgentAuditReport['period'];

type AuditReportRow = {
  id: string;
  action: SecurityAuditLogAction;
  actor_id: string | null;
  actor_name: string | null;
  actor_type: SecurityAuditLogActorType | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  finding_id: string | null;
  resource_type: string;
  resource_id: string;
  occurred_at: string | null;
  source_occurred_at: string | null;
  finding_snapshot: Record<string, unknown> | null;
  effective_at: string;
};

type AuditReportCursor = {
  effectiveAt: string;
  id: string;
};

type AuditReportCurrentFinding = {
  findingId: string;
  snapshot: Record<string, unknown>;
};

type AuditReportFindingCutoffState = {
  findingId: string;
  snapshot: Record<string, unknown> | null;
  deleted: boolean;
};

const ACTION_LABELS: Partial<Record<SecurityAuditLogAction, string>> = {
  [SecurityAuditLogAction.FindingCreated]: 'Imported',
  [SecurityAuditLogAction.FindingSeverityChanged]: 'Severity changed',
  [SecurityAuditLogAction.FindingStatusChange]: 'Status changed',
  [SecurityAuditLogAction.FindingDismissed]: 'Dismissed',
  [SecurityAuditLogAction.FindingAutoDismissed]: 'Auto dismissed',
  [SecurityAuditLogAction.FindingSuperseded]: 'Superseded',
  [SecurityAuditLogAction.FindingAnalysisCompleted]: 'Analysis completed',
  [SecurityAuditLogAction.FindingAnalysisFailed]: 'Analysis failed',
  [SecurityAuditLogAction.RemediationQueued]: 'Remediation requested',
  [SecurityAuditLogAction.RemediationPrOpened]: 'PR opened',
  [SecurityAuditLogAction.RemediationFailed]: 'Remediation failed',
  [SecurityAuditLogAction.RemediationBlocked]: 'Remediation blocked',
  [SecurityAuditLogAction.RemediationNoChangesNeeded]: 'No changes needed',
  [SecurityAuditLogAction.RemediationCancelled]: 'Cancelled',
  [SecurityAuditLogAction.FindingDeleted]: 'Deleted',
};

const EMPTY_SEVERITY_COUNTS = {
  [SecuritySeverity.CRITICAL]: 0,
  [SecuritySeverity.HIGH]: 0,
  [SecuritySeverity.MEDIUM]: 0,
  [SecuritySeverity.LOW]: 0,
} satisfies Record<SecuritySeverity, number>;

type AuditEventEvidenceFields = {
  beforeState: readonly string[];
  afterState: readonly string[];
  metadata: readonly string[];
};

const ACTION_EVIDENCE_FIELDS: Partial<Record<SecurityAuditLogAction, AuditEventEvidenceFields>> = {
  [SecurityAuditLogAction.FindingCreated]: {
    beforeState: [],
    afterState: ['status', 'severity'],
    metadata: ['source_alert_number'],
  },
  [SecurityAuditLogAction.FindingSeverityChanged]: {
    beforeState: ['severity'],
    afterState: ['severity'],
    metadata: ['source_alert_number'],
  },
  [SecurityAuditLogAction.FindingStatusChange]: {
    beforeState: ['status'],
    afterState: ['status', 'fixed_at', 'reason_code'],
    metadata: ['source_alert_number', 'source_state'],
  },
  [SecurityAuditLogAction.FindingDismissed]: {
    beforeState: ['status'],
    afterState: ['status', 'reason_code'],
    metadata: ['reason_code', 'source_alert_number'],
  },
  [SecurityAuditLogAction.FindingAutoDismissed]: {
    beforeState: ['status'],
    afterState: ['status', 'reason_code'],
    metadata: ['reason_code', 'source_alert_number'],
  },
  [SecurityAuditLogAction.FindingSuperseded]: {
    beforeState: ['status'],
    afterState: ['status', 'reason_code'],
    metadata: ['source_alert_number'],
  },
  [SecurityAuditLogAction.FindingAnalysisCompleted]: {
    beforeState: ['analysis_status'],
    afterState: [
      'analysis_status',
      'structured_extraction_status',
      'suggested_action',
      'confidence',
      'is_exploitable',
    ],
    metadata: [],
  },
  [SecurityAuditLogAction.FindingAnalysisFailed]: {
    beforeState: ['analysis_status'],
    afterState: ['analysis_status'],
    metadata: ['failure_code'],
  },
  [SecurityAuditLogAction.RemediationQueued]: {
    beforeState: [],
    afterState: ['remediation_status', 'attempt_number'],
    metadata: ['origin'],
  },
  [SecurityAuditLogAction.RemediationPrOpened]: {
    beforeState: ['remediation_status'],
    afterState: ['remediation_status', 'pr_number', 'pr_draft'],
    metadata: ['origin', 'pr_url', 'validation_count'],
  },
  [SecurityAuditLogAction.RemediationFailed]: {
    beforeState: ['remediation_status'],
    afterState: ['remediation_status', 'failure_code'],
    metadata: ['origin', 'failure_code'],
  },
  [SecurityAuditLogAction.RemediationBlocked]: {
    beforeState: ['remediation_status'],
    afterState: ['remediation_status', 'blocked_reason_code'],
    metadata: ['origin', 'blocked_reason_code'],
  },
  [SecurityAuditLogAction.RemediationNoChangesNeeded]: {
    beforeState: ['remediation_status'],
    afterState: ['remediation_status'],
    metadata: ['origin'],
  },
  [SecurityAuditLogAction.RemediationCancelled]: {
    beforeState: ['remediation_status'],
    afterState: ['remediation_status'],
    metadata: ['origin'],
  },
  [SecurityAuditLogAction.FindingDeleted]: {
    beforeState: ['status'],
    afterState: ['deleted'],
    metadata: [],
  },
};

const EMPTY_EVIDENCE_FIELDS = {
  beforeState: [],
  afterState: [],
  metadata: [],
} satisfies AuditEventEvidenceFields;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function defaultSecurityAgentAuditReportInput(
  now = new Date()
): Required<SecurityAgentAuditReportInput> {
  const endDate = formatUtcDate(startOfUtcDay(now));
  const startDate = formatUtcDate(addUtcDays(parseUtcDateOnly(endDate), -89));
  return { startDate, endDate };
}

export function normalizeSecurityAgentAuditReportPeriod(
  input: SecurityAgentAuditReportInput,
  now = new Date()
): NormalizedAuditReportPeriod {
  const defaults = defaultSecurityAgentAuditReportInput(now);
  const startDate = input.startDate ?? defaults.startDate;
  const endDate = input.endDate ?? defaults.endDate;

  DateOnlySchema.parse(startDate);
  DateOnlySchema.parse(endDate);

  const start = parseUtcDateOnly(startDate);
  const endInclusive = parseUtcDateOnly(endDate);
  const today = startOfUtcDay(now);

  if (start.getTime() > endInclusive.getTime()) {
    throw new Error('Report start date must be before or equal to end date');
  }
  if (endInclusive.getTime() > today.getTime()) {
    throw new Error('Report end date cannot be in the future');
  }

  const inclusiveDays = utcDayDiff(start, endInclusive) + 1;
  if (inclusiveDays > 90) {
    throw new Error('Report range cannot exceed 90 inclusive UTC calendar days');
  }

  const endExclusive = addUtcDays(endInclusive, 1);
  return {
    start: start.toISOString(),
    endExclusive: endExclusive.toISOString(),
    displayEnd: endDate,
    timeZone: 'UTC',
  };
}

export async function getSecurityAgentAuditReport(params: {
  owner: SecurityAgentAuditReportOwner;
  input: SecurityAgentAuditReportInput;
  isRequestingUserKiloAdmin: boolean;
}): Promise<SecurityAgentAuditReport> {
  const parsedInput = SecurityAgentAuditReportInputSchema.parse(params.input);
  const period = normalizeSecurityAgentAuditReportPeriod(parsedInput);
  const generatedAt = new Date().toISOString();
  const startedAt = Date.now();
  let eventCount: number | null = null;

  return await startSpan(
    {
      name: 'security-agent.audit-report',
      op: 'security_agent.report',
    },
    async span => {
      span.setAttribute('security_agent.audit_report.owner_type', params.owner.type);
      span.setAttribute(
        'security_agent.audit_report.report_version',
        SECURITY_AGENT_AUDIT_REPORT_VERSION
      );

      try {
        const report = await withSecurityAgentAuditReportTimeout(
          assembleSecurityAgentAuditReport({
            ...params,
            period,
            generatedAt,
            onEventCount: count => {
              eventCount = count;
            },
          }),
          SECURITY_AGENT_AUDIT_REPORT_REQUEST_TIMEOUT_MS,
          'request'
        );

        span.setAttribute('security_agent.audit_report.duration_ms', Date.now() - startedAt);
        span.setAttribute(
          'security_agent.audit_report.event_count_bucket',
          securityAgentAuditReportEventCountBucket(report.summary.activityCount)
        );
        span.setAttribute('security_agent.audit_report.failure_stage', 'none');
        return report;
      } catch (error) {
        const failureStage =
          error instanceof SecurityAgentAuditReportQueryError ? error.stage : 'request';
        const eventCountBucket = securityAgentAuditReportEventCountBucket(eventCount);
        span.setAttribute('security_agent.audit_report.duration_ms', Date.now() - startedAt);
        span.setAttribute('security_agent.audit_report.event_count_bucket', eventCountBucket);
        span.setAttribute('security_agent.audit_report.failure_stage', failureStage);
        captureException(error, {
          tags: {
            operation: 'security_agent.audit_report',
            owner_type: params.owner.type,
            report_version: String(SECURITY_AGENT_AUDIT_REPORT_VERSION),
            failure_stage: failureStage,
            event_count_bucket: eventCountBucket,
          },
        });
        throw error;
      }
    }
  );
}

async function assembleSecurityAgentAuditReport(params: {
  owner: SecurityAgentAuditReportOwner;
  period: NormalizedAuditReportPeriod;
  generatedAt: string;
  isRequestingUserKiloAdmin: boolean;
  onEventCount: (eventCount: number) => void;
}): Promise<SecurityAgentAuditReport> {
  const { dataThrough, rows, cutoffStates, currentFindings } = await db.transaction(
    async tx => {
      const dataThrough = await getDatabaseNow(tx);
      const eventCount = await countReportEvents(tx, params.owner, params.period);
      params.onEventCount(eventCount);

      if (eventCount > SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS) {
        throw new SecurityAgentAuditReportQueryError(
          'Report event count exceeds v1 tested budget',
          'budget'
        );
      }

      const rows = await scanReportRows(tx, params.owner, params.period);
      if (rows.length !== eventCount) {
        throw new SecurityAgentAuditReportQueryError(
          'Report scan row count does not match counted events',
          'scan'
        );
      }

      const findingIds = Array.from(
        new Set(
          rows.map(getRowFindingId).filter((findingId): findingId is string => Boolean(findingId))
        )
      );
      const [cutoffStates, currentFindings] = await Promise.all([
        loadReportFindingCutoffStates(tx, params.owner, findingIds),
        loadCurrentReportFindings(tx, params.owner, findingIds),
      ]);

      return { dataThrough, rows, cutoffStates, currentFindings };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );

  const report = buildSecurityAgentAuditReportFromRows({
    owner: params.owner,
    period: params.period,
    generatedAt: params.generatedAt,
    dataThrough,
    rows,
    cutoffStates,
    currentFindings,
    isRequestingUserKiloAdmin: params.isRequestingUserKiloAdmin,
  });
  assertSecurityAgentAuditReportSerializedByteBudget(report);
  return report;
}

export function buildSecurityAgentAuditReportFromRows(params: {
  owner: SecurityAgentAuditReportOwner;
  period: NormalizedAuditReportPeriod;
  generatedAt: string;
  dataThrough: string;
  rows: AuditReportRow[];
  cutoffStates?: AuditReportFindingCutoffState[];
  currentFindings?: AuditReportCurrentFinding[];
  isRequestingUserKiloAdmin: boolean;
}): SecurityAgentAuditReport {
  const groups = new Map<string, AuditReportRow[]>();
  for (const row of params.rows) {
    const findingId = getRowFindingId(row);
    if (!findingId) continue;
    const existing = groups.get(findingId) ?? [];
    existing.push(row);
    groups.set(findingId, existing);
  }

  const cutoffStateByFindingId = new Map(
    params.cutoffStates?.map(state => [state.findingId, state]) ?? []
  );
  const currentFindingByFindingId = new Map(
    params.currentFindings?.map(finding => [finding.findingId, finding.snapshot]) ?? []
  );
  const findings = Array.from(groups.entries()).map(([findingId, rows]) =>
    buildFindingSection(
      findingId,
      rows,
      params,
      cutoffStateByFindingId.get(findingId),
      currentFindingByFindingId.get(findingId)
    )
  );

  findings.sort((left, right) => {
    const leftFirst = left.events[0]?.occurredAt ?? '';
    const rightFirst = right.events[0]?.occurredAt ?? '';
    return (
      leftFirst.localeCompare(rightFirst) ||
      (left.repository ?? '').localeCompare(right.repository ?? '') ||
      left.title.localeCompare(right.title) ||
      left.findingId.localeCompare(right.findingId)
    );
  });

  const bySeverity = { ...EMPTY_SEVERITY_COUNTS };
  for (const finding of findings) {
    if (finding.severity !== 'unknown') bySeverity[finding.severity] += 1;
  }

  const byAction: Record<string, number> = {};
  for (const row of params.rows) {
    byAction[row.action] = (byAction[row.action] ?? 0) + 1;
  }

  return {
    reportVersion: SECURITY_AGENT_AUDIT_REPORT_VERSION,
    owner: params.owner,
    period: params.period,
    generatedAt: params.generatedAt,
    dataThrough: params.dataThrough,
    reliableCoverageStart: resolveSecurityAgentAuditReliableCoverageStart(),
    evidenceBasis: 'recorded_by_kilo',
    hasLegacySupplementalActivity: findings.some(finding => finding.hasLegacySupplementalActivity),
    summary: {
      findingCount: findings.length,
      activityCount: params.rows.length,
      bySeverity,
      byAction,
    },
    findings,
  };
}

async function getDatabaseNow(tx: DrizzleTransaction): Promise<string> {
  const { rows } = await withSecurityAgentAuditReportTimeout(
    tx.execute<{ data_through: string }>(sql`SELECT now() AS data_through`),
    SECURITY_AGENT_AUDIT_REPORT_QUERY_TIMEOUT_MS,
    'data_through'
  );
  return new Date(rows[0].data_through).toISOString();
}

async function countReportEvents(
  tx: DrizzleTransaction,
  owner: SecurityAgentAuditReportOwner,
  period: NormalizedAuditReportPeriod
): Promise<number> {
  try {
    const [row] = await withSecurityAgentAuditReportTimeout(
      tx
        .select({ eventCount: count(security_audit_log.id) })
        .from(security_audit_log)
        .where(and(...baseReportConditions(owner, period))),
      SECURITY_AGENT_AUDIT_REPORT_QUERY_TIMEOUT_MS,
      'count'
    );
    return row.eventCount;
  } catch (error) {
    if (error instanceof SecurityAgentAuditReportQueryError) throw error;
    throw new SecurityAgentAuditReportQueryError(
      error instanceof Error ? error.message : 'Report query did not finish',
      'count'
    );
  }
}

async function scanReportRows(
  tx: DrizzleTransaction,
  owner: SecurityAgentAuditReportOwner,
  period: NormalizedAuditReportPeriod
): Promise<AuditReportRow[]> {
  const rows: AuditReportRow[] = [];
  let cursor: AuditReportCursor | null = null;

  while (true) {
    const page = await scanReportPage(tx, owner, period, cursor);
    rows.push(...page);

    if (page.length < SECURITY_AGENT_AUDIT_REPORT_PAGE_SIZE) return rows;
    const last = page[page.length - 1];
    cursor = { effectiveAt: last.effective_at, id: last.id };
  }
}

async function scanReportPage(
  tx: DrizzleTransaction,
  owner: SecurityAgentAuditReportOwner,
  period: NormalizedAuditReportPeriod,
  cursor: AuditReportCursor | null
): Promise<AuditReportRow[]> {
  const effectiveAt = reportEffectiveAtSql();
  const whereConditions = baseReportConditions(owner, period);
  if (cursor) {
    const cursorCondition = or(
      gt(effectiveAt, cursor.effectiveAt),
      and(eq(effectiveAt, cursor.effectiveAt), gt(security_audit_log.id, cursor.id))
    );
    if (cursorCondition) whereConditions.push(cursorCondition);
  }

  try {
    return await withSecurityAgentAuditReportTimeout(
      tx
        .select({
          id: security_audit_log.id,
          action: security_audit_log.action,
          actor_id: security_audit_log.actor_id,
          actor_name: security_audit_log.actor_name,
          actor_type: security_audit_log.actor_type,
          before_state: security_audit_log.before_state,
          after_state: security_audit_log.after_state,
          metadata: security_audit_log.metadata,
          created_at: security_audit_log.created_at,
          finding_id: security_audit_log.finding_id,
          resource_type: security_audit_log.resource_type,
          resource_id: security_audit_log.resource_id,
          occurred_at: security_audit_log.occurred_at,
          source_occurred_at: security_audit_log.source_occurred_at,
          finding_snapshot: security_audit_log.finding_snapshot,
          effective_at: effectiveAt,
        })
        .from(security_audit_log)
        .where(and(...whereConditions))
        .orderBy(asc(effectiveAt), asc(security_audit_log.id))
        .limit(SECURITY_AGENT_AUDIT_REPORT_PAGE_SIZE),
      SECURITY_AGENT_AUDIT_REPORT_QUERY_TIMEOUT_MS,
      'scan'
    );
  } catch (error) {
    if (error instanceof SecurityAgentAuditReportQueryError) throw error;
    throw new SecurityAgentAuditReportQueryError(
      error instanceof Error ? error.message : 'Report query did not finish',
      'scan'
    );
  }
}

async function loadReportFindingCutoffStates(
  tx: DrizzleTransaction,
  owner: SecurityAgentAuditReportOwner,
  findingIds: string[]
): Promise<AuditReportFindingCutoffState[]> {
  if (findingIds.length === 0) return [];

  const effectiveAt = reportEffectiveAtSql();
  const findingId = reportFindingIdSql();
  const findingIdentityCondition = or(
    inArray(security_audit_log.finding_id, findingIds),
    and(
      eq(security_audit_log.resource_type, 'security_finding'),
      inArray(security_audit_log.resource_id, findingIds)
    )
  );
  if (!findingIdentityCondition) {
    throw new SecurityAgentAuditReportQueryError('Report cutoff identity query failed', 'scan');
  }

  const conditions = [
    owner.type === 'user'
      ? eq(security_audit_log.owned_by_user_id, owner.id)
      : eq(security_audit_log.owned_by_organization_id, owner.id),
    inArray(security_audit_log.action, [...REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS]),
    lte(effectiveAt, reportDataThroughSql()),
    lte(security_audit_log.created_at, reportDataThroughSql()),
    findingIdentityCondition,
  ];

  try {
    const latestRows = await withSecurityAgentAuditReportTimeout(
      tx
        .selectDistinctOn([findingId], {
          findingId,
          snapshot: security_audit_log.finding_snapshot,
        })
        .from(security_audit_log)
        .where(and(...conditions, isNotNull(security_audit_log.finding_snapshot)))
        .orderBy(
          asc(findingId),
          desc(effectiveAt),
          desc(security_audit_log.created_at),
          desc(security_audit_log.id)
        ),
      SECURITY_AGENT_AUDIT_REPORT_QUERY_TIMEOUT_MS,
      'scan'
    );
    const deletionRows = await withSecurityAgentAuditReportTimeout(
      tx
        .select({ findingId })
        .from(security_audit_log)
        .where(
          and(...conditions, eq(security_audit_log.action, SecurityAuditLogAction.FindingDeleted))
        ),
      SECURITY_AGENT_AUDIT_REPORT_QUERY_TIMEOUT_MS,
      'scan'
    );
    const latestSnapshotByFindingId = new Map(latestRows.map(row => [row.findingId, row.snapshot]));
    const deletedFindingIds = new Set(deletionRows.map(row => row.findingId));

    return findingIds.map(findingId => ({
      findingId,
      snapshot: latestSnapshotByFindingId.get(findingId) ?? null,
      deleted: deletedFindingIds.has(findingId),
    }));
  } catch (error) {
    if (error instanceof SecurityAgentAuditReportQueryError) throw error;
    throw new SecurityAgentAuditReportQueryError(
      error instanceof Error ? error.message : 'Report query did not finish',
      'scan'
    );
  }
}

async function loadCurrentReportFindings(
  tx: DrizzleTransaction,
  owner: SecurityAgentAuditReportOwner,
  findingIds: string[]
): Promise<AuditReportCurrentFinding[]> {
  if (findingIds.length === 0) return [];

  try {
    const rows = await withSecurityAgentAuditReportTimeout(
      tx
        .select({
          findingId: security_findings.id,
          source: security_findings.source,
          sourceId: security_findings.source_id,
          repository: security_findings.repo_full_name,
          title: security_findings.title,
          severity: security_findings.severity,
          status: security_findings.status,
          packageName: security_findings.package_name,
          packageEcosystem: security_findings.package_ecosystem,
          manifestPath: security_findings.manifest_path,
          patchedVersion: security_findings.patched_version,
          ghsaId: security_findings.ghsa_id,
          cveId: security_findings.cve_id,
          cweIds: security_findings.cwe_ids,
          cvssScore: security_findings.cvss_score,
          dependabotUrl: security_findings.dependabot_html_url,
          firstDetectedAt: security_findings.first_detected_at,
        })
        .from(security_findings)
        .where(
          and(
            inArray(security_findings.id, findingIds),
            owner.type === 'user'
              ? eq(security_findings.owned_by_user_id, owner.id)
              : eq(security_findings.owned_by_organization_id, owner.id)
          )
        ),
      SECURITY_AGENT_AUDIT_REPORT_QUERY_TIMEOUT_MS,
      'scan'
    );

    return rows.map(row => ({
      findingId: row.findingId,
      snapshot: {
        finding_id: row.findingId,
        source: row.source,
        source_id: row.sourceId,
        repo_full_name: row.repository,
        title: row.title,
        severity: row.severity,
        status: row.status,
        package_name: row.packageName,
        package_ecosystem: row.packageEcosystem,
        manifest_path: row.manifestPath,
        patched_version: row.patchedVersion,
        ghsa_id: row.ghsaId,
        cve_id: row.cveId,
        cwe_ids: row.cweIds,
        cvss_score: row.cvssScore,
        dependabot_html_url: row.dependabotUrl,
        first_detected_at: row.firstDetectedAt,
      },
    }));
  } catch (error) {
    if (error instanceof SecurityAgentAuditReportQueryError) throw error;
    throw new SecurityAgentAuditReportQueryError(
      error instanceof Error ? error.message : 'Report query did not finish',
      'scan'
    );
  }
}

function baseReportConditions(
  owner: SecurityAgentAuditReportOwner,
  period: NormalizedAuditReportPeriod
) {
  const effectiveAt = reportEffectiveAtSql();
  const findingIdentityCondition = or(
    isNotNull(security_audit_log.finding_id),
    and(
      eq(security_audit_log.resource_type, 'security_finding'),
      sql`${security_audit_log.resource_id}::text ~ ${UUID_PATTERN.source}::text`
    )
  );
  if (!findingIdentityCondition) {
    throw new SecurityAgentAuditReportQueryError('Report finding identity query failed', 'scan');
  }

  return [
    owner.type === 'user'
      ? eq(security_audit_log.owned_by_user_id, owner.id)
      : eq(security_audit_log.owned_by_organization_id, owner.id),
    inArray(security_audit_log.action, [...REPORTABLE_SECURITY_FINDING_AUDIT_ACTIONS]),
    gte(effectiveAt, period.start),
    lt(effectiveAt, period.endExclusive),
    lte(security_audit_log.created_at, reportDataThroughSql()),
    findingIdentityCondition,
  ];
}

function reportEffectiveAtSql() {
  return sql<string>`COALESCE(${security_audit_log.occurred_at}, ${security_audit_log.created_at})`;
}

function reportDataThroughSql() {
  return sql<string>`transaction_timestamp()`;
}

function reportFindingIdSql() {
  return sql<string>`COALESCE(${security_audit_log.finding_id}::text, ${security_audit_log.resource_id})`;
}

export async function withSecurityAgentAuditReportTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  stage: SecurityAgentAuditReportFailureStage
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new SecurityAgentAuditReportQueryError('Report query did not finish', stage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

export function securityAgentAuditReportEventCountBucket(eventCount: number | null): string {
  if (eventCount === null) return 'unknown';
  if (eventCount === 0) return '0';
  if (eventCount < 100) return '1-99';
  if (eventCount < 1_000) return '100-999';
  if (eventCount < 5_000) return '1000-4999';
  if (eventCount <= SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS) return '5000-10000';
  return 'over-budget';
}

export function securityAgentAuditReportSerializedByteLength(
  report: SecurityAgentAuditReport
): number {
  return Buffer.byteLength(JSON.stringify(report), 'utf8');
}

export function assertSecurityAgentAuditReportSerializedByteBudget(
  report: SecurityAgentAuditReport
): void {
  if (
    securityAgentAuditReportSerializedByteLength(report) >
    SECURITY_AGENT_AUDIT_REPORT_MAX_SERIALIZED_BYTES
  ) {
    throw new SecurityAgentAuditReportQueryError(
      'Report serialized size exceeds v1 tested budget',
      'budget'
    );
  }
}

function buildFindingSection(
  findingId: string,
  rows: AuditReportRow[],
  reportParams: {
    dataThrough: string;
    isRequestingUserKiloAdmin: boolean;
  },
  cutoffState: AuditReportFindingCutoffState | undefined,
  currentFindingSnapshot: Record<string, unknown> | undefined
): SecurityFindingAuditSection {
  rows.sort(
    (left, right) =>
      left.effective_at.localeCompare(right.effective_at) || left.id.localeCompare(right.id)
  );
  const latestSnapshot = latestFindingSnapshot(rows);
  const descriptiveSnapshot = mergeSnapshotFallback(latestSnapshot, currentFindingSnapshot);
  const evidenceSnapshot = withRecordedTimelineEvidence(rows, latestSnapshot);
  const stateSnapshot = cutoffState?.snapshot ?? evidenceSnapshot ?? currentFindingSnapshot ?? null;
  const events = rows.map(row => buildReportEvent(row, reportParams.isRequestingUserKiloAdmin));
  const deleted = cutoffState
    ? cutoffState.deleted
    : rows.some(row => row.action === SecurityAuditLogAction.FindingDeleted);
  const legacySupplemental = rows.some(row => isLegacySupplementalRow(row));

  return {
    findingId,
    source: stringFromSnapshot(descriptiveSnapshot, 'source'),
    sourceId: stringFromSnapshot(descriptiveSnapshot, 'source_id'),
    repository: stringFromSnapshot(descriptiveSnapshot, 'repo_full_name'),
    title: stringFromSnapshot(descriptiveSnapshot, 'title') ?? `Security Finding ${findingId}`,
    severity: severityFromSnapshot(descriptiveSnapshot),
    status: stringFromSnapshot(stateSnapshot, 'status'),
    packageName: stringFromSnapshot(descriptiveSnapshot, 'package_name'),
    packageEcosystem: stringFromSnapshot(descriptiveSnapshot, 'package_ecosystem'),
    manifestPath: stringFromSnapshot(descriptiveSnapshot, 'manifest_path'),
    patchedVersion: stringFromSnapshot(descriptiveSnapshot, 'patched_version'),
    ghsaId: stringFromSnapshot(descriptiveSnapshot, 'ghsa_id'),
    cveId: stringFromSnapshot(descriptiveSnapshot, 'cve_id'),
    cweIds: stringArrayFromSnapshot(descriptiveSnapshot, 'cwe_ids'),
    cvssScore: cvssFromSnapshot(descriptiveSnapshot),
    dependabotUrl: safeUrl(stringFromSnapshot(descriptiveSnapshot, 'dependabot_html_url')),
    firstDetectedAt:
      stringFromSnapshot(evidenceSnapshot, 'first_detected_at') ??
      stringFromSnapshot(descriptiveSnapshot, 'first_detected_at'),
    canonicalFindingId: stringFromSnapshot(stateSnapshot, 'canonical_finding_id'),
    deleted,
    sla: buildSlaEvidence(stateSnapshot, reportParams.dataThrough, deleted),
    events,
    hasLegacySupplementalActivity: legacySupplemental,
  };
}

function buildReportEvent(
  row: AuditReportRow,
  isRequestingUserKiloAdmin: boolean
): SecurityAgentAuditReportEvent {
  const evidenceFields = ACTION_EVIDENCE_FIELDS[row.action] ?? EMPTY_EVIDENCE_FIELDS;
  return {
    id: row.id,
    action: row.action,
    label: ACTION_LABELS[row.action] ?? row.action,
    occurredAt: new Date(row.effective_at).toISOString(),
    sourceOccurredAt: row.source_occurred_at
      ? new Date(row.source_occurred_at).toISOString()
      : null,
    recordedAt: new Date(row.created_at).toISOString(),
    actor: buildReportActor(row, isRequestingUserKiloAdmin),
    beforeState: selectReportEvidence(row.before_state, evidenceFields.beforeState),
    afterState: selectReportEvidence(row.after_state, evidenceFields.afterState),
    metadata: selectReportEvidence(row.metadata, evidenceFields.metadata),
    legacySupplemental: isLegacySupplementalRow(row),
  };
}

function buildReportActor(
  row: Pick<AuditReportRow, 'actor_id' | 'actor_name' | 'actor_type'>,
  isRequestingUserKiloAdmin: boolean
): SecurityAgentAuditReportActor {
  if (row.actor_type === SecurityAuditLogActorType.System) {
    return { type: 'system', displayName: 'Kilo system', masked: false };
  }

  const hasPersistedIdentity = Boolean(row.actor_id || row.actor_name);
  if (row.actor_type === null && !hasPersistedIdentity) {
    return { type: 'system', displayName: 'Kilo system', masked: false };
  }

  if (
    !isRequestingUserKiloAdmin &&
    (row.actor_type === SecurityAuditLogActorType.KiloAdmin || row.actor_type === null)
  ) {
    return {
      type: 'user',
      id: '00000000-0000-0000-0000-000000000000',
      displayName:
        row.actor_type === SecurityAuditLogActorType.KiloAdmin ? 'Kilo Admin' : 'Masked user',
      masked: true,
    };
  }

  return {
    type: 'user',
    id: row.actor_id,
    displayName: row.actor_name ?? (row.actor_id ? 'Kilo user' : 'Unknown user'),
    masked: false,
  };
}

function latestFindingSnapshot(rows: AuditReportRow[]): Record<string, unknown> | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const snapshot = rows[index].finding_snapshot;
    if (snapshot) return snapshot;
  }
  return null;
}

function mergeSnapshotFallback(
  recordedSnapshot: Record<string, unknown> | null,
  currentSnapshot: Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!recordedSnapshot) return currentSnapshot ?? null;
  if (!currentSnapshot) return recordedSnapshot;
  return { ...currentSnapshot, ...recordedSnapshot };
}

function withRecordedTimelineEvidence(
  rows: AuditReportRow[],
  latestSnapshot: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!latestSnapshot) return null;

  const evidenceSnapshot = { ...latestSnapshot };
  for (const key of ['first_detected_at', 'sla_due_at'] as const) {
    if (Object.hasOwn(evidenceSnapshot, key)) continue;

    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const snapshot = rows[index].finding_snapshot;
      if (!snapshot || !Object.hasOwn(snapshot, key)) continue;
      evidenceSnapshot[key] = snapshot[key];
      break;
    }
  }
  return evidenceSnapshot;
}

function getRowFindingId(row: AuditReportRow): string | null {
  if (row.finding_id) return row.finding_id;
  if (row.resource_type === 'security_finding' && UUID_PATTERN.test(row.resource_id)) {
    return row.resource_id;
  }
  return null;
}

function isLegacySupplementalRow(row: AuditReportRow): boolean {
  return !row.occurred_at || !row.finding_id;
}

function buildSlaEvidence(
  snapshot: Record<string, unknown> | null,
  dataThrough: string,
  deleted: boolean
): SecurityAgentAuditSlaEvidence {
  const deadline = stringFromSnapshot(snapshot, 'sla_due_at');
  if (!deadline) return { status: 'unknown', deadline: null, reason: 'missing_recorded_deadline' };

  const deadlineMs = Date.parse(deadline);
  if (Number.isNaN(deadlineMs)) {
    return { status: 'unknown', deadline, reason: 'invalid_recorded_deadline' };
  }

  const status = stringFromSnapshot(snapshot, 'status');
  const canonicalFindingId = stringFromSnapshot(snapshot, 'canonical_finding_id');
  if (status === 'ignored' || canonicalFindingId) {
    return { status: 'unknown', deadline, reason: 'ignored_or_superseded_without_terminal_time' };
  }

  const fixedAt = stringFromSnapshot(snapshot, 'fixed_at');
  if (fixedAt) {
    const fixedAtMs = Date.parse(fixedAt);
    if (Number.isNaN(fixedAtMs)) {
      return { status: 'unknown', deadline, reason: 'invalid_terminal_timestamp' };
    }
    return {
      status: fixedAtMs < deadlineMs ? 'terminal_met' : 'terminal_missed',
      deadline,
      terminalAt: fixedAt,
    };
  }

  if (deleted) {
    return { status: 'unknown', deadline, reason: 'deleted_without_terminal_timestamp' };
  }
  if (status === 'fixed') {
    return { status: 'unknown', deadline, reason: 'missing_terminal_timestamp' };
  }
  if (status !== 'open') {
    return { status: 'unknown', deadline, reason: 'missing_open_status_evidence' };
  }

  const cutoffMs = Date.parse(dataThrough);
  if (Number.isNaN(cutoffMs)) {
    return { status: 'unknown', deadline, reason: 'invalid_report_cutoff' };
  }

  return {
    status: cutoffMs < deadlineMs ? 'open_within_deadline' : 'open_past_deadline',
    deadline,
    terminalAt: null,
  };
}

function severityFromSnapshot(
  snapshot: Record<string, unknown> | null
): SecuritySeverity | 'unknown' {
  const severity = stringFromSnapshot(snapshot, 'severity');
  if (
    severity === SecuritySeverity.CRITICAL ||
    severity === SecuritySeverity.HIGH ||
    severity === SecuritySeverity.MEDIUM ||
    severity === SecuritySeverity.LOW
  ) {
    return severity;
  }
  return 'unknown';
}

function stringFromSnapshot(snapshot: Record<string, unknown> | null, key: string): string | null {
  const value = snapshot?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArrayFromSnapshot(snapshot: Record<string, unknown> | null, key: string): string[] {
  const value = snapshot?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function cvssFromSnapshot(snapshot: Record<string, unknown> | null): string | number | null {
  const value = snapshot?.cvss_score;
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function safeUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

const REDACTED_JSON_KEY_PATTERN =
  /(^|_)(email|recipient|prompt|rawmarkdown|raw_markdown|transcript|assistant|provider_response|authorization|auth_header|cookie|token|secret|password|credential|headers|raw_error)(_|$)/i;

function selectReportEvidence(
  value: Record<string, unknown> | null,
  allowedFields: readonly string[]
): Record<string, unknown> | null {
  const sanitized = sanitizeJsonObject(value);
  if (!sanitized) return null;

  const selected: Record<string, unknown> = {};
  for (const field of allowedFields) {
    if (Object.prototype.hasOwnProperty.call(sanitized, field)) selected[field] = sanitized[field];
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

function sanitizeJsonObject(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  return sanitizeJson(value) as Record<string, unknown>;
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item));
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (REDACTED_JSON_KEY_PATTERN.test(key)) continue;
      sanitized[key] = sanitizeJson(child);
    }
    return sanitized;
  }
  return value;
}

function parseUtcDateOnly(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatUtcDate(date) !== value) {
    throw new Error('Report date must be a valid UTC calendar date');
  }
  return date;
}

function startOfUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function utcDayDiff(start: Date, end: Date): number {
  return Math.floor((end.getTime() - start.getTime()) / 86_400_000);
}

function formatUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
