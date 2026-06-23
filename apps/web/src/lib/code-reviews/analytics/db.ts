import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  code_review_analytics_findings,
  code_review_analytics_results,
} from '@kilocode/db/schema';
import type {
  CodeReviewAnalyticsChangeType,
  CodeReviewAnalyticsComplexityLevel,
  CodeReviewFindingCategory,
  CodeReviewFindingSecurityClass,
} from '@kilocode/db/schema-types';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import type { CodeReviewAnalyticsManifestParseResult } from './contracts';
import { getReviewAnalyticsEnabledFromConfig } from './settings';
import type { ReviewAnalyticsOwner, ReviewAnalyticsPlatform } from './settings';

export type FinalizeCompletedCodeReviewAnalyticsOutcome =
  | 'applied'
  | 'repaired'
  | 'duplicate'
  | 'stale'
  | 'terminal';

export type FinalizeCompletedCodeReviewAnalyticsResult = {
  outcome: FinalizeCompletedCodeReviewAnalyticsOutcome;
  currentStatus?: string;
  terminalReason?: string | null;
};

export async function finalizeCompletedCodeReviewWithAnalytics(input: {
  codeReviewId: string;
  sourceAttemptId?: string;
  sessionId?: string;
  cliSessionId?: string;
  executionId?: string;
  completedAt: Date;
  capture: CodeReviewAnalyticsManifestParseResult;
}): Promise<FinalizeCompletedCodeReviewAnalyticsResult> {
  return db.transaction(async tx => {
    const [review] = await tx
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, input.codeReviewId))
      .for('update')
      .limit(1);

    if (!review) {
      return { outcome: 'stale' };
    }

    const [attempt] = await tx
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, review.id))
      .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
      .limit(1);

    if (
      review.owned_by_organization_id === null ||
      !attempt ||
      (input.sourceAttemptId !== undefined && input.sourceAttemptId !== attempt.id) ||
      (input.sessionId !== undefined &&
        attempt.session_id !== null &&
        attempt.session_id !== input.sessionId) ||
      (input.cliSessionId !== undefined &&
        attempt.cli_session_id !== null &&
        attempt.cli_session_id !== input.cliSessionId) ||
      attempt.analytics_enabled_at_dispatch !== true
    ) {
      return { outcome: 'stale' };
    }

    if (
      review.status === 'failed' ||
      review.status === 'cancelled' ||
      review.terminal_reason === 'superseded' ||
      attempt.status === 'failed' ||
      attempt.status === 'cancelled'
    ) {
      return {
        outcome: 'terminal',
        currentStatus: review.status,
        terminalReason: review.terminal_reason,
      };
    }

    const [existingResult] = await tx
      .select()
      .from(code_review_analytics_results)
      .where(eq(code_review_analytics_results.code_review_id, review.id))
      .limit(1);

    if (existingResult && existingResult.source_attempt_id !== attempt.id) {
      return { outcome: 'stale' };
    }

    const finalizedAt = attempt.completed_at ?? input.completedAt.toISOString();
    let analyticsChanged = false;

    if (!existingResult) {
      const manifest = input.capture.status === 'captured' ? input.capture.manifest : null;
      const [createdResult] = await tx
        .insert(code_review_analytics_results)
        .values({
          code_review_id: review.id,
          source_attempt_id: attempt.id,
          capture_status: input.capture.status,
          schema_version: manifest?.schemaVersion ?? 1,
          taxonomy_version: manifest?.taxonomyVersion ?? 1,
          change_type: manifest?.change.type ?? null,
          impact_level: manifest?.change.impact ?? null,
          complexity_level: manifest?.change.complexity ?? null,
          classification_confidence: manifest?.change.confidence ?? null,
          finalized_at: finalizedAt,
        })
        .returning({ id: code_review_analytics_results.id });

      if (!createdResult) {
        throw new Error('Failed to create Code Reviewer analytics result');
      }

      if (manifest && manifest.findings.length > 0) {
        await tx.insert(code_review_analytics_findings).values(
          manifest.findings.map((finding, ordinal) => ({
            analytics_result_id: createdResult.id,
            ordinal,
            severity: finding.severity,
            category: finding.category,
            security_class: finding.securityClass,
          }))
        );
      }
      analyticsChanged = true;
    } else if (
      existingResult.capture_status !== 'captured' &&
      input.capture.status === 'captured'
    ) {
      const manifest = input.capture.manifest;
      await tx
        .update(code_review_analytics_results)
        .set({
          capture_status: 'captured',
          schema_version: manifest.schemaVersion,
          taxonomy_version: manifest.taxonomyVersion,
          change_type: manifest.change.type,
          impact_level: manifest.change.impact,
          complexity_level: manifest.change.complexity,
          classification_confidence: manifest.change.confidence,
          updated_at: new Date().toISOString(),
        })
        .where(eq(code_review_analytics_results.id, existingResult.id));

      await tx
        .delete(code_review_analytics_findings)
        .where(eq(code_review_analytics_findings.analytics_result_id, existingResult.id));
      if (manifest.findings.length > 0) {
        await tx.insert(code_review_analytics_findings).values(
          manifest.findings.map((finding, ordinal) => ({
            analytics_result_id: existingResult.id,
            ordinal,
            severity: finding.severity,
            category: finding.category,
            security_class: finding.securityClass,
          }))
        );
      }
      analyticsChanged = true;
    }

    const completedAt = attempt.completed_at ?? input.completedAt.toISOString();
    await tx
      .update(cloud_agent_code_review_attempts)
      .set({
        status: 'completed',
        session_id: attempt.session_id ?? input.sessionId ?? null,
        cli_session_id: attempt.cli_session_id ?? input.cliSessionId ?? null,
        execution_id: attempt.execution_id ?? input.executionId ?? null,
        completed_at: completedAt,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_code_review_attempts.id, attempt.id));

    if (['pending', 'queued', 'running'].includes(review.status)) {
      const completed = await tx
        .update(cloud_agent_code_reviews)
        .set({
          status: 'completed',
          session_id: review.session_id ?? input.sessionId ?? null,
          cli_session_id: review.cli_session_id ?? input.cliSessionId ?? null,
          completed_at: review.completed_at ?? completedAt,
          updated_at: new Date().toISOString(),
        })
        .where(
          and(
            eq(cloud_agent_code_reviews.id, review.id),
            inArray(cloud_agent_code_reviews.status, ['pending', 'queued', 'running'])
          )
        )
        .returning({ id: cloud_agent_code_reviews.id });

      if (completed.length > 0) {
        return { outcome: 'applied' };
      }
    }

    if (review.status === 'completed') {
      return { outcome: analyticsChanged ? 'repaired' : 'duplicate' };
    }

    return {
      outcome: 'terminal',
      currentStatus: review.status,
      terminalReason: review.terminal_reason,
    };
  });
}

