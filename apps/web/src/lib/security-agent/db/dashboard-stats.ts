import { db } from '@/lib/drizzle';
import { security_findings } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { SecurityReviewOwner } from '../core/types';

type Severity = 'critical' | 'high' | 'medium' | 'low';

export type DashboardStats = {
  sla: {
    overall: { total: number; withinSla: number; overdue: number };
    bySeverity: Record<Severity, { total: number; withinSla: number; overdue: number }>;
    untrackedCount: number;
  };
  severity: Record<Severity, number>;
  status: { open: number; fixed: number; ignored: number };
  analysis: {
    total: number;
    analyzed: number;
    exploitable: number;
    notExploitable: number;
    triageComplete: number;
    safeToDismiss: number;
    needsReview: number;
    analyzing: number;
    notAnalyzed: number;
    failed: number;
  };
  mttr: {
    bySeverity: Record<
      Severity,
      {
        avgDays: number | null;
        medianDays: number | null;
        count: number;
        slaDays: number;
      }
    >;
  };
  overdue: Array<{
    id: string;
    severity: string;
    title: string;
    repoFullName: string;
    packageName: string;
    slaDueAt: string;
    daysOverdue: number;
  }>;
  repoHealth: Array<{
    repoFullName: string;
    critical: number;
    high: number;
    medium: number;
    low: number;
    overdue: number;
    slaCompliancePercent: number;
  }>;
};

type Owner = { type: 'org'; id: string } | { type: 'user'; id: string };

function toOwner(owner: SecurityReviewOwner): Owner {
  if ('organizationId' in owner && owner.organizationId) {
    return { type: 'org', id: owner.organizationId };
  }
  if ('userId' in owner && owner.userId) {
    return { type: 'user', id: owner.userId };
  }
  throw new Error('Invalid owner: must have either organizationId or userId');
}

function buildWhereClause(owner: Owner, repoFullName?: string) {
  const ownerCondition =
    owner.type === 'org'
      ? sql`${security_findings.owned_by_organization_id} = ${owner.id}`
      : sql`${security_findings.owned_by_user_id} = ${owner.id}`;

  if (repoFullName) {
    return sql`${ownerCondition} AND ${security_findings.repo_full_name} = ${repoFullName}`;
  }
  return ownerCondition;
}

type SlaRow = {
  severity: string;
  total: string;
  within_sla: string;
  overdue: string;
  untracked: string;
};

type SeverityRow = {
  severity: string;
  count: string;
};

type StatusRow = {
  status: string;
  count: string;
};

type AnalysisRow = {
  total: string;
  analyzed: string;
  exploitable: string;
  not_exploitable: string;
  triage_complete: string;
  safe_to_dismiss: string;
  needs_review: string;
  analyzing: string;
  not_analyzed: string;
  failed: string;
};

type MttrRow = {
  severity: string;
  avg_days: string | null;
  median_days: string | null;
  count: string;
};

type OverdueRow = {
  id: string;
  severity: string;
  title: string;
  repo_full_name: string;
  package_name: string;
  sla_due_at: string;
  days_overdue: string;
};

type RepoHealthRow = {
  repo_full_name: string;
  critical: string;
  high: string;
  medium: string;
  low: string;
  overdue: string;
  sla_compliance_percent: string;
};

type GetDashboardStatsParams = {
  owner: SecurityReviewOwner;
  repoFullName?: string;
  slaConfig: {
    slaCriticalDays: number;
    slaHighDays: number;
    slaMediumDays: number;
    slaLowDays: number;
  };
};

function isSeverity(s: string): s is Severity {
  return s === 'critical' || s === 'high' || s === 'medium' || s === 'low';
}

function emptySeverityRecord<T>(defaultValue: () => T): Record<Severity, T> {
  return {
    critical: defaultValue(),
    high: defaultValue(),
    medium: defaultValue(),
    low: defaultValue(),
  };
}

