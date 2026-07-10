// Structural shape of the `securityAgent.getDashboardStats` tRPC output —
// only the fields this module reads. Verified against
// apps/web/src/lib/security-agent/db/dashboard-stats.ts' DashboardStats
// return type, which mobile's tRPC output mirrors.
export type DashboardStats = {
  analysis: {
    total: number;
    exploitable: number;
    needsReview: number;
    triageComplete: number;
    analyzing: number;
    notAnalyzed: number;
    failed: number;
  };
  severity: {
    critical: number;
    high: number;
  };
  sla: {
    overall: { total: number; withinSla: number; overdue: number };
    bySeverity: {
      critical: { overdue: number };
      high: { overdue: number };
    };
    dueSoon: { total: number; exploitable: number };
    untrackedCount: number;
  };
};

export type DashboardMetricTone = 'danger' | 'warning' | 'neutral';

// Stable identifiers so consumers can attach presentation (e.g. web's icon
// per metric) without depending on array order. Named `id`, not `key`, so
// spreading a metric into JSX doesn't collide with React's reserved prop.
export type DashboardMetricKey =
  | 'openFindings'
  | 'exploitable'
  | 'needsReview'
  | 'analysisIncomplete'
  | 'slaCompliance'
  | 'deadlinePassed'
  | 'dueSoon'
  | 'noDeadline';

type DashboardMetric = {
  id: DashboardMetricKey;
  label: string;
  value: string;
  detail: string;
  tone: DashboardMetricTone;
};

// Ported from apps/web/src/components/security-agent/SecurityDashboard.tsx:110
export function getAnalysisIncompleteCount(analysis: DashboardStats['analysis']): number {
  return analysis.triageComplete + analysis.analyzing + analysis.notAnalyzed + analysis.failed;
}

function complianceTone(compliance: number): DashboardMetricTone {
  if (compliance < 70) {
    return 'danger';
  }
  return compliance < 90 ? 'warning' : 'neutral';
}

// Formulas mirror apps/web/src/components/security-agent/SecurityDashboard.tsx:398
// (buildDashboardMetrics) — kept in sync deliberately; do not copy web class
// names or icons into this pure helper.
export function buildSecurityDashboardMetrics(
  data: DashboardStats,
  slaEnabled: boolean
): DashboardMetric[] {
  if (!slaEnabled) {
    return [
      {
        id: 'openFindings',
        label: 'Open findings',
        value: String(data.analysis.total),
        detail: `${data.severity.critical} critical, ${data.severity.high} high`,
        tone: 'danger',
      },
      {
        id: 'exploitable',
        label: 'Confirmed exploitable',
        value: String(data.analysis.exploitable),
        detail: 'Project risk confirmed by analysis',
        tone: 'danger',
      },
      {
        id: 'needsReview',
        label: 'Needs your review',
        value: String(data.analysis.needsReview),
        detail: 'Human decision required',
        tone: 'warning',
      },
      {
        id: 'analysisIncomplete',
        label: 'Analysis not complete',
        value: String(getAnalysisIncompleteCount(data.analysis)),
        detail: 'Project risk still unknown',
        tone: 'neutral',
      },
    ];
  }

  const compliance =
    data.sla.overall.total > 0
      ? Math.round((data.sla.overall.withinSla / data.sla.overall.total) * 100)
      : 100;

  return [
    {
      id: 'slaCompliance',
      label: 'SLA compliance',
      value: `${compliance}%`,
      detail:
        data.sla.overall.total > 0
          ? `${data.sla.overall.withinSla} of ${data.sla.overall.total} within deadline`
          : 'No assigned deadlines',
      tone: complianceTone(compliance),
    },
    {
      id: 'deadlinePassed',
      label: 'Deadline passed',
      value: String(data.sla.overall.overdue),
      detail: `${data.sla.bySeverity.critical.overdue} critical, ${data.sla.bySeverity.high.overdue} high`,
      tone: data.sla.overall.overdue > 0 ? 'danger' : 'neutral',
    },
    {
      id: 'dueSoon',
      label: 'Due this week',
      value: String(data.sla.dueSoon.total),
      detail: `${data.sla.dueSoon.exploitable} confirmed exploitable`,
      tone: data.sla.dueSoon.total > 0 ? 'warning' : 'neutral',
    },
    {
      id: 'noDeadline',
      label: 'No deadline',
      value: String(data.sla.untrackedCount),
      detail: data.sla.untrackedCount > 0 ? 'Review SLA assignment' : 'All open findings tracked',
      tone: 'neutral',
    },
  ];
}
