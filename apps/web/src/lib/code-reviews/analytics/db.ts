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

function numberValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

function analyticsBaseCte(input: DashboardInput, applyRepositoryFilter: boolean) {
  const ownerCondition = sql`${cloud_agent_code_reviews.owned_by_organization_id} = ${input.owner.id}`;
  const repositoryCondition =
    applyRepositoryFilter && input.repository
      ? sql`AND ${cloud_agent_code_reviews.repo_full_name} = ${input.repository}`
      : sql``;

  return sql`
    WITH latest_attempts AS (
      SELECT DISTINCT ON (${cloud_agent_code_review_attempts.code_review_id})
        ${cloud_agent_code_review_attempts.id},
        ${cloud_agent_code_review_attempts.code_review_id},
        ${cloud_agent_code_review_attempts.status},
        ${cloud_agent_code_review_attempts.analytics_enabled_at_dispatch}
      FROM ${cloud_agent_code_review_attempts}
      ORDER BY ${cloud_agent_code_review_attempts.code_review_id}, ${cloud_agent_code_review_attempts.attempt_number} DESC
    ), eligible_results AS (
      SELECT
        ${code_review_analytics_results.id} AS analytics_result_id,
        ${cloud_agent_code_reviews.id} AS code_review_id,
        ${cloud_agent_code_reviews.repo_full_name} AS repository,
        ${cloud_agent_code_reviews.pr_number} AS pr_number,
        ${cloud_agent_code_reviews.platform_integration_id} AS platform_integration_id,
        ${cloud_agent_code_reviews.platform_project_id} AS platform_project_id,
        ${cloud_agent_code_reviews.pr_author} AS pr_author,
        ${cloud_agent_code_reviews.pr_author_github_id} AS pr_author_github_id,
        ${code_review_analytics_results.capture_status} AS capture_status,
        ${code_review_analytics_results.change_type} AS change_type,
        ${code_review_analytics_results.impact_level} AS impact_level,
        ${code_review_analytics_results.complexity_level} AS complexity_level,
        ${code_review_analytics_results.classification_confidence} AS classification_confidence,
        ${code_review_analytics_results.finalized_at} AS finalized_at
      FROM ${code_review_analytics_results}
      INNER JOIN ${cloud_agent_code_reviews}
        ON ${cloud_agent_code_reviews.id} = ${code_review_analytics_results.code_review_id}
      INNER JOIN latest_attempts
        ON latest_attempts.code_review_id = ${cloud_agent_code_reviews.id}
        AND latest_attempts.id = ${code_review_analytics_results.source_attempt_id}
      WHERE ${cloud_agent_code_reviews.status} = 'completed'
        AND latest_attempts.status = 'completed'
        AND latest_attempts.analytics_enabled_at_dispatch IS TRUE
        AND ${code_review_analytics_results.finalized_at} >= ${input.startDate}
        AND ${code_review_analytics_results.finalized_at} < ${input.endDate}
        AND ${cloud_agent_code_reviews.platform} = ${input.platform}
        AND ${ownerCondition}
        ${repositoryCondition}
    ), finding_counts AS (
      SELECT
        ${code_review_analytics_findings.analytics_result_id} AS analytics_result_id,
        COUNT(*)::int AS total_findings,
        COUNT(*) FILTER (WHERE ${code_review_analytics_findings.severity} = 'critical')::int AS critical_findings,
        COUNT(*) FILTER (WHERE ${code_review_analytics_findings.severity} = 'warning')::int AS warning_findings,
        COUNT(*) FILTER (WHERE ${code_review_analytics_findings.severity} = 'suggestion')::int AS suggestion_findings
      FROM ${code_review_analytics_findings}
      GROUP BY ${code_review_analytics_findings.analytics_result_id}
    ), captured_results AS (
      SELECT
        eligible_results.*,
        COALESCE(finding_counts.total_findings, 0)::int AS total_findings,
        COALESCE(finding_counts.critical_findings, 0)::int AS critical_findings,
        COALESCE(finding_counts.warning_findings, 0)::int AS warning_findings,
        COALESCE(finding_counts.suggestion_findings, 0)::int AS suggestion_findings
      FROM eligible_results
      LEFT JOIN finding_counts USING (analytics_result_id)
      WHERE eligible_results.capture_status = 'captured'
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
    ), latest_logical AS (
      SELECT * FROM logical_ranked WHERE logical_rank = 1
    )
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

  const repositoryOptionResult = await input.db.execute<{ repository: string }>(sql`
    ${analyticsBaseCte(input, false)}
    SELECT DISTINCT repository
    FROM eligible_results
    ORDER BY repository ASC
    LIMIT 100
  `);

  const summaryResult = await input.db.execute<{
    enrolled_completed_reviews: number | string;
    captured: number | string;
    missing: number | string;
    invalid: number | string;
    omitted: number | string;
    tracked_reviews: number | string;
    tracked_prs: number | string;
    total_findings: number | string;
    critical_findings: number | string;
    warning_findings: number | string;
    high_impact_changes: number | string;
    estimated_impact_points: number | string;
    impact_low: number | string;
    impact_medium: number | string;
    impact_high: number | string;
    impact_unclassified: number | string;
  }>(sql`
    ${analyticsBaseCte(input, true)}
    SELECT
      (SELECT COUNT(*) FROM eligible_results) AS enrolled_completed_reviews,
      (SELECT COUNT(*) FROM eligible_results WHERE capture_status = 'captured') AS captured,
      (SELECT COUNT(*) FROM eligible_results WHERE capture_status = 'missing') AS missing,
      (SELECT COUNT(*) FROM eligible_results WHERE capture_status = 'invalid') AS invalid,
      (SELECT COUNT(*) FROM eligible_results WHERE capture_status = 'omitted') AS omitted,
      (SELECT COUNT(*) FROM captured_results) AS tracked_reviews,
      (SELECT COUNT(*) FROM latest_logical) AS tracked_prs,
      (SELECT COALESCE(SUM(total_findings), 0) FROM captured_results) AS total_findings,
      (SELECT COALESCE(SUM(critical_findings), 0) FROM captured_results) AS critical_findings,
      (SELECT COALESCE(SUM(warning_findings), 0) FROM captured_results) AS warning_findings,
      (SELECT COUNT(*) FROM latest_logical WHERE classification_confidence <> 'low' AND impact_level = 'high') AS high_impact_changes,
      (SELECT COALESCE(SUM(CASE
        WHEN classification_confidence = 'low' THEN 0
        WHEN impact_level = 'high' THEN 3
        WHEN impact_level = 'medium' THEN 2
        WHEN impact_level = 'low' THEN 1
        ELSE 0 END), 0) FROM latest_logical) AS estimated_impact_points,
      (SELECT COUNT(*) FROM latest_logical WHERE classification_confidence <> 'low' AND impact_level = 'low') AS impact_low,
      (SELECT COUNT(*) FROM latest_logical WHERE classification_confidence <> 'low' AND impact_level = 'medium') AS impact_medium,
      (SELECT COUNT(*) FROM latest_logical WHERE classification_confidence <> 'low' AND impact_level = 'high') AS impact_high,
      (SELECT COUNT(*) FROM latest_logical WHERE classification_confidence = 'low') AS impact_unclassified
  `);
  const summaryRow = summaryResult.rows[0];
  if (!summaryRow) {
    throw new Error('Code Reviewer analytics summary query returned no row');
  }

  const distributionResult = await input.db.execute<{
    kind: 'complexity' | 'change_type';
    value: string;
    count: number | string;
    low_confidence_count: number | string;
  }>(sql`
    ${analyticsBaseCte(input, true)}
    SELECT
      'complexity' AS kind,
      complexity_level AS value,
      COUNT(*) AS count,
      COUNT(*) FILTER (WHERE classification_confidence = 'low') AS low_confidence_count
    FROM latest_logical
    GROUP BY complexity_level
    UNION ALL
    SELECT
      'change_type' AS kind,
      change_type AS value,
      COUNT(*) AS count,
      COUNT(*) FILTER (WHERE classification_confidence = 'low') AS low_confidence_count
    FROM latest_logical
    GROUP BY change_type
  `);

  const findingBreakdownResult = await input.db.execute<{
    value: CodeReviewFindingCategory;
    total: number | string;
    critical: number | string;
    warning: number | string;
    suggestion: number | string;
  }>(sql`
    ${analyticsBaseCte(input, true)}
    SELECT
      findings.category AS value,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE findings.severity = 'critical') AS critical,
      COUNT(*) FILTER (WHERE findings.severity = 'warning') AS warning,
      COUNT(*) FILTER (WHERE findings.severity = 'suggestion') AS suggestion
    FROM ${code_review_analytics_findings} findings
    INNER JOIN captured_results ON captured_results.analytics_result_id = findings.analytics_result_id
    GROUP BY findings.category
    ORDER BY total DESC, value ASC
  `);

  const securityBreakdownResult = await input.db.execute<{
    value: CodeReviewFindingSecurityClass;
    total: number | string;
    critical: number | string;
    warning: number | string;
    suggestion: number | string;
  }>(sql`
    ${analyticsBaseCte(input, true)}
    SELECT
      findings.security_class AS value,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE findings.severity = 'critical') AS critical,
      COUNT(*) FILTER (WHERE findings.severity = 'warning') AS warning,
      COUNT(*) FILTER (WHERE findings.severity = 'suggestion') AS suggestion
    FROM ${code_review_analytics_findings} findings
    INNER JOIN captured_results ON captured_results.analytics_result_id = findings.analytics_result_id
    WHERE findings.category = 'security'
    GROUP BY findings.security_class
    ORDER BY total DESC, value ASC
  `);

  const repositoryResult = await input.db.execute<{
    repository: string;
    tracked_prs: number | string;
    estimated_impact_points: number | string;
    high_impact_changes: number | string;
    critical_findings: number | string;
    warning_findings: number | string;
    suggestion_findings: number | string;
  }>(sql`
    ${analyticsBaseCte(input, true)},
    repository_impact AS (
      SELECT
        repository,
        COUNT(*) AS tracked_prs,
        COALESCE(SUM(CASE
          WHEN classification_confidence = 'low' THEN 0
          WHEN impact_level = 'high' THEN 3
          WHEN impact_level = 'medium' THEN 2
          WHEN impact_level = 'low' THEN 1
          ELSE 0 END), 0) AS estimated_impact_points,
        COUNT(*) FILTER (WHERE classification_confidence <> 'low' AND impact_level = 'high') AS high_impact_changes
      FROM latest_logical
      GROUP BY repository
    ), repository_findings AS (
      SELECT
        repository,
        COALESCE(SUM(critical_findings), 0) AS critical_findings,
        COALESCE(SUM(warning_findings), 0) AS warning_findings,
        COALESCE(SUM(suggestion_findings), 0) AS suggestion_findings
      FROM captured_results
      GROUP BY repository
    )
    SELECT
      repository_impact.repository,
      repository_impact.tracked_prs,
      repository_impact.estimated_impact_points,
      repository_impact.high_impact_changes,
      COALESCE(repository_findings.critical_findings, 0) AS critical_findings,
      COALESCE(repository_findings.warning_findings, 0) AS warning_findings,
      COALESCE(repository_findings.suggestion_findings, 0) AS suggestion_findings
    FROM repository_impact
    LEFT JOIN repository_findings USING (repository)
    ORDER BY
      (COALESCE(repository_findings.critical_findings, 0) + COALESCE(repository_findings.warning_findings, 0) + COALESCE(repository_findings.suggestion_findings, 0)) DESC,
      repository_impact.estimated_impact_points DESC,
      repository_impact.repository ASC
    LIMIT 50
  `);

  let contributorRows: CodeReviewAnalyticsContributorRow[] = [];
  const contributorCapability =
    input.platform === 'github' ? 'available' : 'stable_gitlab_author_attribution_unavailable';

  if (contributorCapability === 'available') {
    const contributorResult = await input.db.execute<{
      contributor_key: string;
      display_name: string;
      limited_identity: boolean;
      tracked_prs: number | string;
      estimated_impact_points: number | string;
      high_impact_prs: number | string;
      critical_findings: number | string;
      warning_findings: number | string;
      suggestion_findings: number | string;
      prs_without_critical_findings: number | string;
    }>(sql`
      ${analyticsBaseCte(input, true)},
      logical_findings AS (
        SELECT
          repository,
          pr_number,
          COALESCE(SUM(critical_findings), 0) AS critical_findings,
          COALESCE(SUM(warning_findings), 0) AS warning_findings,
          COALESCE(SUM(suggestion_findings), 0) AS suggestion_findings
        FROM captured_results
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
          COALESCE(logical_findings.critical_findings, 0) AS critical_findings,
          COALESCE(logical_findings.warning_findings, 0) AS warning_findings,
          COALESCE(logical_findings.suggestion_findings, 0) AS suggestion_findings
        FROM latest_logical
        LEFT JOIN logical_findings USING (repository, pr_number)
      )
      SELECT
        contributor_key,
        (ARRAY_AGG(display_name ORDER BY finalized_at DESC, display_name))[1] AS display_name,
        BOOL_OR(limited_identity) AS limited_identity,
        COUNT(*) AS tracked_prs,
        COALESCE(SUM(CASE
          WHEN classification_confidence = 'low' THEN 0
          WHEN impact_level = 'high' THEN 3
          WHEN impact_level = 'medium' THEN 2
          WHEN impact_level = 'low' THEN 1
          ELSE 0 END), 0) AS estimated_impact_points,
        COUNT(*) FILTER (WHERE classification_confidence <> 'low' AND impact_level = 'high') AS high_impact_prs,
        COALESCE(SUM(critical_findings), 0) AS critical_findings,
        COALESCE(SUM(warning_findings), 0) AS warning_findings,
        COALESCE(SUM(suggestion_findings), 0) AS suggestion_findings,
        COUNT(*) FILTER (WHERE critical_findings = 0) AS prs_without_critical_findings
      FROM contributor_prs
      GROUP BY contributor_key
      ORDER BY
        (COUNT(*) >= 5) DESC,
        estimated_impact_points DESC,
        high_impact_prs DESC,
        tracked_prs DESC,
        contributor_key ASC
      LIMIT 50
    `);

    contributorRows = contributorResult.rows.map(row => {
      const trackedPrs = numberValue(row.tracked_prs);
      return {
        contributorKey: row.contributor_key,
        displayName: row.display_name,
        limitedIdentity: row.limited_identity,
        limitedData: trackedPrs < 5,
        trackedPrs,
        estimatedImpactPoints: numberValue(row.estimated_impact_points),
        highImpactPrs: numberValue(row.high_impact_prs),
        criticalFindings: numberValue(row.critical_findings),
        warningFindings: numberValue(row.warning_findings),
        suggestionFindings: numberValue(row.suggestion_findings),
        prsWithoutCriticalFindings: numberValue(row.prs_without_critical_findings),
      };
    });
  }

  const enrolledCompletedReviews = numberValue(summaryRow.enrolled_completed_reviews);
  const captured = numberValue(summaryRow.captured);
  const complexity: CodeReviewAnalyticsDashboard['impactBreakdown']['complexity'] = [];
  const changeTypes: CodeReviewAnalyticsDashboard['impactBreakdown']['changeTypes'] = [];
  for (const row of distributionResult.rows) {
    const normalized = {
      value: row.value,
      count: numberValue(row.count),
      lowConfidenceCount: numberValue(row.low_confidence_count),
    };
    if (row.kind === 'complexity') {
      complexity.push(
        normalized as CodeReviewAnalyticsDistributionRow<CodeReviewAnalyticsComplexityLevel>
      );
    } else {
      changeTypes.push(
        normalized as CodeReviewAnalyticsDistributionRow<CodeReviewAnalyticsChangeType>
      );
    }
  }

  return {
    settings: {
      enabled: getReviewAnalyticsEnabledFromConfig(config?.config),
      canManage: input.canManage,
      platform: input.platform,
    },
    coverage: {
      enrolledCompletedReviews,
      captured,
      missing: numberValue(summaryRow.missing),
      invalid: numberValue(summaryRow.invalid),
      omitted: numberValue(summaryRow.omitted),
      capturePercentage:
        enrolledCompletedReviews === 0 ? null : (captured / enrolledCompletedReviews) * 100,
    },
    summary: {
      trackedReviews: numberValue(summaryRow.tracked_reviews),
      trackedPrsOrMrs: numberValue(summaryRow.tracked_prs),
      totalFindings: numberValue(summaryRow.total_findings),
      criticalFindings: numberValue(summaryRow.critical_findings),
      warningFindings: numberValue(summaryRow.warning_findings),
      highImpactChanges: numberValue(summaryRow.high_impact_changes),
      estimatedImpactPoints: numberValue(summaryRow.estimated_impact_points),
    },
    repositoryOptions: repositoryOptionResult.rows.map(row => row.repository),
    impactBreakdown: {
      impact: {
        low: numberValue(summaryRow.impact_low),
        medium: numberValue(summaryRow.impact_medium),
        high: numberValue(summaryRow.impact_high),
        unclassified: numberValue(summaryRow.impact_unclassified),
      },
      complexity,
      changeTypes,
    },
    findingBreakdown: findingBreakdownResult.rows.map(row => ({
      value: row.value,
      total: numberValue(row.total),
      critical: numberValue(row.critical),
      warning: numberValue(row.warning),
      suggestion: numberValue(row.suggestion),
    })),
    securityBreakdown: securityBreakdownResult.rows.map(row => ({
      value: row.value,
      total: numberValue(row.total),
      critical: numberValue(row.critical),
      warning: numberValue(row.warning),
      suggestion: numberValue(row.suggestion),
    })),
    repositories: repositoryResult.rows.map(row => ({
      repository: row.repository,
      trackedPrsOrMrs: numberValue(row.tracked_prs),
      estimatedImpactPoints: numberValue(row.estimated_impact_points),
      highImpactChanges: numberValue(row.high_impact_changes),
      criticalFindings: numberValue(row.critical_findings),
      warningFindings: numberValue(row.warning_findings),
      suggestionFindings: numberValue(row.suggestion_findings),
    })),
    contributors: {
      capability: contributorCapability,
      rows: contributorRows,
    },
  };
}