export async function getDashboardStats(params: GetDashboardStatsParams): Promise<DashboardStats> {
  try {
    const { owner, repoFullName, slaConfig } = params;
    const ownerConverted = toOwner(owner);
    const whereClause = buildWhereClause(ownerConverted, repoFullName);

    const [
      slaResult,
      severityResult,
      statusResult,
      analysisResult,
      mttrResult,
      overdueResult,
      repoHealthResult,
    ] = await Promise.all([
      // SLA query
      db.execute<SlaRow>(sql`
          SELECT
            ${security_findings.severity} AS severity,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} IS NOT NULL) AS total,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} > now()) AS within_sla,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} <= now()) AS overdue,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} IS NULL) AS untracked
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'open' AND ${whereClause}
          GROUP BY ${security_findings.severity}
        `),

      // Severity query (open only)
      db.execute<SeverityRow>(sql`
          SELECT ${security_findings.severity} AS severity, COUNT(*) AS count
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'open' AND ${whereClause}
          GROUP BY ${security_findings.severity}
        `),

      // Status query
      db.execute<StatusRow>(sql`
          SELECT ${security_findings.status} AS status, COUNT(*) AS count
          FROM ${security_findings}
          WHERE ${whereClause}
          GROUP BY ${security_findings.status}
        `),

      // Analysis coverage query (open only)
      db.execute<AnalysisRow>(sql`
          SELECT
            COUNT(*) AS total,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'completed') AS analyzed,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true') AS exploitable,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'false') AS not_exploitable,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'completed' AND ((${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') IS NULL OR (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'unknown') AND (${security_findings.analysis}->'triage'->>'suggestedAction') = 'analyze_codebase') AS triage_complete,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'triage'->>'suggestedAction') = 'dismiss' AND ((${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') IS NULL OR (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'unknown')) AS safe_to_dismiss,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'triage'->>'suggestedAction') = 'manual_review' AND ((${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') IS NULL OR (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'unknown')) AS needs_review,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} IN ('pending', 'running')) AS analyzing,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} IS NULL) AS not_analyzed,
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'failed') AS failed
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'open' AND ${whereClause}
        `),

      // MTTR query
      db.execute<MttrRow>(sql`
          SELECT
            ${security_findings.severity} AS severity,
            AVG(EXTRACT(EPOCH FROM (${security_findings.fixed_at} - ${security_findings.first_detected_at})) / 86400) AS avg_days,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${security_findings.fixed_at} - ${security_findings.first_detected_at})) / 86400) AS median_days,
            COUNT(*) AS count
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'fixed'
            AND ${security_findings.fixed_at} IS NOT NULL
            AND ${security_findings.first_detected_at} IS NOT NULL
            AND ${whereClause}
          GROUP BY ${security_findings.severity}
        `),

      // Overdue findings query
      db.execute<OverdueRow>(sql`
          SELECT
            ${security_findings.id} AS id,
            ${security_findings.severity} AS severity,
            ${security_findings.title} AS title,
            ${security_findings.repo_full_name} AS repo_full_name,
            ${security_findings.package_name} AS package_name,
            ${security_findings.sla_due_at} AS sla_due_at,
            EXTRACT(EPOCH FROM (now() - ${security_findings.sla_due_at})) / 86400 AS days_overdue
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'open'
            AND ${security_findings.sla_due_at} IS NOT NULL
            AND ${security_findings.sla_due_at} < now()
            AND ${whereClause}
          ORDER BY ${security_findings.sla_due_at} ASC
          LIMIT 10
        `),

      // Repo health query
      db.execute<RepoHealthRow>(sql`
          SELECT
            ${security_findings.repo_full_name} AS repo_full_name,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'critical' AND ${security_findings.status} = 'open') AS critical,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'high' AND ${security_findings.status} = 'open') AS high,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'medium' AND ${security_findings.status} = 'open') AS medium,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'low' AND ${security_findings.status} = 'open') AS low,
            COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} < now()) AS overdue,
            CASE
              WHEN COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL) = 0 THEN 100
              ELSE ROUND(
                COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} > now()) * 100.0 /
                COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL), 1
              )
            END AS sla_compliance_percent
          FROM ${security_findings}
          WHERE ${whereClause}
          GROUP BY ${security_findings.repo_full_name}
          HAVING COUNT(*) FILTER (WHERE ${security_findings.status} = 'open') > 0
          ORDER BY
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'critical' AND ${security_findings.status} = 'open') DESC,
            COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} < now()) DESC
          LIMIT 10
        `),
    ]);

    // Parse SLA results
    const slaBySeverity = emptySeverityRecord(() => ({ total: 0, withinSla: 0, overdue: 0 }));
    let slaOverallTotal = 0;
    let slaOverallWithinSla = 0;
    let slaOverallOverdue = 0;
    let untrackedCount = 0;

    for (const row of slaResult.rows) {
      const sev = row.severity;
      if (isSeverity(sev)) {
        const total = Number(row.total);
        const withinSla = Number(row.within_sla);
        const overdue = Number(row.overdue);
        slaBySeverity[sev] = { total, withinSla, overdue };
        slaOverallTotal += total;
        slaOverallWithinSla += withinSla;
        slaOverallOverdue += overdue;
      }
      untrackedCount += Number(row.untracked);
    }

    // Parse severity results
    const severityCounts = emptySeverityRecord(() => 0);
    for (const row of severityResult.rows) {
      if (isSeverity(row.severity)) {
        severityCounts[row.severity] = Number(row.count);
      }
    }

    // Parse status results
    const statusCounts = { open: 0, fixed: 0, ignored: 0 };
    for (const row of statusResult.rows) {
      const s = row.status;
      if (s === 'open' || s === 'fixed' || s === 'ignored') {
        statusCounts[s] = Number(row.count);
      }
    }

    // Parse analysis results
    const analysisRow = analysisResult.rows[0];
    const analysis = analysisRow
      ? {
          total: Number(analysisRow.total),
          analyzed: Number(analysisRow.analyzed),
          exploitable: Number(analysisRow.exploitable),
          notExploitable: Number(analysisRow.not_exploitable),
          triageComplete: Number(analysisRow.triage_complete),
          safeToDismiss: Number(analysisRow.safe_to_dismiss),
          needsReview: Number(analysisRow.needs_review),
          analyzing: Number(analysisRow.analyzing),
          notAnalyzed: Number(analysisRow.not_analyzed),
          failed: Number(analysisRow.failed),
        }
      : {
          total: 0,
          analyzed: 0,
          exploitable: 0,
          notExploitable: 0,
          triageComplete: 0,
          safeToDismiss: 0,
          needsReview: 0,
          analyzing: 0,
          notAnalyzed: 0,
          failed: 0,
        };

    // Parse MTTR results
    const slaDaysMap: Record<Severity, number> = {
      critical: slaConfig.slaCriticalDays,
      high: slaConfig.slaHighDays,
      medium: slaConfig.slaMediumDays,
      low: slaConfig.slaLowDays,
    };

    const mttrBySeverity: Record<
      Severity,
      { avgDays: number | null; medianDays: number | null; count: number; slaDays: number }
    > = {
      critical: { avgDays: null, medianDays: null, count: 0, slaDays: slaDaysMap.critical },
      high: { avgDays: null, medianDays: null, count: 0, slaDays: slaDaysMap.high },
      medium: { avgDays: null, medianDays: null, count: 0, slaDays: slaDaysMap.medium },
      low: { avgDays: null, medianDays: null, count: 0, slaDays: slaDaysMap.low },
    };
    for (const row of mttrResult.rows) {
      if (isSeverity(row.severity)) {
        mttrBySeverity[row.severity] = {
          avgDays: row.avg_days !== null ? Math.round(Number(row.avg_days) * 10) / 10 : null,
          medianDays:
            row.median_days !== null ? Math.round(Number(row.median_days) * 10) / 10 : null,
          count: Number(row.count),
          slaDays: slaDaysMap[row.severity],
        };
      }
    }

    // Parse overdue results
    const overdue = overdueResult.rows.map(row => ({
      id: row.id,
      severity: row.severity,
      title: row.title,
      repoFullName: row.repo_full_name,
      packageName: row.package_name,
      slaDueAt: row.sla_due_at,
      daysOverdue: Math.max(0, Math.floor(Number(row.days_overdue))),
    }));

    // Parse repo health results
    const repoHealth = repoHealthResult.rows.map(row => ({
      repoFullName: row.repo_full_name,
      critical: Number(row.critical),
      high: Number(row.high),
      medium: Number(row.medium),
      low: Number(row.low),
      overdue: Number(row.overdue),
      slaCompliancePercent: Number(row.sla_compliance_percent),
    }));

    return {
      sla: {
        overall: {
          total: slaOverallTotal,
          withinSla: slaOverallWithinSla,
          overdue: slaOverallOverdue,
        },
        bySeverity: slaBySeverity,
        untrackedCount,
      },
      severity: severityCounts,
      status: statusCounts,
      analysis,
      mttr: { bySeverity: mttrBySeverity },
      overdue,
      repoHealth,
    };
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getDashboardStats' },
      extra: { params },
    });
    throw error;
  }
}
