import { describe, expect, it } from 'vitest';

import { buildSecurityDashboardMetrics, type DashboardStats } from '@/lib/security-agent-dashboard';

function makeStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    sla: {
      overall: { total: 10, withinSla: 7, overdue: 3 },
      bySeverity: {
        critical: { total: 2, withinSla: 1, overdue: 1 },
        high: { total: 3, withinSla: 2, overdue: 1 },
        medium: { total: 3, withinSla: 3, overdue: 0 },
        low: { total: 2, withinSla: 1, overdue: 1 },
      },
      dueSoon: { total: 4, exploitable: 2 },
      untrackedCount: 5,
    },
    severity: { critical: 2, high: 3, medium: 3, low: 2 },
    status: { open: 10, fixed: 4, ignored: 1 },
    analysis: {
      total: 10,
      analyzed: 6,
      exploitable: 2,
      notExploitable: 4,
      triageComplete: 1,
      safeToDismiss: 1,
      needsReview: 3,
      analyzing: 1,
      notAnalyzed: 1,
      failed: 1,
    },
    mttr: {
      bySeverity: {
        critical: { avgDays: null, medianDays: null, count: 0, slaDays: 15 },
        high: { avgDays: null, medianDays: null, count: 0, slaDays: 30 },
        medium: { avgDays: null, medianDays: null, count: 0, slaDays: 45 },
        low: { avgDays: null, medianDays: null, count: 0, slaDays: 90 },
      },
    },
    overdue: [],
    priorityFinding: null,
    repoHealth: [],
    repositoryCount: 3,
    ...overrides,
  } satisfies DashboardStats;
}

describe('buildSecurityDashboardMetrics', () => {
  it('builds severity-based metrics when SLA tracking is disabled', () => {
    const data = makeStats();

    expect(buildSecurityDashboardMetrics(data, false)).toEqual([
      {
        label: 'Open findings',
        value: '10',
        detail: '2 critical, 3 high',
        tone: 'danger',
      },
      {
        label: 'Confirmed exploitable',
        value: '2',
        detail: 'Project risk confirmed by analysis',
        tone: 'danger',
      },
      {
        label: 'Needs your review',
        value: '3',
        detail: 'Human decision required',
        tone: 'warning',
      },
      {
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
        label: 'SLA compliance',
        // round(7 / 10 * 100)
        value: '70%',
        detail: '7 of 10 within deadline',
        tone: 'warning',
      },
      {
        label: 'Deadline passed',
        value: '3',
        detail: '1 critical, 1 high',
        tone: 'danger',
      },
      {
        label: 'Due this week',
        value: '4',
        detail: '2 confirmed exploitable',
        tone: 'warning',
      },
      {
        label: 'No deadline',
        value: '5',
        detail: 'Review SLA assignment',
        tone: 'neutral',
      },
    ]);
  });

  it('reports 100% SLA compliance instead of dividing by zero when there are no findings', () => {
    const data = makeStats({
      sla: {
        overall: { total: 0, withinSla: 0, overdue: 0 },
        bySeverity: {
          critical: { total: 0, withinSla: 0, overdue: 0 },
          high: { total: 0, withinSla: 0, overdue: 0 },
          medium: { total: 0, withinSla: 0, overdue: 0 },
          low: { total: 0, withinSla: 0, overdue: 0 },
        },
        dueSoon: { total: 0, exploitable: 0 },
        untrackedCount: 0,
      },
    });

    const [complianceMetric] = buildSecurityDashboardMetrics(data, true);
    expect(complianceMetric).toEqual({
      label: 'SLA compliance',
      value: '100%',
      detail: 'No assigned deadlines',
      tone: 'neutral',
    });
  });
});
