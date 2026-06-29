import { afterEach, describe, expect, it } from '@jest/globals';
import { db, pool } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users, security_audit_log } from '@kilocode/db/schema';
import { SecurityAuditLogAction, SecurityAuditLogActorType } from '@kilocode/db/schema-types';
import { inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  assertSecurityAgentAuditReportSerializedByteBudget,
  buildSecurityAgentAuditReportFromRows,
  defaultSecurityAgentAuditReportInput,
  getSecurityAgentAuditReport,
  normalizeSecurityAgentAuditReportPeriod,
  resolveSecurityAgentAuditReliableCoverageStart,
  SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS,
  SECURITY_AGENT_AUDIT_REPORT_MAX_SERIALIZED_BYTES,
  SECURITY_AGENT_AUDIT_REPORT_PAGE_SIZE,
  securityAgentAuditReportSerializedByteLength,
  securityAgentAuditReportEventCountBucket,
  SecurityAgentAuditReportQueryError,
  withSecurityAgentAuditReportTimeout,
} from './security-audit-report';

type AuditReportRow = Parameters<typeof buildSecurityAgentAuditReportFromRows>[0]['rows'][number];

process.env.SECURITY_AGENT_AUDIT_RELIABLE_COVERAGE_START = '2026-06-17T12:00:00.000Z';

const period = normalizeSecurityAgentAuditReportPeriod(
  { startDate: '2026-06-01', endDate: '2026-06-12' },
  new Date('2026-06-12T15:00:00.000Z')
);
const integrationOwnerIds: string[] = [];