export type CodeReviewAnalyticsCoverage = {
  enrolledCompletedReviews: number;
  captured: number;
  missing: number;
  invalid: number;
  omitted: number;
  capturePercentage: number | null;
};

export type CodeReviewAnalyticsSummary = {
  trackedReviews: number;
  trackedPrsOrMrs: number;
  totalFindings: number;
  criticalFindings: number;
  warningFindings: number;
  highImpactChanges: number;
  estimatedImpactPoints: number;
};

export type CodeReviewAnalyticsDistributionRow<T extends string> = {
  value: T;
  count: number;
  lowConfidenceCount: number;
};

export type CodeReviewAnalyticsSeverityBreakdownRow<T extends string> = {
  value: T;
  total: number;
  critical: number;
  warning: number;
  suggestion: number;
};

export type CodeReviewAnalyticsModelBreakdownRow = {
  model: string | null;
  trackedReviews: number;
  totalFindings: number;
  criticalFindings: number;
  warningFindings: number;
  suggestionFindings: number;
};

export type CodeReviewAnalyticsRepositoryRow = {
  repository: string;
  trackedPrsOrMrs: number;
  estimatedImpactPoints: number;
  highImpactChanges: number;
  criticalFindings: number;
  warningFindings: number;
  suggestionFindings: number;
};

