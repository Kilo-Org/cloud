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
    dueSoon: { total: number; exploitable: number };
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
  priorityFinding: {
    id: string;
    severity: string;
    title: string;
    repoFullName: string;
    analysisStatus: string | null;
    isExploitable: boolean | 'unknown' | null;
    suggestedAction: string | null;
    slaDueAt: string | null;
    daysOverdue: number | null;
  } | null;
  repoHealth: Array<{
    repoFullName: string;
    open: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    overdue: number;
    exploitable: number;
    needsAction: number;
    slaCompliancePercent: number;
  }>;
  repositoryCount: number;
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
  due_soon: string;
  due_soon_exploitable: string;
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

type PriorityFindingRow = {
  id: string;
  severity: string;
  title: string;
  repo_full_name: string;
  analysis_status: string | null;
  is_exploitable: string | null;
  suggested_action: string | null;
  sla_due_at: string | null;
  days_overdue: string | null;
};

type RepoHealthRow = {
  repo_full_name: string;
  open: string;
  critical: string;
  high: string;
  medium: string;
  low: string;
  overdue: string;
  exploitable: string;
  needs_action: string;
  sla_compliance_percent: string;
  repository_count: string;
};

type GetDashboardStatsParams = {
  owner: SecurityReviewOwner;
  repoFullName?: string;
  slaEnabled: boolean;
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

function parseExploitability(value: string | null): boolean | 'unknown' | null {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'unknown') return 'unknown';
  return null;
}

function toUtcIso(value: string): string {
  return new Date(value).toISOString();
}

