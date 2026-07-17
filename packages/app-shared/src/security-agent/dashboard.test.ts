import { describe, expect, it } from 'vitest';

import { buildSecurityDashboardMetrics, type DashboardStats } from './dashboard';

function makeStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    sla: {
      overall: { total: 10, withinSla: 7, overdue: 3 },
      bySeverity: {
        critical: { overdue: 1 },
        high: { overdue: 1 },
      },
      dueSoon: { total: 4, exploitable: 2 },
      untrackedCount: 5,
    },
    severity: { critical: 2, high: 3 },
    analysis: {
      total: 10,
      exploitable: 2,
      needsReview: 3,
      triageComplete: 1,
      analyzing: 1,
      notAnalyzed: 1,
      failed: 1,
    },
    ...overrides,
  } satisfies DashboardStats;
}

describe('buildSecurityDashboardMetrics', () => {
  it('builds severity-based metrics when SLA tracking is disabled', () => {
    const data = makeStats();

    expect(buildSecurityDashboardMetrics(data, false)).toEqual([
      {
        id: 'openFindings',
        label: 'Open findings',
        value: '10',
        detail: '2 critical, 3 high',
        tone: 'danger',
      },
      {
        id: 'exploitable',
        label: 'Confirmed exploitable',
        value: '2',
        detail: 'Project risk confirmed by analysis',
        tone: 'danger',
      },
      {
        id: 'needsReview',
        label: 'Needs your review',
        value: '3',
        detail: 'Human decision required',
        tone: 'warning',
      },
      {
        id: 'analysisIncomplete',
        label: 'Analysis not complete',
        // triageComplete(1) + analyzing(1) + notAnalyzed(1) + failed(1)
        value: '4',
        detail: 'Project risk still unknown',
        tone: 'neutral',
      },
    ]);
  });

  it('builds SLA-based metrics when SLA tracking is enabled', () => {
    const data = makeStats();

    expect(buildSecurityDashboardMetrics(data, true)).toEqual([
      {
        id: 'slaCompliance',
        label: 'SLA compliance',
        // round(7 / 10 * 100)
        value: '70%',
        detail: '7 of 10 within deadline',
        tone: 'warning',
      },
      {
        id: 'deadlinePassed',
        label: 'Deadline passed',
        value: '3',
        detail: '1 critical, 1 high',
        tone: 'danger',
      },
      {
        id: 'dueSoon',
        label: 'Due this week',
        value: '4',
        detail: '2 confirmed exploitable',
        tone: 'warning',
      },
      {
        id: 'noDeadline',
        label: 'No deadline',
        value: '5',
        detail: 'Review SLA assignment',
        tone: 'neutral',
      },
    ]);
  });

  it('reports "Not measured" instead of dividing by zero when there are no SLA-tracked findings', () => {
    const data = makeStats({
      sla: {
        overall: { total: 0, withinSla: 0, overdue: 0 },
        bySeverity: {
          critical: { overdue: 0 },
          high: { overdue: 0 },
        },
        dueSoon: { total: 0, exploitable: 0 },
        untrackedCount: 0,
      },
    });

    const [complianceMetric] = buildSecurityDashboardMetrics(data, true);
    expect(complianceMetric).toEqual({
      id: 'slaCompliance',
      label: 'SLA compliance',
      value: 'Not measured',
      detail: 'No findings with an SLA deadline yet',
      tone: 'neutral',
    });
  });
});
