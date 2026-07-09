import { describe, expect, it } from '@jest/globals';
import type {
  SecurityAgentAuditReport,
  SecurityAgentAuditReportEvent,
  SecurityFindingAuditSection,
} from '@/lib/security-agent/db/security-audit-report';
import {
  auditReportControlsReducer,
  buildAuditReportSearchParams,
  createAuditReportControlsState,
  filterSecurityAgentAuditReport,
  formatAuditEventTime,
  formatDateTime24Hour,
  getAuditEventDetails,
  getDefaultAuditReportDateRange,
  getAuditReportRepositoryHref,
  getAuditReportRepositoryOptions,
  hasSecurityAgentAuditReportOwnerContext,
  normalizeAuditReportRepositoryFilter,
  parseAuditReportFilters,
} from './SecurityAuditReportPage';

function finding(
  overrides: Partial<SecurityFindingAuditSection> &
    Pick<SecurityFindingAuditSection, 'findingId' | 'severity' | 'status'>
): SecurityFindingAuditSection {
  return {
    source: 'dependabot',
    sourceId: '1',
    repository: 'kilo/repo',
    title: 'Test finding',
    packageName: 'test-package',
    packageEcosystem: 'npm',
    manifestPath: 'package.json',
    patchedVersion: null,
    ghsaId: null,
    cveId: null,
    cweIds: [],
    cvssScore: null,
    dependabotUrl: null,
    firstDetectedAt: '2026-06-01T00:00:00.000Z',
    canonicalFindingId: null,
    deleted: false,
    sla: { status: 'unknown', deadline: null, reason: 'not recorded' },
    events: [],
    hasLegacySupplementalActivity: false,
    ...overrides,
  };
}

function event(
  overrides: Partial<SecurityAgentAuditReportEvent> & Pick<SecurityAgentAuditReportEvent, 'action'>
): SecurityAgentAuditReportEvent {
  return {
    id: 'event-1',
    label: 'Event',
    occurredAt: '2026-06-15T16:04:00.000Z',
    sourceOccurredAt: null,
    recordedAt: '2026-06-15T16:04:00.000Z',
    actor: { type: 'system', displayName: 'Kilo system', masked: false },
    beforeState: null,
    afterState: null,
    metadata: null,
    legacySupplemental: false,
    ...overrides,
  };
}

function report(findings: SecurityFindingAuditSection[]): SecurityAgentAuditReport {
  return {
    reportVersion: 1,
    owner: { type: 'user', id: 'user-1', displayName: 'Test User' },
    period: {
      start: '2026-06-01T00:00:00.000Z',
      endExclusive: '2026-06-16T00:00:00.000Z',
      displayEnd: '2026-06-15',
      timeZone: 'UTC',
    },
    generatedAt: '2026-06-16T00:00:00.000Z',
    dataThrough: '2026-06-16T00:00:00.000Z',
    reliableCoverageStart: '2026-06-12T00:00:00.000Z',
    evidenceBasis: 'recorded_by_kilo',
    hasLegacySupplementalActivity: true,
    summary: {
      findingCount: findings.length,
      activityCount: findings.reduce((count, item) => count + item.events.length, 0),
      bySeverity: { critical: 0, high: 2, medium: 0, low: 1 },
      byAction: {},
    },
    findings,
  };
}

describe('audit report date range', () => {
  it('defaults to 90 UTC calendar days ending on the current day', () => {
    expect(getDefaultAuditReportDateRange(new Date('2026-06-16T21:08:07+02:00'))).toEqual({
      startDate: '2026-03-19',
      endDate: '2026-06-16',
    });
  });
});

describe('audit report owner context', () => {
  it('allows personal reports and gates organization reports only on organization context', () => {
    expect(hasSecurityAgentAuditReportOwnerContext(false, undefined)).toBe(true);
    expect(hasSecurityAgentAuditReportOwnerContext(true, 'org-1')).toBe(true);
    expect(hasSecurityAgentAuditReportOwnerContext(true, undefined)).toBe(false);
  });
});

