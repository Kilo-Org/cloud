import { describe, expect, it } from '@jest/globals';
import { SecurityAuditLogAction } from '@kilocode/db/schema-types';
import {
  assertSecurityAgentAuditReportSerializedByteBudget,
  buildSecurityAgentAuditReportFromRows,
  normalizeSecurityAgentAuditReportPeriod,
  SECURITY_AGENT_AUDIT_REPORT_MAX_EVENTS,
  SECURITY_AGENT_AUDIT_REPORT_MAX_SERIALIZED_BYTES,
  securityAgentAuditReportSerializedByteLength,
  securityAgentAuditReportEventCountBucket,
  SecurityAgentAuditReportQueryError,
  withSecurityAgentAuditReportTimeout,
} from './security-audit-report';

type AuditReportRow = Parameters<typeof buildSecurityAgentAuditReportFromRows>[0]['rows'][number];

const period = normalizeSecurityAgentAuditReportPeriod(
  { startDate: '2026-06-01', endDate: '2026-06-12' },
  new Date('2026-06-12T15:00:00.000Z')
);

function row(overrides: Partial<AuditReportRow>): AuditReportRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    action: SecurityAuditLogAction.FindingCreated,
    actor_id: null,
    actor_email: null,
    actor_name: null,
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
          actor_email: 'ops@kilocode.ai',
          actor_name: 'Ops User',
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
    expect(report.findings[0].sla.status).toBe('terminal_met');
    expect(report.findings[1]).toMatchObject({
      findingId: '22222222-2222-4222-8222-222222222222',
      title: 'Legacy Security Finding',
      hasLegacySupplementalActivity: true,
    });
    expect(report.hasLegacySupplementalActivity).toBe(true);
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
