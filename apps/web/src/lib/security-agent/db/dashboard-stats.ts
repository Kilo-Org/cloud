import { readDb } from '@kilocode/web-shared/lib/drizzle';
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
    /** Kept numeric for compatibility with installed mobile clients. */
    slaCompliancePercent: number;
    /** False when the repo has no open SLA-tracked findings. */
    slaComplianceMeasured: boolean;
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

type DashboardAggregates = {
  sla: Array<{
    severity: string;
    total: number;
    within_sla: number;
    overdue: number;
    due_soon: number;
    due_soon_exploitable: number;
    untracked: number;
  }>;
  severity: Array<{ severity: string; count: number }>;
  status: Array<{ status: string; count: number }>;
  analysis: {
    total: number;
    analyzed: number;
    exploitable: number;
    not_exploitable: number;
    triage_complete: number;
    safe_to_dismiss: number;
    needs_review: number;
    analyzing: number;
    not_analyzed: number;
    failed: number;
  } | null;
  mttr: Array<{
    severity: string;
    avg_days: number | null;
    median_days: number | null;
    count: number;
  }>;
};

type DashboardLists = {
  overdue: Array<{
    id: string;
    severity: string;
    title: string;
    repo_full_name: string;
    package_name: string;
    sla_due_at: string;
    days_overdue: number;
  }>;
  priority: Array<{
    id: string;
    severity: string;
    title: string;
    repo_full_name: string;
    analysis_status: string | null;
    is_exploitable: string | null;
    suggested_action: string | null;
    sla_due_at: string | null;
    days_overdue: number | null;
  }>;
  repo_health: {
    rows: Array<{
      repo_full_name: string;
      open: number;
      critical: number;
      high: number;
      medium: number;
      low: number;
      overdue: number;
      exploitable: number;
      needs_action: number;
      sla_compliance_percent: number | null;
    }>;
    repository_count: number;
  };
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
    // Ordering fragments below reference bare column names because they are
    // evaluated inside CTEs that select from derived relations, not directly
    // from the table.
    const repositorySecondaryScore = slaEnabled
      ? sql`COUNT(*) FILTER (WHERE status = 'open' AND sla_due_at IS NOT NULL AND sla_due_at <= now())`
      : sql`COUNT(*) FILTER (WHERE status = 'open' AND analysis_status = 'completed' AND (analysis->'sandboxAnalysis'->>'isExploitable') = 'true')`;
    const priorityDeadlineOrder = slaEnabled
      ? sql`CASE
          WHEN sla_due_at IS NOT NULL AND sla_due_at <= now() THEN 0
          ELSE 1
        END`
      : sql`CASE WHEN true THEN 0 END`;
    const priorityDeadlineDateOrder = slaEnabled
      ? sql`sla_due_at ASC NULLS LAST`
      : sql`first_detected_at ASC`;

    // Dashboard aggregates run as two sequential set-based reads, each on a
    // single pooled connection.
    const aggregatesResult = await readDb.execute<{ data: DashboardAggregates }>(sql`
        WITH base AS (
          SELECT
            ${security_findings.severity} AS severity,
            ${security_findings.analysis_status} AS analysis_status,
            ${security_findings.analysis} AS analysis,
            ${security_findings.sla_due_at} AS sla_due_at
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'open' AND ${whereClause}
        ),
        open_agg AS (
          SELECT
            severity,
            COUNT(*) AS finding_count,
            COUNT(*) FILTER (WHERE sla_due_at IS NOT NULL) AS sla_total,
            COUNT(*) FILTER (WHERE sla_due_at IS NOT NULL AND sla_due_at > now()) AS within_sla,
            COUNT(*) FILTER (WHERE sla_due_at IS NOT NULL AND sla_due_at <= now()) AS overdue,
            COUNT(*) FILTER (WHERE sla_due_at > now() AND sla_due_at <= now() + interval '7 days') AS due_soon,
            COUNT(*) FILTER (WHERE sla_due_at > now() AND sla_due_at <= now() + interval '7 days' AND analysis_status = 'completed' AND (analysis->'sandboxAnalysis'->>'isExploitable') = 'true') AS due_soon_exploitable,
            COUNT(*) FILTER (WHERE sla_due_at IS NULL) AS untracked,
            COUNT(*) FILTER (WHERE analysis_status = 'completed') AS analyzed,
            COUNT(*) FILTER (WHERE analysis_status = 'completed' AND (analysis->'sandboxAnalysis'->>'isExploitable') = 'true') AS exploitable,
            COUNT(*) FILTER (WHERE analysis_status = 'completed' AND (analysis->'sandboxAnalysis'->>'isExploitable') = 'false') AS not_exploitable,
            COUNT(*) FILTER (WHERE analysis_status = 'completed' AND ((analysis->'sandboxAnalysis'->>'isExploitable') IS NULL OR (analysis->'sandboxAnalysis'->>'isExploitable') = 'unknown') AND (analysis->'triage'->>'suggestedAction') = 'analyze_codebase') AS triage_complete,
            COUNT(*) FILTER (WHERE analysis_status = 'completed' AND (analysis->'triage'->>'suggestedAction') = 'dismiss' AND ((analysis->'sandboxAnalysis'->>'isExploitable') IS NULL OR (analysis->'sandboxAnalysis'->>'isExploitable') = 'unknown')) AS safe_to_dismiss,
            COUNT(*) FILTER (WHERE analysis_status = 'completed' AND COALESCE(analysis->'sandboxAnalysis'->>'suggestedAction', analysis->'triage'->>'suggestedAction') = 'manual_review' AND ((analysis->'sandboxAnalysis'->>'isExploitable') IS NULL OR (analysis->'sandboxAnalysis'->>'isExploitable') = 'unknown')) AS needs_review,
            COUNT(*) FILTER (WHERE analysis_status IN ('pending', 'running')) AS analyzing,
            COUNT(*) FILTER (WHERE analysis_status IS NULL) AS not_analyzed,
            COUNT(*) FILTER (WHERE analysis_status = 'failed') AS failed
          FROM base
          GROUP BY severity
        ),
        base_status AS (
          SELECT ${security_findings.status} AS status
          FROM ${security_findings}
          WHERE ${whereClause}
        ),
        mttr_base AS (
          SELECT
            ${security_findings.severity} AS severity,
            EXTRACT(EPOCH FROM (${security_findings.fixed_at} - ${security_findings.first_detected_at})) / 86400 AS days
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'fixed'
            AND ${security_findings.fixed_at} IS NOT NULL
            AND ${security_findings.first_detected_at} IS NOT NULL
            AND ${whereClause}
        )
        SELECT jsonb_build_object(
          'sla', COALESCE(
            (SELECT jsonb_agg(jsonb_build_object(
               'severity', severity,
               'total', sla_total,
               'within_sla', within_sla,
               'overdue', overdue,
               'due_soon', due_soon,
               'due_soon_exploitable', due_soon_exploitable,
               'untracked', untracked
             ))
             FROM open_agg),
            '[]'::jsonb),
          'severity', COALESCE(
            (SELECT jsonb_agg(jsonb_build_object('severity', severity, 'count', finding_count))
             FROM open_agg),
            '[]'::jsonb),
          'status', COALESCE(
            (SELECT jsonb_agg(jsonb_build_object('status', status, 'count', count))
             FROM (SELECT status, COUNT(*) AS count FROM base_status GROUP BY status) status_agg),
            '[]'::jsonb),
          'analysis', (
            SELECT jsonb_build_object(
              'total', COALESCE(SUM(finding_count), 0),
              'analyzed', COALESCE(SUM(analyzed), 0),
              'exploitable', COALESCE(SUM(exploitable), 0),
              'not_exploitable', COALESCE(SUM(not_exploitable), 0),
              'triage_complete', COALESCE(SUM(triage_complete), 0),
              'safe_to_dismiss', COALESCE(SUM(safe_to_dismiss), 0),
              'needs_review', COALESCE(SUM(needs_review), 0),
              'analyzing', COALESCE(SUM(analyzing), 0),
              'not_analyzed', COALESCE(SUM(not_analyzed), 0),
              'failed', COALESCE(SUM(failed), 0)
            )
            FROM open_agg
          ),
          'mttr', COALESCE(
            (SELECT jsonb_agg(jsonb_build_object(
               'severity', severity,
               'avg_days', avg_days,
               'median_days', median_days,
               'count', count
             ))
             FROM (
               SELECT
                 severity,
                 AVG(days) AS avg_days,
                 PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days) AS median_days,
                 COUNT(*) AS count
               FROM mttr_base
               GROUP BY severity
             ) mttr_agg),
            '[]'::jsonb)
        ) AS data
      `);

    const listsResult = await readDb.execute<{ data: DashboardLists }>(sql`
        WITH base AS (
          SELECT
            ${security_findings.id} AS id,
            ${security_findings.severity} AS severity,
            ${security_findings.title} AS title,
            ${security_findings.repo_full_name} AS repo_full_name,
            ${security_findings.package_name} AS package_name,
            ${security_findings.analysis_status} AS analysis_status,
            ${security_findings.analysis} AS analysis,
            ${security_findings.sla_due_at} AS sla_due_at,
            ${security_findings.first_detected_at} AS first_detected_at
          FROM ${security_findings}
          WHERE ${security_findings.status} = 'open' AND ${whereClause}
        ),
        overdue AS (
          SELECT
            id,
            severity,
            title,
            repo_full_name,
            package_name,
            sla_due_at,
            EXTRACT(EPOCH FROM (now() - sla_due_at)) / 86400 AS days_overdue
          FROM base
          WHERE sla_due_at IS NOT NULL AND sla_due_at <= now()
          ORDER BY sla_due_at ASC
          LIMIT 10
        ),
        priority AS (
          SELECT
            id,
            severity,
            title,
            repo_full_name,
            analysis_status,
            analysis->'sandboxAnalysis'->>'isExploitable' AS is_exploitable,
            COALESCE(
              analysis->'sandboxAnalysis'->>'suggestedAction',
              analysis->'triage'->>'suggestedAction'
            ) AS suggested_action,
            sla_due_at,
            CASE
              WHEN sla_due_at IS NOT NULL AND sla_due_at <= now()
              THEN EXTRACT(EPOCH FROM (now() - sla_due_at)) / 86400
              ELSE NULL
            END AS days_overdue
          FROM base
          ORDER BY
            CASE severity
              WHEN 'critical' THEN 0
              WHEN 'high' THEN 1
              WHEN 'medium' THEN 2
              WHEN 'low' THEN 3
              ELSE 4
            END,
            ${priorityDeadlineOrder},
            CASE
              WHEN analysis_status IS NULL OR analysis_status = 'failed' THEN 0
              WHEN analysis_status IN ('pending', 'running') THEN 1
              WHEN (analysis->'sandboxAnalysis'->>'isExploitable') = 'true' THEN 2
              WHEN COALESCE(analysis->'sandboxAnalysis'->>'suggestedAction', analysis->'triage'->>'suggestedAction') IN ('analyze_codebase', 'manual_review') THEN 3
              ELSE 4
            END,
            ${priorityDeadlineDateOrder},
            first_detected_at ASC,
            id ASC
          LIMIT 1
        ),
        repo_base AS (
          SELECT
            ${security_findings.repo_full_name} AS repo_full_name,
            ${security_findings.severity} AS severity,
            ${security_findings.status} AS status,
            ${security_findings.analysis_status} AS analysis_status,
            ${security_findings.analysis} AS analysis,
            ${security_findings.sla_due_at} AS sla_due_at
          FROM ${security_findings}
          WHERE ${whereClause}
        ),
        repo_health AS (
          SELECT
            repo_full_name,
            COUNT(*) FILTER (WHERE status = 'open') AS open,
            COUNT(*) FILTER (WHERE severity = 'critical' AND status = 'open') AS critical,
            COUNT(*) FILTER (WHERE severity = 'high' AND status = 'open') AS high,
            COUNT(*) FILTER (WHERE severity = 'medium' AND status = 'open') AS medium,
            COUNT(*) FILTER (WHERE severity = 'low' AND status = 'open') AS low,
            COUNT(*) FILTER (WHERE status = 'open' AND sla_due_at IS NOT NULL AND sla_due_at <= now()) AS overdue,
            COUNT(*) FILTER (WHERE status = 'open' AND analysis_status = 'completed' AND (analysis->'sandboxAnalysis'->>'isExploitable') = 'true') AS exploitable,
            COUNT(*) FILTER (
              WHERE status = 'open'
                AND (
                  analysis_status IS NULL
                  OR analysis_status = 'failed'
                  OR (analysis_status = 'completed' AND (analysis->'sandboxAnalysis'->>'isExploitable') = 'true')
                  OR (analysis_status = 'completed' AND COALESCE(analysis->'sandboxAnalysis'->>'suggestedAction', analysis->'triage'->>'suggestedAction') IN ('analyze_codebase', 'manual_review'))
                )
            ) AS needs_action,
            ${repositorySecondaryScore} AS secondary,
            CASE
              WHEN COUNT(*) FILTER (WHERE status = 'open' AND sla_due_at IS NOT NULL) = 0 THEN NULL
              ELSE ROUND(
                COUNT(*) FILTER (WHERE status = 'open' AND sla_due_at IS NOT NULL AND sla_due_at > now()) * 100.0 /
                COUNT(*) FILTER (WHERE status = 'open' AND sla_due_at IS NOT NULL), 1
              )
            END AS sla_compliance_percent
          FROM repo_base
          GROUP BY repo_full_name
          HAVING COUNT(*) FILTER (WHERE status = 'open') > 0
        )
        SELECT jsonb_build_object(
          'overdue', COALESCE(
            (SELECT jsonb_agg(to_jsonb(row_data))
             FROM (SELECT * FROM overdue ORDER BY sla_due_at ASC) row_data),
            '[]'::jsonb),
          'priority', COALESCE(
            (SELECT jsonb_agg(to_jsonb(row_data)) FROM priority row_data),
            '[]'::jsonb),
          'repo_health', jsonb_build_object(
            'rows', COALESCE(
              (SELECT jsonb_agg(to_jsonb(row_data))
               FROM (
                 SELECT * FROM repo_health
                 ORDER BY critical DESC, secondary DESC, needs_action DESC, repo_full_name ASC
                 LIMIT 10
               ) row_data),
              '[]'::jsonb),
            'repository_count', (SELECT COUNT(*) FROM repo_health)
          )
        ) AS data
      `);

    const aggregates = aggregatesResult.rows[0]?.data;
    const lists = listsResult.rows[0]?.data;
    if (!aggregates || !lists) {
      throw new Error('Dashboard stats queries returned no data row');
    }

    const slaBySeverity = emptySeverityRecord(() => ({ total: 0, withinSla: 0, overdue: 0 }));
    let slaOverallTotal = 0;
    let slaOverallWithinSla = 0;
    let slaOverallOverdue = 0;
    let dueSoonCount = 0;
    let dueSoonExploitableCount = 0;
    let untrackedCount = 0;

    for (const row of aggregates.sla) {
      const sev = row.severity;
      if (isSeverity(sev)) {
        slaBySeverity[sev] = {
          total: row.total,
          withinSla: row.within_sla,
          overdue: row.overdue,
        };
        slaOverallTotal += row.total;
        slaOverallWithinSla += row.within_sla;
        slaOverallOverdue += row.overdue;
      }
      dueSoonCount += row.due_soon;
      dueSoonExploitableCount += row.due_soon_exploitable;
      untrackedCount += row.untracked;
    }

    const severityCounts = emptySeverityRecord(() => 0);
    for (const row of aggregates.severity) {
      if (isSeverity(row.severity)) {
        severityCounts[row.severity] = row.count;
      }
    }

    const statusCounts = { open: 0, fixed: 0, ignored: 0 };
    for (const row of aggregates.status) {
      const s = row.status;
      if (s === 'open' || s === 'fixed' || s === 'ignored') {
        statusCounts[s] = row.count;
      }
    }

    const analysisRow = aggregates.analysis;
    const analysis = analysisRow
      ? {
          total: analysisRow.total,
          analyzed: analysisRow.analyzed,
          exploitable: analysisRow.exploitable,
          notExploitable: analysisRow.not_exploitable,
          triageComplete: analysisRow.triage_complete,
          safeToDismiss: analysisRow.safe_to_dismiss,
          needsReview: analysisRow.needs_review,
          analyzing: analysisRow.analyzing,
          notAnalyzed: analysisRow.not_analyzed,
          failed: analysisRow.failed,
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
    for (const row of aggregates.mttr) {
      if (isSeverity(row.severity)) {
        mttrBySeverity[row.severity] = {
          avgDays: row.avg_days !== null ? Math.round(row.avg_days * 10) / 10 : null,
          medianDays: row.median_days !== null ? Math.round(row.median_days * 10) / 10 : null,
          count: row.count,
          slaDays: slaDaysMap[row.severity],
        };
      }
    }

    const overdue = lists.overdue.map(row => ({
      id: row.id,
      severity: row.severity,
      title: row.title,
      repoFullName: row.repo_full_name,
      packageName: row.package_name,
      slaDueAt: toUtcIso(row.sla_due_at),
      daysOverdue: Math.max(0, Math.floor(row.days_overdue)),
    }));

    const priorityRow = lists.priority[0];
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
              : Math.max(0, Math.floor(priorityRow.days_overdue)),
        }
      : null;

    const repoHealth = lists.repo_health.rows.map(row => ({
      repoFullName: row.repo_full_name,
      open: row.open,
      critical: row.critical,
      high: row.high,
      medium: row.medium,
      low: row.low,
      overdue: row.overdue,
      exploitable: row.exploitable,
      needsAction: row.needs_action,
      slaCompliancePercent: row.sla_compliance_percent == null ? 100 : row.sla_compliance_percent,
      slaComplianceMeasured: row.sla_compliance_percent != null,
    }));
    const repositoryCount = lists.repo_health.repository_count;

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