export async function getDashboardStats(params: GetDashboardStatsParams): Promise<DashboardStats> {
  try {
    const { owner, repoFullName, slaEnabled, slaConfig } = params;
    const ownerConverted = toOwner(owner);
    const whereClause = buildWhereClause(ownerConverted, repoFullName);
    const repositorySecondaryOrder = slaEnabled
      ? sql`COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} <= now())`
      : sql`COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true')`;
    const priorityDeadlineOrder = slaEnabled
      ? sql`CASE
          WHEN ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} <= now() THEN 0
          ELSE 1
        END`
      : sql`CASE WHEN true THEN 0 END`;
    const priorityDeadlineDateOrder = slaEnabled
      ? sql`${security_findings.sla_due_at} ASC NULLS LAST`
      : sql`${security_findings.first_detected_at} ASC`;

    const [
      slaResult,
      severityResult,
      statusResult,
      analysisResult,
      mttrResult,
      overdueResult,
      priorityFindingResult,
      repoHealthResult,
    ] = await Promise.all([
      // SLA query
      db.execute<SlaRow>(sql`
          SELECT
            ${security_findings.severity} AS severity,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} IS NOT NULL) AS total,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} > now()) AS within_sla,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} <= now()) AS overdue,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} > now() AND ${security_findings.sla_due_at} <= now() + interval '7 days') AS due_soon,
            COUNT(*) FILTER (WHERE ${security_findings.sla_due_at} > now() AND ${security_findings.sla_due_at} <= now() + interval '7 days' AND ${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true') AS due_soon_exploitable,
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
            COUNT(*) FILTER (WHERE ${security_findings.analysis_status} = 'completed' AND COALESCE(${security_findings.analysis}->'sandboxAnalysis'->>'suggestedAction', ${security_findings.analysis}->'triage'->>'suggestedAction') = 'manual_review' AND ((${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') IS NULL OR (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'unknown')) AS needs_review,
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
            AND ${security_findings.sla_due_at} <= now()
            AND ${whereClause}
          ORDER BY ${security_findings.sla_due_at} ASC
          LIMIT 10
        `),

      // Highest-priority open finding for guided next action
      db.execute<PriorityFindingRow>(sql`
          SELECT
            ${security_findings.id} AS id,
            ${security_findings.severity} AS severity,
            ${security_findings.title} AS title,
            ${security_findings.repo_full_name} AS repo_full_name,
            ${security_findings.analysis_status} AS analysis_status,
            ${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable' AS is_exploitable,
            COALESCE(
              ${security_findings.analysis}->'sandboxAnalysis'->>'suggestedAction',
              ${security_findings.analysis}->'triage'->>'suggestedAction'
            ) AS suggested_action,
            ${security_findings.sla_due_at} AS sla_due_at,
            CASE
              WHEN ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} <= now()
              THEN EXTRACT(EPOCH FROM (now() - ${security_findings.sla_due_at})) / 86400
              ELSE NULL
            END AS days_overdue
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'open' AND ${whereClause}
          ORDER BY
            CASE ${security_findings.severity}
              WHEN 'critical' THEN 0
              WHEN 'high' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 3
              ELSE 4
            END,
            ${priorityDeadlineOrder},
            CASE
              WHEN ${security_findings.analysis_status} IS NULL OR ${security_findings.analysis_status} = 'failed' THEN 0
              WHEN ${security_findings.analysis_status} IN ('pending', 'running') THEN 1
              WHEN (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true' THEN 2
              WHEN COALESCE(${security_findings.analysis}->'sandboxAnalysis'->>'suggestedAction', ${security_findings.analysis}->'triage'->>'suggestedAction') IN ('analyze_codebase', 'manual_review') THEN 3
              ELSE 4
            END,
            ${priorityDeadlineDateOrder},
            ${security_findings.first_detected_at} ASC,
            ${security_findings.id} ASC
          LIMIT 1
        `),

      // Repo health query
      db.execute<RepoHealthRow>(sql`
          SELECT
            ${security_findings.repo_full_name} AS repo_full_name,
            COUNT(*) FILTER (WHERE ${security_findings.status} = 'open') AS open,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'critical' AND ${security_findings.status} = 'open') AS critical,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'high' AND ${security_findings.status} = 'open') AS high,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'medium' AND ${security_findings.status} = 'open') AS medium,
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'low' AND ${security_findings.status} = 'open') AS low,
            COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} <= now()) AS overdue,
            COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true') AS exploitable,
            COUNT(*) FILTER (
              WHERE ${security_findings.status} = 'open'
                AND (
                  ${security_findings.analysis_status} IS NULL
                  OR ${security_findings.analysis_status} = 'failed'
                  OR (${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true')
                  OR (${security_findings.analysis_status} = 'completed' AND COALESCE(${security_findings.analysis}->'sandboxAnalysis'->>'suggestedAction', ${security_findings.analysis}->'triage'->>'suggestedAction') IN ('analyze_codebase', 'manual_review'))
                )
            ) AS needs_action,
            CASE
              WHEN COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL) = 0 THEN 100
              ELSE ROUND(
                COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL AND ${security_findings.sla_due_at} > now()) * 100.0 /
                COUNT(*) FILTER (WHERE ${security_findings.status} = 'open' AND ${security_findings.sla_due_at} IS NOT NULL), 1
              )
            END AS sla_compliance_percent,
            COUNT(*) OVER() AS repository_count
          FROM ${security_findings}
          WHERE ${whereClause}
          GROUP BY ${security_findings.repo_full_name}
          HAVING COUNT(*) FILTER (WHERE ${security_findings.status} = 'open') > 0
          ORDER BY
            COUNT(*) FILTER (WHERE ${security_findings.severity} = 'critical' AND ${security_findings.status} = 'open') DESC,
            ${repositorySecondaryOrder} DESC,
            COUNT(*) FILTER (
              WHERE ${security_findings.status} = 'open'
                AND (
                  ${security_findings.analysis_status} IS NULL
                  OR ${security_findings.analysis_status} = 'failed'
                  OR (${security_findings.analysis_status} = 'completed' AND (${security_findings.analysis}->'sandboxAnalysis'->>'isExploitable') = 'true')
                  OR (${security_findings.analysis_status} = 'completed' AND COALESCE(${security_findings.analysis}->'sandboxAnalysis'->>'suggestedAction', ${security_findings.analysis}->'triage'->>'suggestedAction') IN ('analyze_codebase', 'manual_review'))
                )
            ) DESC,
            ${security_findings.repo_full_name} ASC
          LIMIT 10
        `),
    ]);

    // Parse SLA results
    const slaBySeverity = emptySeverityRecord(() => ({ total: 0, withinSla: 0, overdue: 0 }));
    let slaOverallTotal = 0;
    let slaOverallWithinSla = 0;
    let slaOverallOverdue = 0;
    let dueSoonCount = 0;
    let dueSoonExploitableCount = 0;
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
      dueSoonCount += Number(row.due_soon);
      dueSoonExploitableCount += Number(row.due_soon_exploitable);
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
      slaDueAt: toUtcIso(row.sla_due_at),
      daysOverdue: Math.max(0, Math.floor(Number(row.days_overdue))),
    }));

    const priorityRow = priorityFindingResult.rows[0];
    const priorityFinding = priorityRow
      ? {
          id: priorityRow.id,
          severity: priorityRow.severity,
          title: priorityRow.title,
          repoFullName: priorityRow.repo_full_name,
          analysisStatus: priorityRow.analysis_status,
          isExploitable: parseExploitability(priorityRow.is_exploitable),
          suggestedAction: priorityRow.suggested_action,
          slaDueAt: priorityRow.sla_due_at ? toUtcIso(priorityRow.sla_due_at) : null,
          daysOverdue:
            priorityRow.days_overdue === null
              ? null
              : Math.max(0, Math.floor(Number(priorityRow.days_overdue))),
        }
      : null;

    // Parse repo health results
    const repoHealth = repoHealthResult.rows.map(row => ({
      repoFullName: row.repo_full_name,
      open: Number(row.open),
      critical: Number(row.critical),
      high: Number(row.high),
      medium: Number(row.medium),
      low: Number(row.low),
      overdue: Number(row.overdue),
      exploitable: Number(row.exploitable),
      needsAction: Number(row.needs_action),
      slaCompliancePercent: Number(row.sla_compliance_percent),
    }));
    const repositoryCount = Number(repoHealthResult.rows[0]?.repository_count ?? 0);

    return {
      sla: {
        overall: {
          total: slaOverallTotal,
          withinSla: slaOverallWithinSla,
          overdue: slaOverallOverdue,
        },
        bySeverity: slaBySeverity,
        dueSoon: { total: dueSoonCount, exploitable: dueSoonExploitableCount },
        untrackedCount,
      },
      severity: severityCounts,
      status: statusCounts,
      analysis,
      mttr: { bySeverity: mttrBySeverity },
      overdue,
      priorityFinding,
      repoHealth,
      repositoryCount,
    };
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getDashboardStats' },
      extra: { params },
    });
    throw error;
  }
}