export type CodeReviewAnalyticsContributorRow = {
  contributorKey: string;
  displayName: string;
  limitedIdentity: boolean;
  limitedData: boolean;
  trackedPrs: number;
  estimatedImpactPoints: number;
  highImpactPrs: number;
  criticalFindings: number;
  warningFindings: number;
  suggestionFindings: number;
  prsWithoutCriticalFindings: number;
};

export type CodeReviewAnalyticsDashboard = {
  settings: {
    enabled: boolean;
    canManage: boolean;
    platform: ReviewAnalyticsPlatform;
  };
  coverage: CodeReviewAnalyticsCoverage;
  summary: CodeReviewAnalyticsSummary;
  repositoryOptions: string[];
  impactBreakdown: {
    impact: Record<'low' | 'medium' | 'high' | 'unclassified', number>;
    complexity: CodeReviewAnalyticsDistributionRow<CodeReviewAnalyticsComplexityLevel>[];
    changeTypes: CodeReviewAnalyticsDistributionRow<CodeReviewAnalyticsChangeType>[];
  };
  modelBreakdown: CodeReviewAnalyticsModelBreakdownRow[];
  findingBreakdown: CodeReviewAnalyticsSeverityBreakdownRow<CodeReviewFindingCategory>[];
  securityBreakdown: CodeReviewAnalyticsSeverityBreakdownRow<CodeReviewFindingSecurityClass>[];
  repositories: CodeReviewAnalyticsRepositoryRow[];
  contributors: {
    capability: 'available' | 'stable_gitlab_author_attribution_unavailable';
    rows: CodeReviewAnalyticsContributorRow[];
  };
};

type AnalyticsQueryDb = Pick<typeof db, 'execute' | 'select'>;

type DashboardInput = {
  db: AnalyticsQueryDb;
  owner: ReviewAnalyticsOwner;
  platform: ReviewAnalyticsPlatform;
  startDate: string;
  endDate: string;
  repository?: string;
  canManage: boolean;
};

type DashboardAggregateRow = {
  coverage: Omit<CodeReviewAnalyticsCoverage, 'capturePercentage'>;
  summary: CodeReviewAnalyticsSummary;
  repository_options: string[];
  impact_breakdown: CodeReviewAnalyticsDashboard['impactBreakdown'];
  model_breakdown: CodeReviewAnalyticsDashboard['modelBreakdown'];
  finding_breakdown: CodeReviewAnalyticsDashboard['findingBreakdown'];
  security_breakdown: CodeReviewAnalyticsDashboard['securityBreakdown'];
  repositories: CodeReviewAnalyticsDashboard['repositories'];
  contributor_rows: CodeReviewAnalyticsContributorRow[];
};