async function createIntegrationOwner() {
  const user = await insertTestUser();
  integrationOwnerIds.push(user.id);
  return {
    type: 'user' as const,
    id: user.id,
    displayName: user.google_user_name ?? 'Test User',
  };
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

function findingSnapshot(findingId: string): Record<string, unknown> {
  return {
    finding_id: findingId,
    source: 'dependabot',
    source_id: '42',
    repo_full_name: 'kilo/snapshot-report-test',
    title: 'Snapshot report pagination test',
    severity: 'high',
    status: 'open',
  };
}

async function waitForAuditReportReadBlockedBy(lockingPid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
        SELECT 1
        FROM pg_locks
        WHERE relation = 'security_audit_log'::regclass
          AND NOT granted
          AND $1::integer = ANY(pg_blocking_pids(pid))
      ) AS waiting`,
      [lockingPid]
    );
    if (result.rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Audit report read did not block on expected table lock');
}

afterEach(async () => {
  if (integrationOwnerIds.length === 0) return;
  await db.delete(kilocode_users).where(inArray(kilocode_users.id, integrationOwnerIds));
  integrationOwnerIds.length = 0;
});

function row(overrides: Partial<AuditReportRow>): AuditReportRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    action: SecurityAuditLogAction.FindingCreated,
    actor_id: null,
    actor_name: null,
    actor_type: SecurityAuditLogActorType.System,
    before_state: null,
    after_state: null,
    metadata: null,
    created_at: '2026-06-01T10:00:00.000Z',
    finding_id: '11111111-1111-4111-8111-111111111111',
    resource_type: 'security_finding',
    resource_id: '11111111-1111-4111-8111-111111111111',
    occurred_at: '2026-06-01T10:00:00.000Z',
    source_occurred_at: null,
    finding_snapshot: {
      finding_id: '11111111-1111-4111-8111-111111111111',
      source: 'dependabot',
      source_id: '42',
      repo_full_name: 'kilo/repo',
      title: 'Prototype Pollution in lodash',
      severity: 'high',
      status: 'open',
      package_name: 'lodash',
      package_ecosystem: 'npm',
      first_detected_at: '2026-06-01T08:00:00.000Z',
      sla_due_at: '2026-06-08T08:00:00.000Z',
    },
    effective_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('resolveSecurityAgentAuditReliableCoverageStart', () => {
  it('requires and normalizes deployment-time coverage configuration', () => {
    expect(resolveSecurityAgentAuditReliableCoverageStart('2026-06-17T14:00:00+02:00')).toBe(
      '2026-06-17T12:00:00.000Z'
    );
    expect(() => resolveSecurityAgentAuditReliableCoverageStart('')).toThrow(
      'SECURITY_AGENT_AUDIT_RELIABLE_COVERAGE_START is required'
    );
    expect(() => resolveSecurityAgentAuditReliableCoverageStart('')).toThrow(
      SecurityAgentAuditReportQueryError
    );
    expect(() => resolveSecurityAgentAuditReliableCoverageStart('2026-06-17')).toThrow(
      'SECURITY_AGENT_AUDIT_RELIABLE_COVERAGE_START must be an ISO timestamp'
    );
    expect(() => resolveSecurityAgentAuditReliableCoverageStart('2026-06-17')).toThrow(
      SecurityAgentAuditReportQueryError
    );
  });
});

describe('defaultSecurityAgentAuditReportInput', () => {
  it('defaults to 90 UTC calendar days ending on the current day', () => {
    expect(defaultSecurityAgentAuditReportInput(new Date('2026-06-16T21:08:07+02:00'))).toEqual({
      startDate: '2026-03-19',
      endDate: '2026-06-16',
    });
  });
});

describe('normalizeSecurityAgentAuditReportPeriod', () => {
  it('uses inclusive UTC end date and exclusive next-day boundary', () => {
    const normalized = normalizeSecurityAgentAuditReportPeriod(
      { startDate: '2026-06-12', endDate: '2026-06-12' },
      new Date('2026-06-12T15:00:00.000Z')
    );

    expect(normalized).toEqual({
      start: '2026-06-12T00:00:00.000Z',
      endExclusive: '2026-06-13T00:00:00.000Z',
      displayEnd: '2026-06-12',
      timeZone: 'UTC',
    });
  });

  it('accepts a range of exactly 90 inclusive UTC calendar days', () => {
    const normalized = normalizeSecurityAgentAuditReportPeriod(
      { startDate: '2026-03-15', endDate: '2026-06-12' },
      new Date('2026-06-12T15:00:00.000Z')
    );

    expect(normalized.start).toBe('2026-03-15T00:00:00.000Z');
    expect(normalized.endExclusive).toBe('2026-06-13T00:00:00.000Z');
  });

  it('rejects reversed, future, invalid, and over-limit ranges', () => {
    const now = new Date('2026-06-12T15:00:00.000Z');

    expect(() =>
      normalizeSecurityAgentAuditReportPeriod(
        { startDate: '2026-06-12', endDate: '2026-06-11' },
        now
      )
    ).toThrow('start date');
    expect(() =>
      normalizeSecurityAgentAuditReportPeriod(
        { startDate: '2026-06-12', endDate: '2026-06-13' },
        now
      )
    ).toThrow('future');
    expect(() =>
      normalizeSecurityAgentAuditReportPeriod(
        { startDate: '2026-02-30', endDate: '2026-03-01' },
        now
      )
    ).toThrow('valid UTC calendar date');
    expect(() =>
      normalizeSecurityAgentAuditReportPeriod(
        { startDate: '2026-03-14', endDate: '2026-06-12' },
        now
      )
    ).toThrow('90 inclusive');
  });
});

describe('getSecurityAgentAuditReport', () => {
  it('scans more than one page of same-timestamp events without gaps or duplicates', async () => {
    const owner = await createIntegrationOwner();
    const findingId = randomUUID();
    const occurredAt = new Date(Date.now() - 1_000).toISOString();
    const eventIds = Array.from({ length: SECURITY_AGENT_AUDIT_REPORT_PAGE_SIZE + 1 }, () =>
      randomUUID()
    );

    await db.insert(security_audit_log).values(
      eventIds.map(id => ({
        id,
        owned_by_user_id: owner.id,
        actor_type: SecurityAuditLogActorType.System,
        action: SecurityAuditLogAction.FindingCreated,
        resource_type: 'security_finding',
        resource_id: findingId,
        finding_id: findingId,
        occurred_at: occurredAt,
        finding_snapshot: findingSnapshot(findingId),
      }))
    );

    const report = await getSecurityAgentAuditReport({
      owner,
      input: { startDate: dateOnly(occurredAt), endDate: dateOnly(occurredAt) },
      isRequestingUserKiloAdmin: false,
    });
    const scannedEventIds = report.findings.flatMap(finding =>
      finding.events.map(event => event.id)
    );

    expect(report.summary.activityCount).toBe(SECURITY_AGENT_AUDIT_REPORT_PAGE_SIZE + 1);
    expect(scannedEventIds).toEqual([...eventIds].sort());
    expect(new Set(scannedEventIds).size).toBe(SECURITY_AGENT_AUDIT_REPORT_PAGE_SIZE + 1);
  }, 20_000);

  it('uses latest recorded state through cutoff without adding out-of-period events', async () => {
    const owner = await createIntegrationOwner();
    const fixedFindingId = randomUUID();
    const deletedFindingId = randomUUID();
    const fixedInitialEventId = randomUUID();
    const deletedInitialEventId = randomUUID();
    const fixedEventId = randomUUID();
    const deletedEventId = randomUUID();
    const inPeriodAt = new Date();
    inPeriodAt.setUTCDate(inPeriodAt.getUTCDate() - 2);
    inPeriodAt.setUTCHours(10, 0, 0, 0);
    const afterPeriodAt = new Date(inPeriodAt);
    afterPeriodAt.setUTCDate(afterPeriodAt.getUTCDate() + 1);
    const deadline = new Date(afterPeriodAt.getTime() + 60 * 60 * 1000).toISOString();

    await db.insert(security_audit_log).values([
      {
        id: fixedInitialEventId,
        owned_by_user_id: owner.id,
        actor_type: SecurityAuditLogActorType.System,
        action: SecurityAuditLogAction.FindingCreated,
        resource_type: 'security_finding',
        resource_id: fixedFindingId,
        finding_id: fixedFindingId,
        occurred_at: inPeriodAt.toISOString(),
        finding_snapshot: {
          ...findingSnapshot(fixedFindingId),
          fixed_at: null,
          sla_due_at: deadline,
        },
      },
      {
        id: deletedInitialEventId,
        owned_by_user_id: owner.id,
        actor_type: SecurityAuditLogActorType.System,
        action: SecurityAuditLogAction.FindingCreated,
        resource_type: 'security_finding',
        resource_id: deletedFindingId,
        finding_id: deletedFindingId,
        occurred_at: inPeriodAt.toISOString(),
        finding_snapshot: {
          ...findingSnapshot(deletedFindingId),
          fixed_at: null,
          sla_due_at: deadline,
        },
      },
      {
        id: fixedEventId,
        owned_by_user_id: owner.id,
        actor_type: SecurityAuditLogActorType.System,
        action: SecurityAuditLogAction.FindingStatusChange,
        resource_type: 'security_finding',
        resource_id: fixedFindingId,
        finding_id: fixedFindingId,
        occurred_at: afterPeriodAt.toISOString(),
        finding_snapshot: {
          ...findingSnapshot(fixedFindingId),
          status: 'fixed',
          fixed_at: afterPeriodAt.toISOString(),
          sla_due_at: deadline,
        },
      },
      {
        id: deletedEventId,
        owned_by_user_id: owner.id,
        actor_type: SecurityAuditLogActorType.System,
        action: SecurityAuditLogAction.FindingDeleted,
        resource_type: 'security_finding',
        resource_id: deletedFindingId,
        finding_id: deletedFindingId,
        occurred_at: afterPeriodAt.toISOString(),
        finding_snapshot: {
          ...findingSnapshot(deletedFindingId),
          fixed_at: null,
          sla_due_at: deadline,
        },
      },
    ]);

    const report = await getSecurityAgentAuditReport({
      owner,
      input: {
        startDate: dateOnly(inPeriodAt.toISOString()),
        endDate: dateOnly(inPeriodAt.toISOString()),
      },
      isRequestingUserKiloAdmin: false,
    });
    const fixedFinding = report.findings.find(finding => finding.findingId === fixedFindingId);
    const deletedFinding = report.findings.find(finding => finding.findingId === deletedFindingId);

    expect(report.summary.activityCount).toBe(2);
    expect(fixedFinding).toMatchObject({
      status: 'fixed',
      deleted: false,
      sla: {
        status: 'terminal_met',
        deadline,
        terminalAt: afterPeriodAt.toISOString(),
      },
    });
    expect(fixedFinding?.events.map(event => event.id)).toEqual([fixedInitialEventId]);
    expect(deletedFinding).toMatchObject({
      status: 'open',
      deleted: true,
      sla: {
        status: 'unknown',
        deadline,
        reason: 'deleted_without_terminal_timestamp',
      },
    });
    expect(deletedFinding?.events.map(event => event.id)).toEqual([deletedInitialEventId]);
  });

  it('excludes an event committed after its snapshot and includes it in a fresh report', async () => {
    const owner = await createIntegrationOwner();
    const findingId = randomUUID();
    const initialEventId = randomUUID();
    const lateEventId = randomUUID();
    const occurredAt = new Date(Date.now() - 1_000).toISOString();
    const input = { startDate: dateOnly(occurredAt), endDate: dateOnly(occurredAt) };

    await db.insert(security_audit_log).values({
      id: initialEventId,
      owned_by_user_id: owner.id,
      actor_type: SecurityAuditLogActorType.System,
      action: SecurityAuditLogAction.FindingCreated,
      resource_type: 'security_finding',
      resource_id: findingId,
      finding_id: findingId,
      occurred_at: occurredAt,
      finding_snapshot: findingSnapshot(findingId),
    });

    const lockClient = await pool.connect();
    let firstReportPromise: ReturnType<typeof getSecurityAgentAuditReport> | null = null;
    try {
      await lockClient.query('BEGIN');
      await lockClient.query('LOCK TABLE security_audit_log IN ACCESS EXCLUSIVE MODE');
      const pidResult = await lockClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const lockingPid = pidResult.rows[0]?.pid;
      if (lockingPid === undefined) throw new Error('Could not determine locking database process');

      await lockClient.query(
        `INSERT INTO security_audit_log (
          id,
          owned_by_user_id,
          actor_type,
          action,
          resource_type,
          resource_id,
          finding_id,
          occurred_at,
          finding_snapshot
        ) VALUES ($1, $2, $3, $4, 'security_finding', $5::text, $5::uuid, $6, $7::jsonb)`,
        [
          lateEventId,
          owner.id,
          SecurityAuditLogActorType.System,
          SecurityAuditLogAction.FindingCreated,
          findingId,
          occurredAt,
          JSON.stringify(findingSnapshot(findingId)),
        ]
      );

      firstReportPromise = getSecurityAgentAuditReport({
        owner,
        input,
        isRequestingUserKiloAdmin: false,
      });
      await waitForAuditReportReadBlockedBy(lockingPid);
      await lockClient.query('COMMIT');

      const firstReport = await firstReportPromise;
      const freshReport = await getSecurityAgentAuditReport({
        owner,
        input,
        isRequestingUserKiloAdmin: false,
      });
      const firstEventIds = firstReport.findings.flatMap(finding =>
        finding.events.map(event => event.id)
      );
      const freshEventIds = freshReport.findings.flatMap(finding =>
        finding.events.map(event => event.id)
      );

      expect(firstEventIds).toEqual([initialEventId]);
      expect(freshEventIds).toEqual([initialEventId, lateEventId].sort());
    } finally {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
      if (firstReportPromise) await firstReportPromise.catch(() => undefined);
    }
  }, 20_000);
});

describe('buildSecurityAgentAuditReportFromRows', () => {
  it('builds an empty report when no reportable activity exists', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Acme',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [],
    });

    expect(report.summary).toEqual({
      findingCount: 0,
      activityCount: 0,
      bySeverity: {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      },
      byAction: {},
    });
    expect(report.findings).toEqual([]);
  });

  it('groups events deterministically, masks internal actors, and labels legacy rows', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Acme',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          id: '00000000-0000-4000-8000-000000000003',
          action: SecurityAuditLogAction.FindingDismissed,
          actor_id: 'admin-user',
          actor_name: 'Ops User',
          actor_type: SecurityAuditLogActorType.KiloAdmin,
          after_state: { status: 'ignored', token: 'secret-token' },
          metadata: { reason_code: 'not_used', actor_email: 'ops@kilocode.ai' },
          occurred_at: '2026-06-02T10:00:00.000Z',
          effective_at: '2026-06-02T10:00:00.000Z',
          finding_snapshot: {
            finding_id: '11111111-1111-4111-8111-111111111111',
            source: 'dependabot',
            source_id: '42',
            repo_full_name: 'kilo/repo',
            title: 'Prototype Pollution in lodash',
            severity: 'high',
            status: 'ignored',
            fixed_at: '2026-06-07T08:00:00.000Z',
            sla_due_at: '2026-06-08T08:00:00.000Z',
          },
        }),
        row({
          id: '00000000-0000-4000-8000-000000000002',
          action: SecurityAuditLogAction.FindingCreated,
          occurred_at: '2026-06-01T10:00:00.000Z',
          effective_at: '2026-06-01T10:00:00.000Z',
        }),
        row({
          id: '00000000-0000-4000-8000-000000000004',
          action: SecurityAuditLogAction.FindingDismissed,
          finding_id: null,
          resource_id: '22222222-2222-4222-8222-222222222222',
          occurred_at: null,
          effective_at: '2026-06-03T10:00:00.000Z',
          finding_snapshot: null,
        }),
      ],
    });

    expect(report.summary).toMatchObject({
      findingCount: 2,
      activityCount: 3,
    });
    expect(report.findings[0].findingId).toBe('11111111-1111-4111-8111-111111111111');
    expect(report.findings[0].events.map(event => event.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ]);
    expect(report.findings[0].events[1].actor).toEqual({
      type: 'user',
      id: '00000000-0000-0000-0000-000000000000',
      displayName: 'Kilo Admin',
      masked: true,
    });
    expect(report.findings[0].events[1].afterState).toEqual({ status: 'ignored' });
    expect(report.findings[0].events[1].metadata).toEqual({ reason_code: 'not_used' });
    expect(report.findings[0].sla).toEqual({
      status: 'unknown',
      deadline: '2026-06-08T08:00:00.000Z',
      reason: 'ignored_or_superseded_without_terminal_time',
    });
    expect(report.findings[1]).toMatchObject({
      findingId: '22222222-2222-4222-8222-222222222222',
      title: 'Security Finding 22222222-2222-4222-8222-222222222222',
      hasLegacySupplementalActivity: true,
    });
    expect(report.hasLegacySupplementalActivity).toBe(true);
  });

  it('uses current finding metadata to describe legacy activity', () => {
    const legacyFindingId = '22222222-2222-4222-8222-222222222222';
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Acme',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          finding_id: null,
          resource_id: legacyFindingId,
          occurred_at: null,
          finding_snapshot: null,
        }),
      ],
      currentFindings: [
        {
          findingId: legacyFindingId,
          snapshot: {
            source: 'dependabot',
            source_id: '84',
            repo_full_name: 'kilo/cloud',
            title: 'Cross-origin request routing in undici',
            severity: 'high',
            status: 'ignored',
            package_name: 'undici',
            package_ecosystem: 'npm',
            manifest_path: 'pnpm-lock.yaml',
            patched_version: '7.28.0',
            first_detected_at: '2026-03-28T17:40:00.000Z',
          },
        },
      ],
    });

    expect(report.findings[0]).toMatchObject({
      findingId: legacyFindingId,
      source: 'dependabot',
      sourceId: '84',
      repository: 'kilo/cloud',
      title: 'Cross-origin request routing in undici',
      severity: 'high',
      status: 'ignored',
      packageName: 'undici',
      packageEcosystem: 'npm',
      manifestPath: 'pnpm-lock.yaml',
      patchedVersion: '7.28.0',
      firstDetectedAt: '2026-03-28T17:40:00.000Z',
      hasLegacySupplementalActivity: true,
    });
  });

  it('prefers recorded snapshots over current finding metadata', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Acme',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [row({})],
      currentFindings: [
        {
          findingId: '11111111-1111-4111-8111-111111111111',
          snapshot: {
            title: 'Current title',
            severity: 'low',
            repo_full_name: 'kilo/current',
          },
        },
      ],
    });

    expect(report.findings[0]).toMatchObject({
      title: 'Prototype Pollution in lodash',
      severity: 'high',
      repository: 'kilo/repo',
    });
  });

  it('masks actors from persisted classification', () => {
    const rows = [
      row({
        id: '00000000-0000-4000-8000-000000000011',
        actor_id: 'admin-user',
        actor_name: 'Internal Operator',
        actor_type: SecurityAuditLogActorType.KiloAdmin,
      }),
      row({
        id: '00000000-0000-4000-8000-000000000012',
        actor_id: 'customer-user',
        actor_name: 'Customer User',
        actor_type: SecurityAuditLogActorType.CustomerUser,
      }),
      row({
        id: '00000000-0000-4000-8000-000000000013',
        actor_id: 'legacy-user',
        actor_name: 'Legacy User',
        actor_type: null,
      }),
    ];
    const baseParams = {
      owner: {
        type: 'organization' as const,
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Acme',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      rows,
    };

    const customerReport = buildSecurityAgentAuditReportFromRows({
      ...baseParams,
      isRequestingUserKiloAdmin: false,
    });
    expect(customerReport.findings[0].events.map(event => event.actor)).toEqual([
      {
        type: 'user',
        id: '00000000-0000-0000-0000-000000000000',
        displayName: 'Kilo Admin',
        masked: true,
      },
      {
        type: 'user',
        id: 'customer-user',
        displayName: 'Customer User',
        masked: false,
      },
      {
        type: 'user',
        id: '00000000-0000-0000-0000-000000000000',
        displayName: 'Masked user',
        masked: true,
      },
    ]);

    const adminReport = buildSecurityAgentAuditReportFromRows({
      ...baseParams,
      isRequestingUserKiloAdmin: true,
    });
    expect(adminReport.findings[0].events[0].actor).toEqual({
      type: 'user',
      id: 'admin-user',
      displayName: 'Internal Operator',
      masked: false,
    });
    expect(adminReport.findings[0].events[2].actor).toEqual({
      type: 'user',
      id: 'legacy-user',
      displayName: 'Legacy User',
      masked: false,
    });
  });

  it('uses earlier recorded timeline evidence when a later legacy snapshot is sparse', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({}),
        row({
          id: '00000000-0000-4000-8000-000000000002',
          action: SecurityAuditLogAction.RemediationPrOpened,
          occurred_at: '2026-06-02T10:00:00.000Z',
          effective_at: '2026-06-02T10:00:00.000Z',
          finding_snapshot: {
            finding_id: '11111111-1111-4111-8111-111111111111',
            source: 'dependabot',
            source_id: '42',
            repo_full_name: 'kilo/repo',
            title: 'Prototype Pollution in lodash',
            severity: 'high',
            status: 'open',
          },
        }),
      ],
    });

    expect(report.findings[0].firstDetectedAt).toBe('2026-06-01T08:00:00.000Z');
    expect(report.findings[0].sla).toEqual({
      status: 'open_past_deadline',
      deadline: '2026-06-08T08:00:00.000Z',
      terminalAt: null,
    });
  });

  it('treats terminal timestamp equality as missed SLA evidence', () => {
    const deadline = '2026-06-08T08:00:00.000Z';
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          finding_snapshot: {
            ...(row({}).finding_snapshot ?? {}),
            status: 'fixed',
            fixed_at: deadline,
            sla_due_at: deadline,
          },
        }),
      ],
    });

    expect(report.findings[0].sla).toEqual({
      status: 'terminal_missed',
      deadline,
      terminalAt: deadline,
    });
  });

  it('treats report cutoff equality as past-deadline SLA evidence', () => {
    const deadline = '2026-06-08T08:00:00.000Z';
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: deadline,
      dataThrough: deadline,
      isRequestingUserKiloAdmin: false,
      rows: [row({})],
    });

    expect(report.findings[0].sla).toEqual({
      status: 'open_past_deadline',
      deadline,
      terminalAt: null,
    });
  });

  it('does not classify a deleted finding as open without a terminal timestamp', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          action: SecurityAuditLogAction.FindingDeleted,
          after_state: { deleted: true },
        }),
      ],
    });

    expect(report.findings[0]).toMatchObject({
      deleted: true,
      sla: {
        status: 'unknown',
        deadline: '2026-06-08T08:00:00.000Z',
        reason: 'deleted_without_terminal_timestamp',
      },
    });
  });

  it('preserves terminal SLA evidence when a fixed finding is later deleted', () => {
    const deadline = '2026-06-08T08:00:00.000Z';
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          action: SecurityAuditLogAction.FindingDeleted,
          after_state: { deleted: true },
          finding_snapshot: {
            ...(row({}).finding_snapshot ?? {}),
            status: 'fixed',
            fixed_at: deadline,
            sla_due_at: deadline,
          },
        }),
      ],
    });

    expect(report.findings[0]).toMatchObject({
      deleted: true,
      sla: {
        status: 'terminal_missed',
        deadline,
        terminalAt: deadline,
      },
    });
  });

  it('does not reuse an earlier SLA deadline after a later snapshot records no deadline', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({}),
        row({
          id: '00000000-0000-4000-8000-000000000002',
          action: SecurityAuditLogAction.RemediationPrOpened,
          occurred_at: '2026-06-02T10:00:00.000Z',
          effective_at: '2026-06-02T10:00:00.000Z',
          finding_snapshot: {
            finding_id: '11111111-1111-4111-8111-111111111111',
            source: 'dependabot',
            source_id: '42',
            repo_full_name: 'kilo/repo',
            title: 'Prototype Pollution in lodash',
            severity: 'high',
            status: 'open',
            first_detected_at: '2026-06-01T08:00:00.000Z',
            fixed_at: null,
            sla_due_at: null,
          },
        }),
      ],
    });

    expect(report.findings[0].sla).toEqual({
      status: 'unknown',
      deadline: null,
      reason: 'missing_recorded_deadline',
    });
  });

  it('publishes structured extraction status without raw analysis content', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          action: SecurityAuditLogAction.FindingAnalysisCompleted,
          after_state: {
            analysis_status: 'completed',
            structured_extraction_status: 'failed',
            suggested_action: 'manual_review',
            raw_markdown: '# Sensitive raw analysis',
          },
          metadata: {
            model_slug: 'analysis/model',
          },
        }),
      ],
    });

    expect(report.findings[0].events[0]).toMatchObject({
      afterState: {
        analysis_status: 'completed',
        structured_extraction_status: 'failed',
        suggested_action: 'manual_review',
      },
      metadata: null,
    });
    expect(report.findings[0].events[0].afterState).not.toHaveProperty('raw_markdown');
  });

  it('publishes user-facing evidence while omitting internal remediation identifiers', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'user',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Ada',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          action: SecurityAuditLogAction.RemediationQueued,
          actor_id: '4d857fd4-70b3-48a2-9130-45873d3051c4',
          actor_type: SecurityAuditLogActorType.CustomerUser,
          after_state: {
            remediation_status: 'queued',
            attempt_number: 1,
            remediation_id: '3ade7a41-97de-4089-a331-2a6f3e5ad448',
          },
          metadata: {
            origin: 'manual',
            attempt_id: '7b04b2bc-07c2-4252-bf9f-4dffe03cc7cb',
            branch_name: 'security-remediation/internal-branch',
            remediation_model_slug: 'kilo-auto/balanced',
          },
        }),
      ],
    });

    expect(report.findings[0].events[0]).toMatchObject({
      actor: {
        type: 'user',
        displayName: 'Kilo user',
      },
      afterState: {
        remediation_status: 'queued',
        attempt_number: 1,
      },
      metadata: {
        origin: 'manual',
      },
    });
    expect(report.findings[0].events[0].afterState).not.toHaveProperty('remediation_id');
    expect(report.findings[0].events[0].metadata).not.toHaveProperty('attempt_id');
    expect(report.findings[0].events[0].metadata).not.toHaveProperty('branch_name');
    expect(report.findings[0].events[0].metadata).not.toHaveProperty('remediation_model_slug');
  });

  it('builds a max-event report under the serialized byte budget without truncation', () => {
    const rows = Array.from({ length: SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS }, (_, index) => {
      const occurredAt = new Date(Date.UTC(2026, 5, 1, 0, 0, index)).toISOString();
      return row({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        action:
          index % 2 === 0
            ? SecurityAuditLogAction.FindingCreated
            : SecurityAuditLogAction.FindingStatusChange,
        before_state: index % 2 === 0 ? null : { status: 'open' },
        after_state: index % 2 === 0 ? { status: 'open' } : { status: 'fixed' },
        metadata: { reason_code: 'load_test' },
        occurred_at: occurredAt,
        effective_at: occurredAt,
      });
    });

    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Acme',
      },
      period,
      generatedAt: '2026-06-12T15:00:00.000Z',
      dataThrough: '2026-06-12T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows,
    });

    expect(report.summary.activityCount).toBe(SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS);
    expect(report.findings[0].events).toHaveLength(SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS);
    expect(securityAgentAuditReportSerializedByteLength(report)).toBeLessThanOrEqual(
      SECURITY_AGENT_AUDIT_REPORT_MAX_SERIALIZED_BYTES
    );
    expect(() => assertSecurityAgentAuditReportSerializedByteBudget(report)).not.toThrow();
  });

  it('does not classify ignored or superseded findings as open SLA states', () => {
    const report = buildSecurityAgentAuditReportFromRows({
      owner: {
        type: 'organization',
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        displayName: 'Acme',
      },
      period,
      generatedAt: '2026-06-02T15:00:00.000Z',
      dataThrough: '2026-06-02T15:00:00.000Z',
      isRequestingUserKiloAdmin: false,
      rows: [
        row({
          action: SecurityAuditLogAction.FindingSuperseded,
          occurred_at: '2026-06-02T10:00:00.000Z',
          effective_at: '2026-06-02T10:00:00.000Z',
          finding_snapshot: {
            finding_id: '11111111-1111-4111-8111-111111111111',
            source: 'dependabot',
            source_id: '42',
            repo_full_name: 'kilo/repo',
            title: 'Prototype Pollution in lodash',
            severity: 'high',
            status: 'ignored',
            sla_due_at: '2026-06-08T08:00:00.000Z',
            canonical_finding_id: '22222222-2222-4222-8222-222222222222',
          },
        }),
      ],
    });

    expect(report.findings[0].sla).toEqual({
      status: 'unknown',
      deadline: '2026-06-08T08:00:00.000Z',
      reason: 'ignored_or_superseded_without_terminal_time',
    });
  });
});

describe('securityAgentAuditReportEventCountBucket', () => {
  it('returns stable non-PII telemetry buckets', () => {
    expect(securityAgentAuditReportEventCountBucket(null)).toBe('unknown');
    expect(securityAgentAuditReportEventCountBucket(0)).toBe('0');
    expect(securityAgentAuditReportEventCountBucket(99)).toBe('1-99');
    expect(securityAgentAuditReportEventCountBucket(999)).toBe('100-999');
    expect(securityAgentAuditReportEventCountBucket(4_999)).toBe('1000-4999');
    expect(securityAgentAuditReportEventCountBucket(10_000)).toBe('5000-10000');
    expect(securityAgentAuditReportEventCountBucket(10_001)).toBe('over-budget');
  });
});

describe('withSecurityAgentAuditReportTimeout', () => {
  it('fails with report query error and stage when budget expires', async () => {
    await expect(
      withSecurityAgentAuditReportTimeout(new Promise(() => {}), 1, 'scan')
    ).rejects.toMatchObject({
      name: 'SecurityAgentAuditReportQueryError',
      message: 'Report query did not finish',
      stage: 'scan',
    });
  });

  it('returns resolved value before budget expires', async () => {
    await expect(
      withSecurityAgentAuditReportTimeout(Promise.resolve('ok'), 50, 'scan')
    ).resolves.toBe('ok');
  });

  it('preserves exported error type for timeout callers', () => {
    expect(new SecurityAgentAuditReportQueryError('x', 'request').stage).toBe('request');
  });
});