describe('audit report control state', () => {
  it('submits a complete draft range and normalized filters in one transition', () => {
    const state = createAuditReportControlsState({
      initialRange: { startDate: '2026-03-19', endDate: '2026-06-16' },
      initialFilters: { severity: 'all', state: 'all', repository: null },
    });
    const submittedRange = { startDate: '2026-05-01', endDate: '2026-05-31' };
    const submittedFilters = {
      severity: 'high',
      state: 'ignored',
      repository: 'kilo/web',
    } as const;

    const nextState = auditReportControlsReducer(state, {
      type: 'submit-report',
      range: submittedRange,
      filters: submittedFilters,
    });

    expect(nextState.submittedRange).toBe(submittedRange);
    expect(nextState.draftFilters).toBe(submittedFilters);
    expect(nextState.submittedFilters).toBe(submittedFilters);
    expect(nextState.draftRange).toBe(state.draftRange);
    expect(nextState.isRangePickerOpen).toBe(false);
  });

  it('keeps the date picker open while selecting a complete range', () => {
    const initialState = createAuditReportControlsState({
      initialRange: { startDate: '2026-03-19', endDate: '2026-06-16' },
      initialFilters: { severity: 'all', state: 'all', repository: null },
    });
    const openState = auditReportControlsReducer(initialState, {
      type: 'set-range-picker-open',
      open: true,
    });
    const startSelectedState = auditReportControlsReducer(openState, {
      type: 'select-range-start',
      date: new Date(2026, 4, 1),
    });
    const completeRangeState = auditReportControlsReducer(startSelectedState, {
      type: 'select-range-end',
      range: { from: new Date(2026, 4, 1), to: new Date(2026, 4, 31) },
    });

    expect(startSelectedState).toMatchObject({
      isRangePickerOpen: true,
      isSelectingRangeEnd: true,
      draftRange: { from: new Date(2026, 4, 1) },
    });
    expect(completeRangeState.isRangePickerOpen).toBe(true);
    expect(completeRangeState.isSelectingRangeEnd).toBe(false);
    expect(completeRangeState.draftRange).toEqual({
      from: new Date(2026, 4, 1),
      to: new Date(2026, 4, 31),
    });
  });

  it('synchronizes submitted controls when browser navigation changes the URL', () => {
    const state = createAuditReportControlsState({
      initialRange: { startDate: '2026-03-19', endDate: '2026-06-16' },
      initialFilters: { severity: 'all', state: 'all', repository: null },
    });

    const nextState = auditReportControlsReducer(state, {
      type: 'sync-from-url',
      range: { startDate: '2026-05-01', endDate: '2026-05-31' },
      filters: { severity: 'critical', state: 'open', repository: 'kilo/web' },
    });

    expect(nextState.submittedRange).toEqual({
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(nextState.draftRange).toEqual({
      from: new Date(2026, 4, 1),
      to: new Date(2026, 4, 31),
    });
    expect(nextState.draftFilters).toEqual({
      severity: 'critical',
      state: 'open',
      repository: 'kilo/web',
    });
    expect(nextState.submittedFilters).toEqual(nextState.draftFilters);
  });
});

describe('audit report filters', () => {
  it('parses supported URL filters and defaults unsupported values to all', () => {
    expect(
      parseAuditReportFilters(
        new URLSearchParams('severity=high&state=ignored&repoFullName=kilo%2Fweb')
      )
    ).toEqual({
      severity: 'high',
      state: 'ignored',
      repository: 'kilo/web',
    });
    expect(parseAuditReportFilters(new URLSearchParams('severity=unknown&state=deleted'))).toEqual({
      severity: 'all',
      state: 'deleted',
      repository: null,
    });
    expect(parseAuditReportFilters(new URLSearchParams('state=closed'))).toEqual({
      severity: 'all',
      state: 'all',
      repository: null,
    });
  });

  it('writes submitted range and filters to shareable URL parameters', () => {
    expect(
      buildAuditReportSearchParams(
        'unrelated=preserved&severity=low',
        { startDate: '2026-05-01', endDate: '2026-05-31' },
        { severity: 'high', state: 'ignored', repository: 'kilo/web' }
      )
    ).toBe(
      'unrelated=preserved&severity=high&startDate=2026-05-01&endDate=2026-05-31&state=ignored&repoFullName=kilo%2Fweb'
    );

    expect(
      buildAuditReportSearchParams(
        'severity=high&state=ignored&repoFullName=kilo%2Fweb',
        { startDate: '2026-06-01', endDate: '2026-06-16' },
        { severity: 'all', state: 'all', repository: null }
      )
    ).toBe('startDate=2026-06-01&endDate=2026-06-16');
  });

  it('filters finding groups by severity, state, and repository while preserving complete timelines', () => {
    const input = report([
      finding({
        findingId: 'high-open',
        severity: 'high',
        status: 'open',
        events: [
          {
            id: 'event-1',
            action: 'security.finding.created',
          } as SecurityFindingAuditSection['events'][number],
        ],
      }),
      finding({
        findingId: 'high-dismissed',
        severity: 'high',
        status: 'ignored',
        repository: 'kilo/web',
        events: [
          {
            id: 'event-2',
            action: 'security.finding.created',
          } as SecurityFindingAuditSection['events'][number],
          {
            id: 'event-3',
            action: 'security.finding.dismissed',
          } as SecurityFindingAuditSection['events'][number],
        ],
        hasLegacySupplementalActivity: true,
      }),
      finding({
        findingId: 'high-dismissed-other-repository',
        severity: 'high',
        status: 'ignored',
        repository: 'kilo/api',
        events: [
          {
            id: 'event-other-repository',
            action: 'security.finding.dismissed',
          } as SecurityFindingAuditSection['events'][number],
        ],
      }),
      finding({
        findingId: 'low-dismissed',
        severity: 'low',
        status: 'ignored',
        repository: 'kilo/web',
        events: [
          {
            id: 'event-4',
            action: 'security.finding.dismissed',
          } as SecurityFindingAuditSection['events'][number],
        ],
      }),
    ]);

    const filtered = filterSecurityAgentAuditReport(input, {
      severity: 'high',
      state: 'ignored',
      repository: 'kilo/web',
    });

    expect(filtered.findings.map(item => item.findingId)).toEqual(['high-dismissed']);
    expect(filtered.findings[0]?.events).toHaveLength(2);
    expect(filtered.summary).toEqual({
      findingCount: 1,
      activityCount: 2,
      bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
      byAction: {
        'security.finding.created': 1,
        'security.finding.dismissed': 1,
      },
    });
    expect(filtered.hasLegacySupplementalActivity).toBe(true);
  });

  it('filters deleted and superseded finding evidence by displayed state', () => {
    const input = report([
      finding({
        findingId: 'deleted',
        severity: 'low',
        status: 'ignored',
        deleted: true,
      }),
      finding({
        findingId: 'superseded',
        severity: 'high',
        status: 'ignored',
        canonicalFindingId: 'current-finding',
      }),
      finding({ findingId: 'dismissed', severity: 'high', status: 'ignored' }),
    ]);

    expect(
      filterSecurityAgentAuditReport(input, {
        severity: 'all',
        state: 'deleted',
        repository: null,
      }).findings.map(item => item.findingId)
    ).toEqual(['deleted']);
    expect(
      filterSecurityAgentAuditReport(input, {
        severity: 'all',
        state: 'superseded',
        repository: null,
      }).findings.map(item => item.findingId)
    ).toEqual(['superseded']);
    expect(
      filterSecurityAgentAuditReport(input, {
        severity: 'all',
        state: 'ignored',
        repository: null,
      }).findings.map(item => item.findingId)
    ).toEqual(['dismissed']);
  });

  it('keeps report unchanged when all values are selected', () => {
    const input = report([]);
    expect(
      filterSecurityAgentAuditReport(input, {
        severity: 'all',
        state: 'all',
        repository: null,
      })
    ).toBe(input);
  });

  it('builds safe GitHub links for recorded repository names', () => {
    expect(getAuditReportRepositoryHref('Kilo-Org/security-agent')).toBe(
      'https://github.com/Kilo-Org/security-agent'
    );
    expect(getAuditReportRepositoryHref('invalid/repository/path')).toBeNull();
    expect(getAuditReportRepositoryHref('owner/repository?tab=settings')).toBeNull();
    expect(getAuditReportRepositoryHref(null)).toBeNull();
  });

  it('builds sorted repository options only from report evidence', () => {
    const findings = [
      finding({ findingId: '2', severity: 'high', status: 'open', repository: 'kilo/web' }),
      finding({ findingId: '1', severity: 'low', status: 'fixed', repository: 'kilo/api' }),
      finding({ findingId: '3', severity: 'low', status: 'fixed', repository: 'kilo/web' }),
      finding({ findingId: '4', severity: 'low', status: null, repository: null }),
    ];

    expect(getAuditReportRepositoryOptions(findings)).toEqual(['kilo/api', 'kilo/web']);
  });

  it('normalizes stale repository filters once report evidence is available', () => {
    const staleFilters = {
      severity: 'high',
      state: 'open',
      repository: 'legacy/renamed',
    } as const;
    const validFilters = { ...staleFilters, repository: 'kilo/web' };

    expect(normalizeAuditReportRepositoryFilter(staleFilters, ['kilo/api', 'kilo/web'])).toEqual({
      severity: 'high',
      state: 'open',
      repository: null,
    });
    expect(normalizeAuditReportRepositoryFilter(validFilters, ['kilo/api', 'kilo/web'])).toBe(
      validFilters
    );
  });
});

describe('audit report event presentation', () => {
  it('formats event time as 24-hour UTC', () => {
    expect(formatAuditEventTime('2026-06-15T16:04:00.000Z')).toBe('16:04 UTC');
  });

  it('formats SLA deadlines as 24-hour UTC without AM or PM', () => {
    expect(formatDateTime24Hour('2026-03-19T16:04:00.000Z')).toBe('Mar 19, 2026, 16:04 UTC');
  });

  it('describes not-used dismissals without claiming the dependency is absent', () => {
    const details = getAuditEventDetails(
      event({
        action: 'security.finding.auto_dismissed' as SecurityAgentAuditReportEvent['action'],
        beforeState: { status: 'open' },
        afterState: { status: 'ignored', reason_code: 'not_used' },
      })
    );

    expect(details).toEqual([
      { label: 'State', value: 'Dismissed', previousValue: 'Open' },
      { label: 'Reason', value: 'Vulnerable code is not used' },
    ]);
  });

  it('presents successful structured analysis without unrelated triage confidence', () => {
    const details = getAuditEventDetails(
      event({
        action: 'security.finding.analysis_completed' as SecurityAgentAuditReportEvent['action'],
        afterState: {
          analysis_status: 'completed',
          structured_extraction_status: 'succeeded',
          is_exploitable: false,
          suggested_action: 'dismiss',
          confidence: 'low',
        },
      })
    );

    expect(details).toEqual([
      { label: 'Exploitability', value: 'Not exploitable' },
      { label: 'Recommended next step', value: 'Dismiss finding' },
    ]);
  });

  it('presents a structured extraction failure without claiming an exploitability result', () => {
    const details = getAuditEventDetails(
      event({
        action: 'security.finding.analysis_completed' as SecurityAgentAuditReportEvent['action'],
        afterState: {
          analysis_status: 'completed',
          structured_extraction_status: 'failed',
          is_exploitable: 'unknown',
          suggested_action: 'manual_review',
          confidence: 'low',
        },
      })
    );

    expect(details).toEqual([
      { label: 'Structured result', value: 'Unavailable' },
      { label: 'Recommended next step', value: 'Manual review' },
    ]);
  });

  it('presents remediation requests without raw state and evidence groups', () => {
    const details = getAuditEventDetails(
      event({
        action: 'security.remediation.queued' as SecurityAgentAuditReportEvent['action'],
        afterState: { remediation_status: 'queued', attempt_number: 1 },
        metadata: { origin: 'manual' },
      })
    );

    expect(details).toEqual([
      { label: 'Attempt', value: '1' },
      { label: 'Requested', value: 'Manually' },
    ]);
  });

  it('presents pull request outcomes with one safe link and useful status', () => {
    const details = getAuditEventDetails(
      event({
        action: 'security.remediation.pr_opened' as SecurityAgentAuditReportEvent['action'],
        beforeState: { remediation_status: 'running' },
        afterState: { remediation_status: 'pr_opened', pr_number: 5, pr_draft: false },
        metadata: {
          origin: 'manual',
          pr_url: 'https://github.com/kilo/repo/pull/5',
          validation_count: 1,
        },
      })
    );

    expect(details).toEqual([
      {
        label: 'Pull request',
        value: '#5',
        href: 'https://github.com/kilo/repo/pull/5',
      },
      { label: 'Review state', value: 'Ready for review' },
      { label: 'Validation checks', value: '1' },
    ]);
  });
});