function analyticsDashboardQuery(input: DashboardInput) {
  const repositoryCondition = input.repository
    ? sql`AND enrolled_reviews.repository = ${input.repository}`
    : sql``;

  return sql`
    WITH enrolled_reviews AS MATERIALIZED (
      SELECT
        ${cloud_agent_code_reviews.id} AS code_review_id,
        ${cloud_agent_code_reviews.repo_full_name} AS repository,
        ${cloud_agent_code_reviews.pr_number} AS pr_number,
        ${cloud_agent_code_reviews.platform_integration_id} AS platform_integration_id,
        ${cloud_agent_code_reviews.platform_project_id} AS platform_project_id,
        ${cloud_agent_code_reviews.pr_author} AS pr_author,
        ${cloud_agent_code_reviews.pr_author_github_id} AS pr_author_github_id,
        NULLIF(BTRIM(${cloud_agent_code_reviews.model}), '') AS review_model,
        latest_attempt.id AS source_attempt_id,
        ${code_review_analytics_results.id} AS analytics_result_id,
        COALESCE(${code_review_analytics_results.capture_status}, 'missing') AS capture_status,
        ${code_review_analytics_results.change_type} AS change_type,
        ${code_review_analytics_results.impact_level} AS impact_level,
        ${code_review_analytics_results.complexity_level} AS complexity_level,
        ${code_review_analytics_results.classification_confidence} AS classification_confidence,
        COALESCE(${code_review_analytics_results.finalized_at}, latest_attempt.completed_at) AS finalized_at
      FROM ${cloud_agent_code_reviews}
      INNER JOIN LATERAL (
        SELECT
          ${cloud_agent_code_review_attempts.id} AS id,
          ${cloud_agent_code_review_attempts.status} AS status,
          ${cloud_agent_code_review_attempts.analytics_enabled_at_dispatch} AS analytics_enabled_at_dispatch,
          ${cloud_agent_code_review_attempts.completed_at} AS completed_at
        FROM ${cloud_agent_code_review_attempts}
        WHERE ${cloud_agent_code_review_attempts.code_review_id} = ${cloud_agent_code_reviews.id}
        ORDER BY ${cloud_agent_code_review_attempts.attempt_number} DESC
        LIMIT 1
      ) latest_attempt ON TRUE
      LEFT JOIN ${code_review_analytics_results}
        ON ${code_review_analytics_results.code_review_id} = ${cloud_agent_code_reviews.id}
        AND ${code_review_analytics_results.source_attempt_id} = latest_attempt.id
      WHERE ${cloud_agent_code_reviews.status} = 'completed'
        AND ${cloud_agent_code_reviews.platform} = ${input.platform}
        AND ${cloud_agent_code_reviews.owned_by_organization_id} = ${input.owner.id}
        AND latest_attempt.status = 'completed'
        AND latest_attempt.analytics_enabled_at_dispatch IS TRUE
        AND latest_attempt.completed_at >= ${input.startDate}
        AND latest_attempt.completed_at < ${input.endDate}
    ), eligible_results AS MATERIALIZED (
      SELECT *
      FROM enrolled_reviews
      WHERE TRUE ${repositoryCondition}
    ), captured_results_base AS MATERIALIZED (
      SELECT *
      FROM eligible_results
      WHERE capture_status = 'captured'
        AND analytics_result_id IS NOT NULL
    ), scoped_findings AS MATERIALIZED (
      SELECT
        ${code_review_analytics_findings.analytics_result_id} AS analytics_result_id,
        ${code_review_analytics_findings.severity} AS severity,
        ${code_review_analytics_findings.category} AS category,
        ${code_review_analytics_findings.security_class} AS security_class
      FROM ${code_review_analytics_findings}
      INNER JOIN captured_results_base
        ON captured_results_base.analytics_result_id = ${code_review_analytics_findings.analytics_result_id}
    ), finding_counts AS (
      SELECT
        analytics_result_id,
        COUNT(*)::int AS total_findings,
        (COUNT(*) FILTER (WHERE severity = 'critical'))::int AS critical_findings,
        (COUNT(*) FILTER (WHERE severity = 'warning'))::int AS warning_findings,
        (COUNT(*) FILTER (WHERE severity = 'suggestion'))::int AS suggestion_findings
      FROM scoped_findings
      GROUP BY analytics_result_id
    ), captured_results AS MATERIALIZED (
      SELECT
        captured_results_base.*,
        COALESCE(finding_counts.total_findings, 0)::int AS total_findings,
        COALESCE(finding_counts.critical_findings, 0)::int AS critical_findings,
        COALESCE(finding_counts.warning_findings, 0)::int AS warning_findings,
        COALESCE(finding_counts.suggestion_findings, 0)::int AS suggestion_findings
      FROM captured_results_base
      LEFT JOIN finding_counts USING (analytics_result_id)
    ), logical_ranked AS (
      SELECT
        captured_results.*,
        ROW_NUMBER() OVER (
          PARTITION BY repository, pr_number,
            CASE WHEN ${input.platform} = 'gitlab' THEN platform_integration_id::text ELSE '' END,
            CASE WHEN ${input.platform} = 'gitlab' THEN platform_project_id::text ELSE '' END
          ORDER BY finalized_at DESC, code_review_id DESC
        ) AS logical_rank
      FROM captured_results
    ), latest_logical AS MATERIALIZED (
      SELECT * FROM logical_ranked WHERE logical_rank = 1
    ), coverage_stats AS (
      SELECT
        COUNT(*)::int AS enrolled_completed_reviews,
        (COUNT(*) FILTER (WHERE capture_status = 'captured'))::int AS captured,
        (COUNT(*) FILTER (WHERE capture_status = 'missing'))::int AS missing,
        (COUNT(*) FILTER (WHERE capture_status = 'invalid'))::int AS invalid,
        (COUNT(*) FILTER (WHERE capture_status = 'omitted'))::int AS omitted
      FROM eligible_results
    ), captured_summary AS (
      SELECT
        COUNT(*)::int AS tracked_reviews,
        COALESCE(SUM(total_findings), 0)::int AS total_findings,
        COALESCE(SUM(critical_findings), 0)::int AS critical_findings,
        COALESCE(SUM(warning_findings), 0)::int AS warning_findings
      FROM captured_results
    ), model_breakdown_rows AS (
      SELECT
        review_model,
        COUNT(*)::int AS tracked_reviews,
        COALESCE(SUM(total_findings), 0)::int AS total_findings,
        COALESCE(SUM(critical_findings), 0)::int AS critical_findings,
        COALESCE(SUM(warning_findings), 0)::int AS warning_findings,
        COALESCE(SUM(suggestion_findings), 0)::int AS suggestion_findings
      FROM captured_results
      GROUP BY review_model
      ORDER BY
        total_findings DESC,
        critical_findings DESC,
        warning_findings DESC,
        suggestion_findings DESC,
        review_model ASC NULLS LAST
    ), logical_summary AS (
      SELECT
        COUNT(*)::int AS tracked_prs,
        (COUNT(*) FILTER (
          WHERE classification_confidence <> 'low' AND impact_level = 'high'
        ))::int AS high_impact_changes,
        COALESCE(SUM(CASE
          WHEN classification_confidence = 'low' THEN 0
          WHEN impact_level = 'high' THEN 3
          WHEN impact_level = 'medium' THEN 2
          WHEN impact_level = 'low' THEN 1
          ELSE 0 END), 0)::int AS estimated_impact_points,
        (COUNT(*) FILTER (
          WHERE classification_confidence <> 'low' AND impact_level = 'low'
        ))::int AS impact_low,
        (COUNT(*) FILTER (
          WHERE classification_confidence <> 'low' AND impact_level = 'medium'
        ))::int AS impact_medium,
        (COUNT(*) FILTER (
          WHERE classification_confidence <> 'low' AND impact_level = 'high'
        ))::int AS impact_high,
        (COUNT(*) FILTER (WHERE classification_confidence = 'low'))::int AS impact_unclassified
      FROM latest_logical
    ), distribution_rows AS (
      SELECT
        'complexity'::text AS kind,
        complexity_level AS value,
        COUNT(*)::int AS count,
        (COUNT(*) FILTER (WHERE classification_confidence = 'low'))::int AS low_confidence_count
      FROM latest_logical
      GROUP BY complexity_level
      UNION ALL
      SELECT
        'change_type'::text AS kind,
        change_type AS value,
        COUNT(*)::int AS count,
        (COUNT(*) FILTER (WHERE classification_confidence = 'low'))::int AS low_confidence_count
      FROM latest_logical
      GROUP BY change_type
    ), finding_breakdown_rows AS (
      SELECT
        category AS value,
        COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE severity = 'critical'))::int AS critical,
        (COUNT(*) FILTER (WHERE severity = 'warning'))::int AS warning,
        (COUNT(*) FILTER (WHERE severity = 'suggestion'))::int AS suggestion
      FROM scoped_findings
      GROUP BY category
    ), security_breakdown_rows AS (
      SELECT
        security_class AS value,
        COUNT(*)::int AS total,
        (COUNT(*) FILTER (WHERE severity = 'critical'))::int AS critical,
        (COUNT(*) FILTER (WHERE severity = 'warning'))::int AS warning,
        (COUNT(*) FILTER (WHERE severity = 'suggestion'))::int AS suggestion
      FROM scoped_findings
      WHERE category = 'security'
      GROUP BY security_class
    ), repository_impact AS (
      SELECT
        repository,
        COUNT(*)::int AS tracked_prs,
        COALESCE(SUM(CASE
          WHEN classification_confidence = 'low' THEN 0
          WHEN impact_level = 'high' THEN 3
          WHEN impact_level = 'medium' THEN 2
          WHEN impact_level = 'low' THEN 1
          ELSE 0 END), 0)::int AS estimated_impact_points,
        (COUNT(*) FILTER (
          WHERE classification_confidence <> 'low' AND impact_level = 'high'
        ))::int AS high_impact_changes
      FROM latest_logical
      GROUP BY repository
    ), repository_findings AS (
      SELECT
        repository,
        COALESCE(SUM(critical_findings), 0)::int AS critical_findings,
        COALESCE(SUM(warning_findings), 0)::int AS warning_findings,
        COALESCE(SUM(suggestion_findings), 0)::int AS suggestion_findings
      FROM captured_results
      GROUP BY repository
    ), repository_rows AS (
      SELECT
        repository_impact.repository,
        repository_impact.tracked_prs,
        repository_impact.estimated_impact_points,
        repository_impact.high_impact_changes,
        COALESCE(repository_findings.critical_findings, 0)::int AS critical_findings,
        COALESCE(repository_findings.warning_findings, 0)::int AS warning_findings,
        COALESCE(repository_findings.suggestion_findings, 0)::int AS suggestion_findings
      FROM repository_impact
      LEFT JOIN repository_findings USING (repository)
      ORDER BY
        (COALESCE(repository_findings.critical_findings, 0) +
          COALESCE(repository_findings.warning_findings, 0) +
          COALESCE(repository_findings.suggestion_findings, 0)) DESC,
        repository_impact.estimated_impact_points DESC,
        repository_impact.repository ASC
      LIMIT 50
    ), logical_findings AS (
      SELECT
        repository,
        pr_number,
        COALESCE(SUM(critical_findings), 0)::int AS critical_findings,
        COALESCE(SUM(warning_findings), 0)::int AS warning_findings,
        COALESCE(SUM(suggestion_findings), 0)::int AS suggestion_findings
      FROM captured_results
      WHERE ${input.platform} = 'github'
      GROUP BY repository, pr_number
    ), contributor_prs AS (
      SELECT
        CASE
          WHEN latest_logical.pr_author_github_id IS NOT NULL
            THEN 'github-id:' || latest_logical.pr_author_github_id
          ELSE 'legacy-login:' || CASE
            WHEN BTRIM(latest_logical.pr_author) <> ''
              THEN LOWER(BTRIM(latest_logical.pr_author))
            ELSE 'unknown:' || latest_logical.repository || '#' || latest_logical.pr_number::text
          END
        END AS contributor_key,
        latest_logical.pr_author AS display_name,
        latest_logical.pr_author_github_id IS NULL AS limited_identity,
        latest_logical.finalized_at,
        latest_logical.classification_confidence,
        latest_logical.impact_level,
        COALESCE(logical_findings.critical_findings, 0)::int AS critical_findings,
        COALESCE(logical_findings.warning_findings, 0)::int AS warning_findings,
        COALESCE(logical_findings.suggestion_findings, 0)::int AS suggestion_findings
      FROM latest_logical
      LEFT JOIN logical_findings USING (repository, pr_number)
      WHERE ${input.platform} = 'github'
    ), contributor_rows AS (
      SELECT
        contributor_key,
        (ARRAY_AGG(display_name ORDER BY finalized_at DESC, display_name))[1] AS display_name,
        BOOL_OR(limited_identity) AS limited_identity,
        COUNT(*)::int AS tracked_prs,
        COALESCE(SUM(CASE
          WHEN classification_confidence = 'low' THEN 0
          WHEN impact_level = 'high' THEN 3
          WHEN impact_level = 'medium' THEN 2
          WHEN impact_level = 'low' THEN 1
          ELSE 0 END), 0)::int AS estimated_impact_points,
        (COUNT(*) FILTER (
          WHERE classification_confidence <> 'low' AND impact_level = 'high'
        ))::int AS high_impact_prs,
        COALESCE(SUM(critical_findings), 0)::int AS critical_findings,
        COALESCE(SUM(warning_findings), 0)::int AS warning_findings,
        COALESCE(SUM(suggestion_findings), 0)::int AS suggestion_findings,
        (COUNT(*) FILTER (WHERE critical_findings = 0))::int AS prs_without_critical_findings
      FROM contributor_prs
      GROUP BY contributor_key
      ORDER BY
        (COUNT(*) >= 5) DESC,
        estimated_impact_points DESC,
        high_impact_prs DESC,
        tracked_prs DESC,
        contributor_key ASC
      LIMIT 50
    )
    SELECT
      jsonb_build_object(
        'enrolledCompletedReviews', coverage_stats.enrolled_completed_reviews,
        'captured', coverage_stats.captured,
        'missing', coverage_stats.missing,
        'invalid', coverage_stats.invalid,
        'omitted', coverage_stats.omitted
      ) AS coverage,
      jsonb_build_object(
        'trackedReviews', captured_summary.tracked_reviews,
        'trackedPrsOrMrs', logical_summary.tracked_prs,
        'totalFindings', captured_summary.total_findings,
        'criticalFindings', captured_summary.critical_findings,
        'warningFindings', captured_summary.warning_findings,
        'highImpactChanges', logical_summary.high_impact_changes,
        'estimatedImpactPoints', logical_summary.estimated_impact_points
      ) AS summary,
      COALESCE((
        SELECT jsonb_agg(repository_options.repository ORDER BY repository_options.repository)
        FROM (
          SELECT DISTINCT repository
          FROM enrolled_reviews
          ORDER BY repository
          LIMIT 100
        ) repository_options
      ), '[]'::jsonb) AS repository_options,
      jsonb_build_object(
        'impact', jsonb_build_object(
          'low', logical_summary.impact_low,
          'medium', logical_summary.impact_medium,
          'high', logical_summary.impact_high,
          'unclassified', logical_summary.impact_unclassified
        ),
        'complexity', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'value', value,
            'count', count,
            'lowConfidenceCount', low_confidence_count
          ) ORDER BY value)
          FROM distribution_rows
          WHERE kind = 'complexity'
        ), '[]'::jsonb),
        'changeTypes', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'value', value,
            'count', count,
            'lowConfidenceCount', low_confidence_count
          ) ORDER BY value)
          FROM distribution_rows
          WHERE kind = 'change_type'
        ), '[]'::jsonb)
      ) AS impact_breakdown,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'model', review_model,
          'trackedReviews', tracked_reviews,
          'totalFindings', total_findings,
          'criticalFindings', critical_findings,
          'warningFindings', warning_findings,
          'suggestionFindings', suggestion_findings
        ) ORDER BY
          total_findings DESC,
          critical_findings DESC,
          warning_findings DESC,
          suggestion_findings DESC,
          review_model ASC NULLS LAST)
        FROM model_breakdown_rows
      ), '[]'::jsonb) AS model_breakdown,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'value', value,
          'total', total,
          'critical', critical,
          'warning', warning,
          'suggestion', suggestion
        ) ORDER BY total DESC, value ASC)
        FROM finding_breakdown_rows
      ), '[]'::jsonb) AS finding_breakdown,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'value', value,
          'total', total,
          'critical', critical,
          'warning', warning,
          'suggestion', suggestion
        ) ORDER BY total DESC, value ASC)
        FROM security_breakdown_rows
      ), '[]'::jsonb) AS security_breakdown,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'repository', repository,
          'trackedPrsOrMrs', tracked_prs,
          'estimatedImpactPoints', estimated_impact_points,
          'highImpactChanges', high_impact_changes,
          'criticalFindings', critical_findings,
          'warningFindings', warning_findings,
          'suggestionFindings', suggestion_findings
        ) ORDER BY
          (critical_findings + warning_findings + suggestion_findings) DESC,
          estimated_impact_points DESC,
          repository ASC)
        FROM repository_rows
      ), '[]'::jsonb) AS repositories,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'contributorKey', contributor_key,
          'displayName', display_name,
          'limitedIdentity', limited_identity,
          'limitedData', tracked_prs < 5,
          'trackedPrs', tracked_prs,
          'estimatedImpactPoints', estimated_impact_points,
          'highImpactPrs', high_impact_prs,
          'criticalFindings', critical_findings,
          'warningFindings', warning_findings,
          'suggestionFindings', suggestion_findings,
          'prsWithoutCriticalFindings', prs_without_critical_findings
        ) ORDER BY
          (tracked_prs >= 5) DESC,
          estimated_impact_points DESC,
          high_impact_prs DESC,
          tracked_prs DESC,
          contributor_key ASC)
        FROM contributor_rows
      ), '[]'::jsonb) AS contributor_rows
    FROM coverage_stats
    CROSS JOIN captured_summary
    CROSS JOIN logical_summary
  `;
}

export async function getCodeReviewAnalyticsDashboard(
  input: DashboardInput
): Promise<CodeReviewAnalyticsDashboard> {
  const ownerCondition = and(
    eq(agent_configs.owned_by_organization_id, input.owner.id),
    eq(agent_configs.agent_type, 'code_review'),
    eq(agent_configs.platform, input.platform)
  );
  const [config] = await input.db
    .select({ config: agent_configs.config })
    .from(agent_configs)
    .where(ownerCondition)
    .limit(1);
  const dashboardResult = await input.db.execute<DashboardAggregateRow>(
    analyticsDashboardQuery(input)
  );
  const dashboard = dashboardResult.rows[0];
  if (!dashboard) {
    throw new Error('Code Reviewer analytics dashboard query returned no row');
  }

  const { enrolledCompletedReviews, captured } = dashboard.coverage;
  const contributorCapability =
    input.platform === 'github' ? 'available' : 'stable_gitlab_author_attribution_unavailable';

  return {
    settings: {
      enabled: getReviewAnalyticsEnabledFromConfig(config?.config),
      canManage: input.canManage,
      platform: input.platform,
    },
    coverage: {
      ...dashboard.coverage,
      capturePercentage:
        enrolledCompletedReviews === 0 ? null : (captured / enrolledCompletedReviews) * 100,
    },
    summary: dashboard.summary,
    repositoryOptions: dashboard.repository_options,
    impactBreakdown: dashboard.impact_breakdown,
    modelBreakdown: dashboard.model_breakdown,
    findingBreakdown: dashboard.finding_breakdown,
    securityBreakdown: dashboard.security_breakdown,
    repositories: dashboard.repositories,
    contributors: {
      capability: contributorCapability,
      rows: contributorCapability === 'available' ? dashboard.contributor_rows : [],
    },
  };
}
