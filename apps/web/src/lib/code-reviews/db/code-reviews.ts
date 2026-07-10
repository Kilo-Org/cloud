/**
 * Code Reviews - Database Operations
 *
 * Database operations for cloud agent code reviews.
 * Follows Drizzle ORM patterns used throughout the codebase.
 */

import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  agent_configs,
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { eq, and, asc, desc, count, ne, inArray, sql, sum, gte, lte, isNull } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { CreateReviewParamsSchema } from '../core';
import { assertCouncilCreationAllowed } from '../core/council-entitlement';
import type {
  CodeReviewPlatform,
  CreateReviewParams,
  CodeReviewStatus,
  ListReviewsParams,
  Owner,
} from '../core';
import type { CloudAgentCodeReview, CloudAgentCodeReviewAttempt } from '@kilocode/db/schema';
import type { CodeReviewTerminalReason } from '@kilocode/db/schema-types';
import { isCodeReviewActionRequiredReason } from '../action-required-shared';
import {
  activeCodeReviewWorkCondition,
  reconsiderableCodeReviewWorkCondition,
  FUNDED_CODE_REVIEW_BALANCE_THRESHOLD_MICRODOLLARS,
  MAX_CONCURRENT_CODE_REVIEWS_PER_DEFAULT_USER,
  MAX_CONCURRENT_CODE_REVIEWS_PER_FUNDED_USER,
  MAX_CONCURRENT_CODE_REVIEWS_PER_ORG,
  staleQueuedCodeReviewCutoffSql,
  staleRunningCodeReviewCutoffSql,
  type PendingCodeReviewCreatedAtWindow,
} from '../dispatch/dispatch-constants';

type CodeReviewAttemptStatus = CodeReviewStatus;

type InfraRetryAttemptResult =
  | {
      outcome: 'created';
      attempt: CloudAgentCodeReviewAttempt;
    }
  | {
      outcome: 'existing-for-attempt';
      attempt: CloudAgentCodeReviewAttempt;
    }
  | {
      outcome: 'existing-for-review';
      attempt: CloudAgentCodeReviewAttempt;
    }
  | {
      outcome: 'skipped-inactive';
      reviewStatus: string;
      terminalReason: string | null;
    };

type AttemptCallbackFields = {
  codeReviewId: string;
  attemptId?: string;
  status: CodeReviewAttemptStatus;
  sessionId?: string;
  cliSessionId?: string;
  executionId?: string;
  errorMessage?: string;
  terminalReason?: CodeReviewTerminalReason;
  startedAt?: Date;
  completedAt?: Date;
};

export type DispatchableCodeReviewOwnerCandidate =
  | { type: 'user'; id: string }
  | { type: 'org'; id: string };

export type DispatchableCodeReviewOwnerCandidatesResult = {
  owners: DispatchableCodeReviewOwnerCandidate[];
  hasMore: boolean;
};

export type ReviewScope = {
  owner: Owner;
  platform: CodeReviewPlatform;
  repoFullName: string;
  prNumber: number;
  platformIntegrationId?: string;
};

function reviewScopeConditions(scope: ReviewScope) {
  return [
    scope.owner.type === 'org'
      ? eq(cloud_agent_code_reviews.owned_by_organization_id, scope.owner.id)
      : eq(cloud_agent_code_reviews.owned_by_user_id, scope.owner.id),
    eq(cloud_agent_code_reviews.platform, scope.platform),
    eq(cloud_agent_code_reviews.repo_full_name, scope.repoFullName),
    eq(cloud_agent_code_reviews.pr_number, scope.prNumber),
    ...(scope.platformIntegrationId
      ? [
          eq(cloud_agent_code_reviews.platform_integration_id, scope.platformIntegrationId),
          isNull(cloud_agent_code_reviews.manual_config),
        ]
      : []),
  ];
}

function providerPublishingCondition() {
  return sql`(${cloud_agent_code_reviews.manual_config} IS NULL OR ${cloud_agent_code_reviews.manual_config}->>'outputMode' = 'provider')`;
}

function isTerminalCodeReviewStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function buildAttemptUpdateData(
  fields: Omit<AttemptCallbackFields, 'codeReviewId'>
): Partial<typeof cloud_agent_code_review_attempts.$inferInsert> {
  const updateData: Partial<typeof cloud_agent_code_review_attempts.$inferInsert> = {
    status: fields.status,
    updated_at: new Date().toISOString(),
  };

  if (fields.sessionId !== undefined) updateData.session_id = fields.sessionId;
  if (fields.cliSessionId !== undefined) updateData.cli_session_id = fields.cliSessionId;
  if (fields.executionId !== undefined) updateData.execution_id = fields.executionId;
  if (fields.errorMessage !== undefined) updateData.error_message = fields.errorMessage;
  if (fields.terminalReason !== undefined) updateData.terminal_reason = fields.terminalReason;
  if (fields.startedAt !== undefined) updateData.started_at = fields.startedAt.toISOString();
  if (fields.completedAt !== undefined) updateData.completed_at = fields.completedAt.toISOString();

  if (fields.status === 'running' && !fields.startedAt) {
    updateData.started_at = new Date().toISOString();
  }
  if (isTerminalCodeReviewStatus(fields.status) && !fields.completedAt) {
    updateData.completed_at = new Date().toISOString();
  }

  return updateData;
}
export type CancelledReviewRow = {
  id: string;
  prevStatus: 'pending' | 'queued' | 'running';
  sessionId: string | null;
  latestActiveAttemptId: string | null;
  checkRunId: number | null;
  headSha: string;
  platform: CodeReviewPlatform;
  platformProjectId: number | null;
  platformIntegrationId: string | null;
};

type CodeReviewDatabase = typeof db | DrizzleTransaction;

const RETRYABLE_PARENT_REVIEW_STATUSES = ['queued', 'running'];

function canCreateInfraRetryAttempt(review: { status: string; terminal_reason: string | null }) {
  return (
    review.terminal_reason !== 'superseded' &&
    !isCodeReviewActionRequiredReason(review.terminal_reason) &&
    RETRYABLE_PARENT_REVIEW_STATUSES.includes(review.status)
  );
}

function createCodeReviewErrorMetadata(params: CreateReviewParams) {
  return {
    owner: params.owner,
    platformIntegrationId: params.platformIntegrationId,
    repoFullName: params.repoFullName,
    prNumber: params.prNumber,
    prUrl: params.prUrl,
    headSha: params.headSha,
    platform: params.platform,
    platformProjectId: params.platformProjectId,
    manualConfig: params.manualConfig
      ? {
          outputMode: params.manualConfig.outputMode,
          hasInstructions: params.manualConfig.instructions !== null,
          modelSlug: params.manualConfig.agentConfig.model_slug,
          thinkingEffort: params.manualConfig.agentConfig.thinking_effort ?? null,
        }
      : null,
  };
}

function codeReviewInsertValues(
  params: CreateReviewParams
): typeof cloud_agent_code_reviews.$inferInsert {
  return {
    owned_by_organization_id: params.owner.type === 'org' ? params.owner.id : null,
    owned_by_user_id: params.owner.type === 'user' ? params.owner.id : null,
    platform_integration_id: params.platformIntegrationId,
    repo_full_name: params.repoFullName,
    pr_number: params.prNumber,
    pr_url: params.prUrl,
    pr_title: params.prTitle,
    pr_author: params.prAuthor,
    pr_author_github_id: params.prAuthorGithubId || null,
    base_ref: params.baseRef,
    head_ref: params.headRef,
    head_sha: params.headSha,
    platform: params.platform ?? 'github',
    platform_project_id: params.platformProjectId ?? null,
    manual_config: params.manualConfig ?? null,
    review_type: params.reviewType ?? 'standard',
    trigger_source: params.triggerSource ?? null,
    agent_version: 'v2',
    status: 'pending',
  };
}

/**
 * Creates a new code review record
 * Returns the created review ID
 */
export async function createCodeReview(params: CreateReviewParams): Promise<string> {
  try {
    CreateReviewParamsSchema.parse(params);
    await assertCouncilCreationAllowed({ owner: params.owner, reviewType: params.reviewType });
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values(codeReviewInsertValues(params))
      .returning({ id: cloud_agent_code_reviews.id });

    return review.id;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'createCodeReview' },
      extra: { params: createCodeReviewErrorMetadata(params) },
    });
    throw error;
  }
}

/**
 * Gets a code review by ID
 * Returns null if not found
 */
export async function getCodeReviewById(reviewId: string): Promise<CloudAgentCodeReview | null> {
  try {
    const [review] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId))
      .limit(1);

    return review || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getCodeReviewById' },
      extra: { reviewId },
    });
    throw error;
  }
}

export async function listDispatchableCodeReviewOwnerCandidates(
  params: {
    limit?: number;
    pendingCreatedAtWindow?: PendingCodeReviewCreatedAtWindow;
    excludeBitbucket?: boolean;
  } = {}
): Promise<DispatchableCodeReviewOwnerCandidatesResult> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1_000));
  const staleQueuedCutoff = staleQueuedCodeReviewCutoffSql();
  const staleRunningCutoff = staleRunningCodeReviewCutoffSql();
  const { pendingCreatedAtWindow } = params;
  const bitbucketExclusion = params.excludeBitbucket
    ? sql`AND ${cloud_agent_code_reviews.platform} != 'bitbucket'`
    : sql``;

  try {
    const result = await db.execute<{ owner_type: 'user' | 'org'; owner_id: string }>(sql`
      WITH reconsiderable_work AS (
        SELECT
          CASE
            WHEN ${cloud_agent_code_reviews.owned_by_organization_id} IS NOT NULL THEN 'org'
            ELSE 'user'
          END AS owner_type,
          COALESCE(
            ${cloud_agent_code_reviews.owned_by_organization_id}::text,
            ${cloud_agent_code_reviews.owned_by_user_id}
          ) AS owner_id,
          MIN(${cloud_agent_code_reviews.created_at}) AS oldest_reconsiderable_at
        FROM ${cloud_agent_code_reviews}
        WHERE ${reconsiderableCodeReviewWorkCondition(staleQueuedCutoff, pendingCreatedAtWindow)}
          ${bitbucketExclusion}
        GROUP BY owner_type, owner_id
      ), active_work AS (
        SELECT
          reconsiderable_work.owner_type,
          reconsiderable_work.owner_id,
          COUNT(*) AS active_count
        FROM ${cloud_agent_code_reviews}
        INNER JOIN reconsiderable_work
          ON reconsiderable_work.owner_type = CASE
            WHEN ${cloud_agent_code_reviews.owned_by_organization_id} IS NOT NULL THEN 'org'
            ELSE 'user'
          END
          AND reconsiderable_work.owner_id = COALESCE(
            ${cloud_agent_code_reviews.owned_by_organization_id}::text,
            ${cloud_agent_code_reviews.owned_by_user_id}
          )
        WHERE ${activeCodeReviewWorkCondition(staleQueuedCutoff, staleRunningCutoff)}
        GROUP BY reconsiderable_work.owner_type, reconsiderable_work.owner_id
      ), capacity_candidates AS (
        SELECT
          reconsiderable_work.owner_type,
          reconsiderable_work.owner_id,
          reconsiderable_work.oldest_reconsiderable_at,
          COALESCE(active_work.active_count, 0) AS active_count,
          CASE
            WHEN reconsiderable_work.owner_type = 'org'
              THEN ${MAX_CONCURRENT_CODE_REVIEWS_PER_ORG}::bigint
            WHEN COALESCE(
              ${kilocode_users.total_microdollars_acquired},
              0
            ) - COALESCE(${kilocode_users.microdollars_used}, 0) > ${FUNDED_CODE_REVIEW_BALANCE_THRESHOLD_MICRODOLLARS}
              THEN ${MAX_CONCURRENT_CODE_REVIEWS_PER_FUNDED_USER}::bigint
            ELSE ${MAX_CONCURRENT_CODE_REVIEWS_PER_DEFAULT_USER}::bigint
          END AS capacity_limit
        FROM reconsiderable_work
        LEFT JOIN active_work
          ON active_work.owner_type = reconsiderable_work.owner_type
          AND active_work.owner_id = reconsiderable_work.owner_id
        LEFT JOIN ${kilocode_users}
          ON reconsiderable_work.owner_type = 'user'
          AND ${kilocode_users.id} = reconsiderable_work.owner_id
      )
      SELECT owner_type, owner_id
      FROM capacity_candidates
      WHERE active_count < capacity_limit
      ORDER BY oldest_reconsiderable_at ASC, owner_type ASC, owner_id ASC
      LIMIT ${limit + 1}
    `);

    const hasMore = result.rows.length > limit;
    const owners = result.rows
      .slice(0, limit)
      .map(row =>
        row.owner_type === 'org'
          ? ({ type: 'org', id: row.owner_id } satisfies DispatchableCodeReviewOwnerCandidate)
          : ({ type: 'user', id: row.owner_id } satisfies DispatchableCodeReviewOwnerCandidate)
      );

    return { owners, hasMore };
  } catch (error) {
    captureException(error, {
      tags: { operation: 'listDispatchableCodeReviewOwnerCandidates' },
      extra: { limit },
    });
    throw error;
  }
}

export async function listCodeReviewAttempts(
  codeReviewId: string
): Promise<CloudAgentCodeReviewAttempt[]> {
  try {
    return await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, codeReviewId))
      .orderBy(asc(cloud_agent_code_review_attempts.attempt_number));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'listCodeReviewAttempts' },
      extra: { codeReviewId },
    });
    throw error;
  }
}

export async function getLatestCodeReviewAttempt(
  codeReviewId: string
): Promise<CloudAgentCodeReviewAttempt | null> {
  try {
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(eq(cloud_agent_code_review_attempts.code_review_id, codeReviewId))
      .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
      .limit(1);

    return attempt ?? null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getLatestCodeReviewAttempt' },
      extra: { codeReviewId },
    });
    throw error;
  }
}

export async function getCodeReviewAttemptForReview(
  codeReviewId: string,
  attemptId: string
): Promise<CloudAgentCodeReviewAttempt | null> {
  try {
    const [attempt] = await db
      .select()
      .from(cloud_agent_code_review_attempts)
      .where(
        and(
          eq(cloud_agent_code_review_attempts.code_review_id, codeReviewId),
          eq(cloud_agent_code_review_attempts.id, attemptId)
        )
      )
      .limit(1);

    return attempt ?? null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getCodeReviewAttemptForReview' },
      extra: { codeReviewId, attemptId },
    });
    throw error;
  }
}

export async function createCodeReviewAttempt(params: {
  codeReviewId: string;
  retryOfAttemptId?: string;
  retryReason?: string;
  status?: CodeReviewAttemptStatus;
  sessionId?: string;
  cliSessionId?: string;
  executionId?: string;
  errorMessage?: string;
  terminalReason?: CodeReviewTerminalReason;
  startedAt?: Date;
  completedAt?: Date;
  analyticsEnabledAtDispatch?: boolean;
}): Promise<CloudAgentCodeReviewAttempt> {
  try {
    return await db.transaction(async tx => {
      await tx
        .select({ id: cloud_agent_code_reviews.id })
        .from(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, params.codeReviewId))
        .for('update')
        .limit(1);

      const [latest] = await tx
        .select({ attempt_number: cloud_agent_code_review_attempts.attempt_number })
        .from(cloud_agent_code_review_attempts)
        .where(eq(cloud_agent_code_review_attempts.code_review_id, params.codeReviewId))
        .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
        .limit(1);

      const attemptNumber = (latest?.attempt_number ?? 0) + 1;
      const status = params.status ?? 'pending';
      const now = new Date();

      const [attempt] = await tx
        .insert(cloud_agent_code_review_attempts)
        .values({
          code_review_id: params.codeReviewId,
          attempt_number: attemptNumber,
          retry_of_attempt_id: params.retryOfAttemptId ?? null,
          retry_reason: params.retryReason ?? null,
          session_id: params.sessionId ?? null,
          cli_session_id: params.cliSessionId ?? null,
          execution_id: params.executionId ?? null,
          analytics_enabled_at_dispatch: params.analyticsEnabledAtDispatch ?? null,
          status,
          error_message: params.errorMessage ?? null,
          terminal_reason: params.terminalReason ?? null,
          started_at:
            params.startedAt?.toISOString() ?? (status === 'running' ? now.toISOString() : null),
          completed_at:
            params.completedAt?.toISOString() ??
            (isTerminalCodeReviewStatus(status) ? now.toISOString() : null),
        })
        .returning();

      if (!attempt) {
        throw new Error('Failed to create code review attempt');
      }

      return attempt;
    });
  } catch (error) {
    captureException(error, {
      tags: { operation: 'createCodeReviewAttempt' },
      extra: { params },
    });
    throw error;
  }
}

export async function createInfraRetryAttemptIfMissing(params: {
  codeReviewId: string;
  retryOfAttemptId: string;
}): Promise<InfraRetryAttemptResult> {
  try {
    return await db.transaction(async tx => {
      const [review] = await tx
        .select({
          id: cloud_agent_code_reviews.id,
          status: cloud_agent_code_reviews.status,
          terminalReason: cloud_agent_code_reviews.terminal_reason,
        })
        .from(cloud_agent_code_reviews)
        .where(eq(cloud_agent_code_reviews.id, params.codeReviewId))
        .for('update')
        .limit(1);

      if (!review) {
        throw new Error(`Code review ${params.codeReviewId} not found`);
      }

      if (
        !canCreateInfraRetryAttempt({
          status: review.status,
          terminal_reason: review.terminalReason,
        })
      ) {
        return {
          outcome: 'skipped-inactive',
          reviewStatus: review.status,
          terminalReason: review.terminalReason,
        };
      }

      const [sourceAttempt] = await tx
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(
          and(
            eq(cloud_agent_code_review_attempts.id, params.retryOfAttemptId),
            eq(cloud_agent_code_review_attempts.code_review_id, params.codeReviewId)
          )
        )
        .limit(1);

      if (!sourceAttempt) {
        throw new Error(
          `Code review attempt ${params.retryOfAttemptId} not found for review ${params.codeReviewId}`
        );
      }

      const [existingForAttempt] = await tx
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(
          and(
            eq(cloud_agent_code_review_attempts.code_review_id, params.codeReviewId),
            eq(cloud_agent_code_review_attempts.retry_reason, 'infra_failure'),
            eq(cloud_agent_code_review_attempts.retry_of_attempt_id, params.retryOfAttemptId)
          )
        )
        .limit(1);

      if (existingForAttempt) {
        return { outcome: 'existing-for-attempt', attempt: existingForAttempt };
      }

      const [existingForReview] = await tx
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(
          and(
            eq(cloud_agent_code_review_attempts.code_review_id, params.codeReviewId),
            eq(cloud_agent_code_review_attempts.retry_reason, 'infra_failure')
          )
        )
        .limit(1);

      if (existingForReview) {
        return { outcome: 'existing-for-review', attempt: existingForReview };
      }

      const [latest] = await tx
        .select({ attempt_number: cloud_agent_code_review_attempts.attempt_number })
        .from(cloud_agent_code_review_attempts)
        .where(eq(cloud_agent_code_review_attempts.code_review_id, params.codeReviewId))
        .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
        .limit(1);

      const [attempt] = await tx
        .insert(cloud_agent_code_review_attempts)
        .values({
          code_review_id: params.codeReviewId,
          attempt_number: (latest?.attempt_number ?? 0) + 1,
          retry_of_attempt_id: params.retryOfAttemptId,
          retry_reason: 'infra_failure',
          analytics_enabled_at_dispatch: sourceAttempt.analytics_enabled_at_dispatch,
          status: 'pending',
        })
        .returning();

      if (!attempt) {
        throw new Error('Failed to create infra retry attempt');
      }

      return { outcome: 'created', attempt };
    });
  } catch (error) {
    captureException(error, {
      tags: { operation: 'createInfraRetryAttemptIfMissing' },
      extra: { params },
    });
    throw error;
  }
}

export async function ensureCodeReviewAttemptForRunningCallback(params: {
  codeReviewId: string;
  sessionId?: string;
  cliSessionId?: string;
  executionId?: string;
}): Promise<CloudAgentCodeReviewAttempt> {
  try {
    const latestAttempt = await getLatestCodeReviewAttempt(params.codeReviewId);

    if (!latestAttempt) {
      return await createCodeReviewAttempt({
        codeReviewId: params.codeReviewId,
        status: 'running',
        sessionId: params.sessionId,
        cliSessionId: params.cliSessionId,
        executionId: params.executionId,
      });
    }

    const sessionMatches =
      (params.sessionId !== undefined && latestAttempt.session_id === params.sessionId) ||
      (params.cliSessionId !== undefined && latestAttempt.cli_session_id === params.cliSessionId);
    const latestAttemptIsRetry = latestAttempt.retry_of_attempt_id !== null;
    const shouldUpdateLatestPending =
      sessionMatches ||
      (!latestAttemptIsRetry &&
        (latestAttempt.status === 'pending' ||
          (!latestAttempt.session_id &&
            !latestAttempt.cli_session_id &&
            !isTerminalCodeReviewStatus(latestAttempt.status))));

    if (shouldUpdateLatestPending) {
      const [updated] = await db
        .update(cloud_agent_code_review_attempts)
        .set(
          buildAttemptUpdateData({
            status: 'running',
            sessionId: params.sessionId,
            cliSessionId: params.cliSessionId,
            executionId: params.executionId,
          })
        )
        .where(eq(cloud_agent_code_review_attempts.id, latestAttempt.id))
        .returning();

      if (updated) return updated;
    }

    return latestAttempt;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'ensureCodeReviewAttemptForRunningCallback' },
      extra: { params },
    });
    throw error;
  }
}

export async function updateCodeReviewAttemptForCallback(
  params: AttemptCallbackFields
): Promise<CloudAgentCodeReviewAttempt> {
  try {
    if (params.attemptId) {
      const explicitAttempt = await getCodeReviewAttemptForReview(
        params.codeReviewId,
        params.attemptId
      );
      if (!explicitAttempt) {
        throw new Error(
          `Code review attempt ${params.attemptId} not found for review ${params.codeReviewId}`
        );
      }

      const [updated] = await db
        .update(cloud_agent_code_review_attempts)
        .set(
          buildAttemptUpdateData({
            status: params.status,
            sessionId: params.sessionId,
            cliSessionId: params.cliSessionId,
            executionId: params.executionId,
            errorMessage: params.errorMessage,
            terminalReason: params.terminalReason,
            startedAt: params.startedAt,
            completedAt: params.completedAt,
          })
        )
        .where(eq(cloud_agent_code_review_attempts.id, explicitAttempt.id))
        .returning();

      if (!updated) {
        throw new Error('Failed to update code review attempt');
      }

      return updated;
    }

    if (params.status === 'running') {
      return await ensureCodeReviewAttemptForRunningCallback(params);
    }

    let matchingAttempt: CloudAgentCodeReviewAttempt | undefined;
    if (params.sessionId) {
      [matchingAttempt] = await db
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(
          and(
            eq(cloud_agent_code_review_attempts.code_review_id, params.codeReviewId),
            eq(cloud_agent_code_review_attempts.session_id, params.sessionId)
          )
        )
        .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
        .limit(1);
    }

    if (!matchingAttempt && params.cliSessionId) {
      [matchingAttempt] = await db
        .select()
        .from(cloud_agent_code_review_attempts)
        .where(
          and(
            eq(cloud_agent_code_review_attempts.code_review_id, params.codeReviewId),
            eq(cloud_agent_code_review_attempts.cli_session_id, params.cliSessionId)
          )
        )
        .orderBy(desc(cloud_agent_code_review_attempts.attempt_number))
        .limit(1);
    }

    const latestAttempt = await getLatestCodeReviewAttempt(params.codeReviewId);
    if (
      !matchingAttempt &&
      params.sessionId &&
      latestAttempt?.session_id &&
      latestAttempt.session_id !== params.sessionId
    ) {
      return latestAttempt;
    }

    const targetAttempt = matchingAttempt ?? latestAttempt;

    if (!targetAttempt) {
      return await createCodeReviewAttempt({
        codeReviewId: params.codeReviewId,
        status: params.status,
        sessionId: params.sessionId,
        cliSessionId: params.cliSessionId,
        executionId: params.executionId,
        errorMessage: params.errorMessage,
        terminalReason: params.terminalReason,
        startedAt: params.startedAt,
        completedAt: params.completedAt,
      });
    }

    const [updated] = await db
      .update(cloud_agent_code_review_attempts)
      .set(
        buildAttemptUpdateData({
          status: params.status,
          sessionId: params.sessionId,
          cliSessionId: params.cliSessionId,
          executionId: params.executionId,
          errorMessage: params.errorMessage,
          terminalReason: params.terminalReason,
          startedAt: params.startedAt,
          completedAt: params.completedAt,
        })
      )
      .where(eq(cloud_agent_code_review_attempts.id, targetAttempt.id))
      .returning();

    if (!updated) {
      throw new Error('Failed to update code review attempt');
    }

    return updated;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateCodeReviewAttemptForCallback' },
      extra: { params },
    });
    throw error;
  }
}

export async function hasInfraRetryAttempt(codeReviewId: string): Promise<boolean> {
  try {
    const [attempt] = await db
      .select({ id: cloud_agent_code_review_attempts.id })
      .from(cloud_agent_code_review_attempts)
      .where(
        and(
          eq(cloud_agent_code_review_attempts.code_review_id, codeReviewId),
          eq(cloud_agent_code_review_attempts.retry_reason, 'infra_failure')
        )
      )
      .limit(1);

    return !!attempt;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'hasInfraRetryAttempt' },
      extra: { codeReviewId },
    });
    throw error;
  }
}

export async function ensureCurrentCodeReviewAttemptFromReview(
  review: CloudAgentCodeReview,
  analyticsEnabledAtDispatch?: boolean
): Promise<CloudAgentCodeReviewAttempt> {
  let attempt = await getLatestCodeReviewAttempt(review.id);
  if (attempt) {
    if (
      attempt.status === 'pending' &&
      (review.session_id || review.cli_session_id || review.status !== 'pending')
    ) {
      const [updated] = await db
        .update(cloud_agent_code_review_attempts)
        .set(
          buildAttemptUpdateData({
            status: review.status as CodeReviewAttemptStatus,
            sessionId: review.session_id ?? undefined,
            cliSessionId: review.cli_session_id ?? undefined,
            errorMessage: review.error_message ?? undefined,
            terminalReason: review.terminal_reason as CodeReviewTerminalReason | undefined,
            startedAt: review.started_at ? new Date(review.started_at) : undefined,
            completedAt: review.completed_at ? new Date(review.completed_at) : undefined,
          })
        )
        .where(eq(cloud_agent_code_review_attempts.id, attempt.id))
        .returning();

      attempt = updated ?? attempt;
    }
  } else {
    attempt = await createCodeReviewAttempt({
      codeReviewId: review.id,
      status: review.status as CodeReviewAttemptStatus,
      sessionId: review.session_id ?? undefined,
      cliSessionId: review.cli_session_id ?? undefined,
      errorMessage: review.error_message ?? undefined,
      terminalReason: review.terminal_reason as CodeReviewTerminalReason | undefined,
      startedAt: review.started_at ? new Date(review.started_at) : undefined,
      completedAt: review.completed_at ? new Date(review.completed_at) : undefined,
      analyticsEnabledAtDispatch,
    });
  }

  if (analyticsEnabledAtDispatch === undefined || attempt.analytics_enabled_at_dispatch !== null) {
    return attempt;
  }

  const [snapshotted] = await db
    .update(cloud_agent_code_review_attempts)
    .set({
      analytics_enabled_at_dispatch: analyticsEnabledAtDispatch,
      updated_at: new Date().toISOString(),
    })
    .where(
      and(
        eq(cloud_agent_code_review_attempts.id, attempt.id),
        isNull(cloud_agent_code_review_attempts.analytics_enabled_at_dispatch)
      )
    )
    .returning();

  if (snapshotted) return snapshotted;

  return (await getCodeReviewAttemptForReview(review.id, attempt.id)) ?? attempt;
}

/**
 * Updates code review status
 * Can optionally update session_id, cli_session_id, error_message, started_at, completed_at
 */
export async function updateCodeReviewStatus(
  reviewId: string,
  status: CodeReviewStatus,
  updates: {
    sessionId?: string;
    cliSessionId?: string;
    errorMessage?: string;
    terminalReason?: CodeReviewTerminalReason;
    startedAt?: Date;
    completedAt?: Date;
    agentVersion?: string;
    model?: string;
    totalTokensIn?: number;
    totalTokensOut?: number;
    totalCostMusd?: number;
  } = {}
): Promise<void> {
  try {
    const updateData: Partial<typeof cloud_agent_code_reviews.$inferInsert> = {
      status,
      updated_at: new Date().toISOString(),
    };

    // Add optional updates
    if (updates.sessionId !== undefined) {
      updateData.session_id = updates.sessionId;
    }
    if (updates.cliSessionId !== undefined) {
      updateData.cli_session_id = updates.cliSessionId;
    }
    if (updates.errorMessage !== undefined) {
      updateData.error_message = updates.errorMessage;
    }
    if (updates.terminalReason !== undefined) {
      updateData.terminal_reason = updates.terminalReason;
    }
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt.toISOString();
    }
    if (updates.completedAt !== undefined) {
      updateData.completed_at = updates.completedAt.toISOString();
    }
    if (updates.agentVersion !== undefined) {
      updateData.agent_version = updates.agentVersion;
    }
    if (updates.model !== undefined) {
      updateData.model = updates.model;
    }
    if (updates.totalTokensIn !== undefined) {
      updateData.total_tokens_in = updates.totalTokensIn;
    }
    if (updates.totalTokensOut !== undefined) {
      updateData.total_tokens_out = updates.totalTokensOut;
    }
    if (updates.totalCostMusd !== undefined) {
      updateData.total_cost_musd = updates.totalCostMusd;
    }

    // Auto-set timestamps based on status
    if (status === 'running' && !updates.startedAt) {
      updateData.started_at = new Date().toISOString();
    }
    if (
      (status === 'completed' || status === 'failed' || status === 'cancelled') &&
      !updates.completedAt
    ) {
      updateData.completed_at = new Date().toISOString();
    }

    await db
      .update(cloud_agent_code_reviews)
      .set(updateData)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateCodeReviewStatus' },
      extra: { reviewId, status, updates },
    });
    throw error;
  }
}

export async function updateCodeReviewStatusIfNonTerminal(
  reviewId: string,
  status: CodeReviewStatus,
  updates: {
    sessionId?: string;
    cliSessionId?: string;
    errorMessage?: string;
    terminalReason?: CodeReviewTerminalReason;
    startedAt?: Date;
    completedAt?: Date;
    agentVersion?: string;
    model?: string;
    totalTokensIn?: number;
    totalTokensOut?: number;
    totalCostMusd?: number;
  } = {},
  dispatchReservationId?: string
): Promise<boolean> {
  try {
    const updateData: Partial<typeof cloud_agent_code_reviews.$inferInsert> = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (updates.sessionId !== undefined) updateData.session_id = updates.sessionId;
    if (updates.cliSessionId !== undefined) updateData.cli_session_id = updates.cliSessionId;
    if (updates.errorMessage !== undefined) updateData.error_message = updates.errorMessage;
    if (updates.terminalReason !== undefined) updateData.terminal_reason = updates.terminalReason;
    if (updates.startedAt !== undefined) updateData.started_at = updates.startedAt.toISOString();
    if (updates.completedAt !== undefined) {
      updateData.completed_at = updates.completedAt.toISOString();
    }
    if (updates.agentVersion !== undefined) updateData.agent_version = updates.agentVersion;
    if (updates.model !== undefined) updateData.model = updates.model;
    if (updates.totalTokensIn !== undefined) updateData.total_tokens_in = updates.totalTokensIn;
    if (updates.totalTokensOut !== undefined) updateData.total_tokens_out = updates.totalTokensOut;
    if (updates.totalCostMusd !== undefined) updateData.total_cost_musd = updates.totalCostMusd;

    if (status === 'running' && !updates.startedAt) {
      updateData.started_at = new Date().toISOString();
    }
    if (
      (status === 'completed' || status === 'failed' || status === 'cancelled') &&
      !updates.completedAt
    ) {
      updateData.completed_at = new Date().toISOString();
    }

    const updated = await db
      .update(cloud_agent_code_reviews)
      .set(updateData)
      .where(
        and(
          eq(cloud_agent_code_reviews.id, reviewId),
          inArray(cloud_agent_code_reviews.status, ['pending', 'queued', 'running']),
          dispatchReservationId
            ? eq(cloud_agent_code_reviews.dispatch_reservation_id, dispatchReservationId)
            : undefined
        )
      )
      .returning({ id: cloud_agent_code_reviews.id });

    return updated.length > 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateCodeReviewStatusIfNonTerminal' },
      extra: { reviewId, status, updates },
    });
    throw error;
  }
}

export async function releaseQueuedReviewClaim(
  reviewId: string,
  dispatchReservationId: string
): Promise<boolean> {
  try {
    const released = await db
      .update(cloud_agent_code_reviews)
      .set({
        status: 'pending',
        dispatch_reservation_id: null,
        updated_at: new Date().toISOString(),
      })
      .where(
        and(
          eq(cloud_agent_code_reviews.id, reviewId),
          eq(cloud_agent_code_reviews.status, 'queued'),
          eq(cloud_agent_code_reviews.dispatch_reservation_id, dispatchReservationId),
          isNull(cloud_agent_code_reviews.session_id)
        )
      )
      .returning({ id: cloud_agent_code_reviews.id });

    return released.length > 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'releaseQueuedReviewClaim' },
      extra: { reviewId, dispatchReservationId },
    });
    throw error;
  }
}

export async function failReservedQueuedReview(
  reviewId: string,
  dispatchReservationId: string,
  errorMessage: string,
  terminalReason?: CodeReviewTerminalReason
): Promise<boolean> {
  try {
    const updateData: Partial<typeof cloud_agent_code_reviews.$inferInsert> = {
      status: 'failed',
      error_message: errorMessage,
      dispatch_reservation_id: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (terminalReason !== undefined) {
      updateData.terminal_reason = terminalReason;
    }

    const failed = await db
      .update(cloud_agent_code_reviews)
      .set(updateData)
      .where(
        and(
          eq(cloud_agent_code_reviews.id, reviewId),
          eq(cloud_agent_code_reviews.status, 'queued'),
          eq(cloud_agent_code_reviews.dispatch_reservation_id, dispatchReservationId)
        )
      )
      .returning({ id: cloud_agent_code_reviews.id });

    return failed.length > 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'failReservedQueuedReview' },
      extra: { reviewId, dispatchReservationId },
    });
    throw error;
  }
}

export async function reviewIsStillReserved(
  reviewId: string,
  dispatchReservationId: string
): Promise<boolean> {
  try {
    const [review] = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          eq(cloud_agent_code_reviews.id, reviewId),
          eq(cloud_agent_code_reviews.status, 'queued'),
          eq(cloud_agent_code_reviews.dispatch_reservation_id, dispatchReservationId)
        )
      )
      .limit(1);

    return !!review;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'reviewIsStillReserved' },
      extra: { reviewId, dispatchReservationId },
    });
    throw error;
  }
}

export async function reviewIsStillQueued(reviewId: string): Promise<boolean> {
  try {
    const [review] = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          eq(cloud_agent_code_reviews.id, reviewId),
          eq(cloud_agent_code_reviews.status, 'queued')
        )
      )
      .limit(1);

    return !!review;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'reviewIsStillQueued' },
      extra: { reviewId },
    });
    throw error;
  }
}

export async function reviewIsSuperseded(reviewId: string): Promise<boolean> {
  try {
    const [review] = await db
      .select({ terminalReason: cloud_agent_code_reviews.terminal_reason })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId))
      .limit(1);

    return review?.terminalReason === 'superseded';
  } catch (error) {
    captureException(error, {
      tags: { operation: 'reviewIsSuperseded' },
      extra: { reviewId },
    });
    throw error;
  }
}

/**
 * Updates only usage-related columns on a code review, without touching status or timestamps.
 */
export async function updateCodeReviewUsage(
  reviewId: string,
  usage: {
    model?: string;
    totalTokensIn?: number;
    totalTokensOut?: number;
    totalCostMusd?: number;
  }
): Promise<void> {
  try {
    const updateData: Partial<typeof cloud_agent_code_reviews.$inferInsert> = {
      updated_at: new Date().toISOString(),
    };

    if (usage.model !== undefined) {
      updateData.model = usage.model;
    }
    if (usage.totalTokensIn !== undefined) {
      updateData.total_tokens_in = usage.totalTokensIn;
    }
    if (usage.totalTokensOut !== undefined) {
      updateData.total_tokens_out = usage.totalTokensOut;
    }
    if (usage.totalCostMusd !== undefined) {
      updateData.total_cost_musd = usage.totalCostMusd;
    }

    await db
      .update(cloud_agent_code_reviews)
      .set(updateData)
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateCodeReviewUsage' },
      extra: { reviewId, usage },
    });
    throw error;
  }
}

export async function updatePreviousReviewSummary(
  reviewId: string,
  summary: { body: string | null; headSha: string | null }
): Promise<void> {
  try {
    await db
      .update(cloud_agent_code_reviews)
      .set({
        previous_summary_body: summary.body,
        previous_summary_head_sha: summary.headSha,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updatePreviousReviewSummary' },
      extra: { reviewId, hasBody: summary.body !== null, headSha: summary.headSha },
    });
    throw error;
  }
}

/**
 * Updates REVIEW.md usage metadata for a code review.
 */
export async function updateRepositoryReviewInstructionsMetadata(
  reviewId: string,
  metadata: {
    used: boolean;
    ref: string | null;
    truncated: boolean;
  }
): Promise<void> {
  try {
    await db
      .update(cloud_agent_code_reviews)
      .set({
        repository_review_instructions_used: metadata.used,
        repository_review_instructions_ref: metadata.ref,
        repository_review_instructions_truncated: metadata.truncated,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateRepositoryReviewInstructionsMetadata' },
      extra: { reviewId, metadata },
    });
    throw error;
  }
}

/**
 * Lists code reviews for an owner (org or user)
 * Supports filtering by status and repository
 * Returns reviews sorted by creation date (newest first)
 */
export async function listCodeReviews(params: ListReviewsParams): Promise<CloudAgentCodeReview[]> {
  try {
    const { owner, limit = 50, offset = 0, status, repoFullName, platform } = params;

    console.log('[listCodeReviews] Query params:', {
      owner,
      limit,
      offset,
      status,
      repoFullName,
      platform,
    });

    // Build WHERE conditions
    const conditions = [];

    // Owner condition
    if (owner.type === 'org') {
      console.log('[listCodeReviews] Querying for org:', owner.id);
      conditions.push(eq(cloud_agent_code_reviews.owned_by_organization_id, owner.id));
    } else {
      console.log('[listCodeReviews] Querying for user:', owner.id);
      conditions.push(eq(cloud_agent_code_reviews.owned_by_user_id, owner.id));
    }

    // Optional filters
    if (status) {
      conditions.push(eq(cloud_agent_code_reviews.status, status));
    }
    if (repoFullName) {
      conditions.push(eq(cloud_agent_code_reviews.repo_full_name, repoFullName));
    }
    if (platform) {
      conditions.push(eq(cloud_agent_code_reviews.platform, platform));
    }

    const reviews = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(and(...conditions))
      .orderBy(desc(cloud_agent_code_reviews.created_at))
      .limit(limit)
      .offset(offset);

    console.log('[listCodeReviews] Found reviews:', reviews.length);

    return reviews;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'listCodeReviews' },
      extra: { params },
    });
    throw error;
  }
}

/**
 * Counts total code reviews for an owner
 * Supports same filtering as listCodeReviews
 */
export async function countCodeReviews(params: {
  owner: Owner;
  status?: CodeReviewStatus;
  repoFullName?: string;
  platform?: CodeReviewPlatform;
}): Promise<number> {
  try {
    const { owner, status, repoFullName, platform } = params;

    // Build WHERE conditions
    const conditions = [];

    // Owner condition
    if (owner.type === 'org') {
      conditions.push(eq(cloud_agent_code_reviews.owned_by_organization_id, owner.id));
    } else {
      conditions.push(eq(cloud_agent_code_reviews.owned_by_user_id, owner.id));
    }

    // Optional filters
    if (status) {
      conditions.push(eq(cloud_agent_code_reviews.status, status));
    }
    if (repoFullName) {
      conditions.push(eq(cloud_agent_code_reviews.repo_full_name, repoFullName));
    }
    if (platform) {
      conditions.push(eq(cloud_agent_code_reviews.platform, platform));
    }

    const result = await db
      .select({ count: count() })
      .from(cloud_agent_code_reviews)
      .where(and(...conditions));

    return result[0]?.count || 0;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'countCodeReviews' },
      extra: { params },
    });
    throw error;
  }
}

async function findExistingReviewWithDatabase(
  database: CodeReviewDatabase,
  scope: ReviewScope,
  headSha: string
): Promise<CloudAgentCodeReview | null> {
  const [review] = await database
    .select()
    .from(cloud_agent_code_reviews)
    .where(and(...reviewScopeConditions(scope), eq(cloud_agent_code_reviews.head_sha, headSha)))
    .limit(1);

  return review || null;
}

async function findReviewByLegacyUniqueKeyWithDatabase(
  database: CodeReviewDatabase,
  params: Pick<CreateReviewParams, 'repoFullName' | 'prNumber' | 'headSha'>
): Promise<CloudAgentCodeReview | null> {
  const [review] = await database
    .select()
    .from(cloud_agent_code_reviews)
    .where(
      and(
        eq(cloud_agent_code_reviews.repo_full_name, params.repoFullName),
        eq(cloud_agent_code_reviews.pr_number, params.prNumber),
        eq(cloud_agent_code_reviews.head_sha, params.headSha)
      )
    )
    .limit(1);

  return review || null;
}

/**
 * Checks if a code review already exists for an exact review scope and commit SHA.
 * Returns the existing review if found, null otherwise.
 */
export async function findExistingReview(
  scope: ReviewScope,
  headSha: string
): Promise<CloudAgentCodeReview | null> {
  try {
    return await findExistingReviewWithDatabase(db, scope, headSha);
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findExistingReview' },
      extra: { scope, headSha },
    });
    throw error;
  }
}

export function findExistingReviewInTransaction(
  tx: DrizzleTransaction,
  scope: ReviewScope,
  headSha: string
): Promise<CloudAgentCodeReview | null> {
  return findExistingReviewWithDatabase(tx, scope, headSha);
}

export async function createCodeReviewIfAbsentInTransaction(
  tx: DrizzleTransaction,
  scope: ReviewScope,
  params: CreateReviewParams
): Promise<{ reviewId: string; created: boolean }> {
  CreateReviewParamsSchema.parse(params);
  await assertCouncilCreationAllowed({ owner: params.owner, reviewType: params.reviewType });
  const [created] = await tx
    .insert(cloud_agent_code_reviews)
    .values(codeReviewInsertValues(params))
    .onConflictDoNothing()
    .returning({ id: cloud_agent_code_reviews.id });
  if (created) return { reviewId: created.id, created: true };

  const existing =
    (await findExistingReviewWithDatabase(tx, scope, params.headSha)) ??
    (await findReviewByLegacyUniqueKeyWithDatabase(tx, params));
  if (!existing) throw new Error('Code review conflict winner not found');
  return { reviewId: existing.id, created: false };
}

/**
 * Cancels a code review
 * Sets status to 'cancelled' and records completion time
 */
export async function cancelCodeReview(reviewId: string): Promise<void> {
  try {
    await updateCodeReviewStatus(reviewId, 'cancelled', {
      completedAt: new Date(),
    });
  } catch (error) {
    captureException(error, {
      tags: { operation: 'cancelCodeReview' },
      extra: { reviewId },
    });
    throw error;
  }
}

/**
 * Resets a failed code review for retry
 * Clears status back to 'pending' and removes error/session data
 */
export async function resetCodeReviewForRetry(reviewId: string): Promise<void> {
  try {
    await db
      .update(cloud_agent_code_reviews)
      .set({
        status: 'pending',
        dispatch_reservation_id: null,
        session_id: null,
        cli_session_id: null,
        error_message: null,
        terminal_reason: null,
        check_run_id: null,
        started_at: null,
        completed_at: null,
        model: null,
        total_tokens_in: null,
        total_tokens_out: null,
        total_cost_musd: null,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'resetCodeReviewForRetry' },
      extra: { reviewId },
    });
    throw error;
  }
}

/**
 * Finds all active reviews in an exact review scope except the given SHA.
 * Returns review IDs that should be cancelled when a new push comes in.
 */
export async function findActiveReviewsForPR(
  scope: ReviewScope,
  excludeSha: string
): Promise<string[]> {
  try {
    const reviews = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          ...reviewScopeConditions(scope),
          ne(cloud_agent_code_reviews.head_sha, excludeSha),
          inArray(cloud_agent_code_reviews.status, ['pending', 'queued', 'running'])
        )
      )
      .orderBy(
        sql`CASE ${cloud_agent_code_reviews.status} WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END`,
        desc(cloud_agent_code_reviews.created_at),
        asc(cloud_agent_code_reviews.id)
      );

    return reviews.map(review => review.id);
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findActiveReviewsForPR' },
      extra: { scope, excludeSha },
    });
    throw error;
  }
}

export async function findActiveProviderPublishingReview(input: {
  platformIntegrationId: string;
  repoFullName: string;
  prNumber: number;
}): Promise<{ id: string } | null> {
  try {
    const [review] = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          eq(cloud_agent_code_reviews.platform_integration_id, input.platformIntegrationId),
          eq(cloud_agent_code_reviews.repo_full_name, input.repoFullName),
          eq(cloud_agent_code_reviews.pr_number, input.prNumber),
          providerPublishingCondition(),
          inArray(cloud_agent_code_reviews.status, ['pending', 'queued', 'running'])
        )
      )
      .limit(1);

    return review ?? null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findActiveProviderPublishingReview' },
      extra: { input },
    });
    throw error;
  }
}

export function bitbucketCodeReviewerLifecycleLockKey(integrationId: string): string {
  return `bitbucket-code-review-lifecycle:${integrationId}`;
}

type CancelledReviewDatabaseRow = {
  id: string;
  prev_status: 'pending' | 'queued' | 'running';
  session_id: string | null;
  latest_active_attempt_id: string | null;
  check_run_id: number | null;
  head_sha: string;
  platform: CodeReviewPlatform;
  platform_project_id: number | null;
  platform_integration_id: string | null;
};

function mapCancelledReviewRow(row: CancelledReviewDatabaseRow): CancelledReviewRow {
  return {
    id: row.id,
    prevStatus: row.prev_status,
    sessionId: row.session_id,
    latestActiveAttemptId: row.latest_active_attempt_id,
    checkRunId: row.check_run_id,
    headSha: row.head_sha,
    platform: row.platform,
    platformProjectId: row.platform_project_id,
    platformIntegrationId: row.platform_integration_id,
  };
}

async function cancelReviewsForPR(
  database: CodeReviewDatabase,
  scope: ReviewScope,
  excludeSha?: string
): Promise<CancelledReviewRow[]> {
  const ownerCondition =
    scope.owner.type === 'org'
      ? sql`${cloud_agent_code_reviews.owned_by_organization_id} = ${scope.owner.id}`
      : sql`${cloud_agent_code_reviews.owned_by_user_id} = ${scope.owner.id}`;
  const excludedHeadCondition =
    excludeSha === undefined
      ? sql``
      : sql`AND ${cloud_agent_code_reviews.head_sha} != ${excludeSha}`;
  const platformIntegrationCondition =
    scope.platformIntegrationId === undefined
      ? sql``
      : sql`AND ${cloud_agent_code_reviews.platform_integration_id} = ${scope.platformIntegrationId}
            AND ${cloud_agent_code_reviews.manual_config} IS NULL`;
  const result = await database.execute<CancelledReviewDatabaseRow>(sql`
    WITH targets AS (
      SELECT
        id,
        status AS prev_status,
        session_id,
        (
          SELECT attempts.id
          FROM ${cloud_agent_code_review_attempts} AS attempts
          WHERE attempts.code_review_id = ${cloud_agent_code_reviews}.id
            AND attempts.status IN ('pending', 'queued', 'running')
          ORDER BY attempts.attempt_number DESC
          LIMIT 1
        ) AS latest_active_attempt_id,
        check_run_id,
        head_sha,
        platform,
        platform_project_id,
        platform_integration_id
      FROM ${cloud_agent_code_reviews}
      WHERE ${ownerCondition}
        AND ${cloud_agent_code_reviews.platform} = ${scope.platform}
        AND ${cloud_agent_code_reviews.repo_full_name} = ${scope.repoFullName}
        AND ${cloud_agent_code_reviews.pr_number} = ${scope.prNumber}
        ${excludedHeadCondition}
        ${platformIntegrationCondition}
        AND ${cloud_agent_code_reviews.status} IN ('pending', 'queued', 'running')
    ), cancelled_attempts AS (
      UPDATE ${cloud_agent_code_review_attempts} AS attempts
      SET
        status = 'cancelled',
        terminal_reason = 'superseded',
        error_message = 'Superseded by new push',
        completed_at = now(),
        updated_at = now()
      FROM targets
      WHERE attempts.code_review_id = targets.id
        AND attempts.status IN ('pending', 'queued', 'running')
    )
    UPDATE ${cloud_agent_code_reviews} AS reviews
    SET
      status = 'cancelled',
      terminal_reason = 'superseded',
      error_message = 'Superseded by new push',
      completed_at = now(),
      updated_at = now()
    FROM targets
    WHERE reviews.id = targets.id
    RETURNING
      reviews.id,
      targets.prev_status,
      targets.session_id,
      targets.latest_active_attempt_id,
      targets.check_run_id,
      targets.head_sha,
      targets.platform,
      targets.platform_project_id,
      targets.platform_integration_id
  `);

  return result.rows.map(mapCancelledReviewRow);
}

async function cancelActiveCodeReviewsByIdWithDatabase(
  database: CodeReviewDatabase,
  reviewIds: string[],
  errorMessage: string
): Promise<CancelledReviewRow[]> {
  if (reviewIds.length === 0) return [];

  const result = await database.execute<CancelledReviewDatabaseRow>(sql`
    WITH targets AS (
      SELECT
        id,
        status AS prev_status,
        session_id,
        (
          SELECT attempts.id
          FROM ${cloud_agent_code_review_attempts} AS attempts
          WHERE attempts.code_review_id = ${cloud_agent_code_reviews}.id
            AND attempts.status IN ('pending', 'queued', 'running')
          ORDER BY attempts.attempt_number DESC
          LIMIT 1
        ) AS latest_active_attempt_id,
        check_run_id,
        head_sha,
        platform,
        platform_project_id,
        platform_integration_id
      FROM ${cloud_agent_code_reviews}
      WHERE ${inArray(cloud_agent_code_reviews.id, reviewIds)}
        AND ${cloud_agent_code_reviews.status} IN ('pending', 'queued', 'running')
    ), cancelled_attempts AS (
      UPDATE ${cloud_agent_code_review_attempts} AS attempts
      SET
        status = 'cancelled',
        terminal_reason = 'superseded',
        error_message = ${errorMessage},
        completed_at = now(),
        updated_at = now()
      FROM targets
      WHERE attempts.code_review_id = targets.id
        AND attempts.status IN ('pending', 'queued', 'running')
    )
    UPDATE ${cloud_agent_code_reviews} AS reviews
    SET
      status = 'cancelled',
      terminal_reason = 'superseded',
      error_message = ${errorMessage},
      completed_at = now(),
      updated_at = now()
    FROM targets
    WHERE reviews.id = targets.id
    RETURNING
      reviews.id,
      targets.prev_status,
      targets.session_id,
      targets.latest_active_attempt_id,
      targets.check_run_id,
      targets.head_sha,
      targets.platform,
      targets.platform_project_id,
      targets.platform_integration_id
  `);

  return result.rows.map(mapCancelledReviewRow);
}

type IntegrationReviewCancellationInput = {
  organizationId: string;
  platform: CodeReviewPlatform;
  integrationId: string;
};

async function cancelActiveCodeReviewsForIntegrationWithDatabase(
  database: CodeReviewDatabase,
  input: IntegrationReviewCancellationInput,
  errorMessage: string
): Promise<CancelledReviewRow[]> {
  const result = await database.execute<CancelledReviewDatabaseRow>(sql`
    WITH targets AS (
      SELECT
        id,
        status AS prev_status,
        session_id,
        (
          SELECT attempts.id
          FROM ${cloud_agent_code_review_attempts} AS attempts
          WHERE attempts.code_review_id = ${cloud_agent_code_reviews}.id
            AND attempts.status IN ('pending', 'queued', 'running')
          ORDER BY attempts.attempt_number DESC
          LIMIT 1
        ) AS latest_active_attempt_id,
        check_run_id,
        head_sha,
        platform,
        platform_project_id,
        platform_integration_id
      FROM ${cloud_agent_code_reviews}
      WHERE ${cloud_agent_code_reviews.owned_by_organization_id} = ${input.organizationId}
        AND ${cloud_agent_code_reviews.platform} = ${input.platform}
        AND ${cloud_agent_code_reviews.platform_integration_id} = ${input.integrationId}
        AND ${cloud_agent_code_reviews.status} IN ('pending', 'queued', 'running')
    ), cancelled_attempts AS (
      UPDATE ${cloud_agent_code_review_attempts} AS attempts
      SET
        status = 'cancelled',
        terminal_reason = 'user_cancelled',
        error_message = ${errorMessage},
        completed_at = now(),
        updated_at = now()
      FROM targets
      WHERE attempts.code_review_id = targets.id
        AND attempts.status IN ('pending', 'queued', 'running')
    )
    UPDATE ${cloud_agent_code_reviews} AS reviews
    SET
      status = 'cancelled',
      terminal_reason = 'user_cancelled',
      error_message = ${errorMessage},
      completed_at = now(),
      updated_at = now()
    FROM targets
    WHERE reviews.id = targets.id
    RETURNING
      reviews.id,
      targets.prev_status,
      targets.session_id,
      targets.latest_active_attempt_id,
      targets.check_run_id,
      targets.head_sha,
      targets.platform,
      targets.platform_project_id,
      targets.platform_integration_id
  `);

  return result.rows.map(mapCancelledReviewRow);
}

export async function cancelActiveCodeReviewsForIntegration(
  input: IntegrationReviewCancellationInput
): Promise<CancelledReviewRow[]> {
  try {
    return await cancelActiveCodeReviewsForIntegrationWithDatabase(
      db,
      input,
      'Platform integration disconnected'
    );
  } catch (error) {
    captureException(error, {
      tags: { operation: 'cancelActiveCodeReviewsForIntegration' },
      extra: input,
    });
    throw error;
  }
}

export async function cancelActiveCodeReviewsById(
  reviewIds: string[],
  errorMessage: string
): Promise<CancelledReviewRow[]> {
  try {
    return await cancelActiveCodeReviewsByIdWithDatabase(db, reviewIds, errorMessage);
  } catch (error) {
    captureException(error, {
      tags: { operation: 'cancelActiveCodeReviewsById' },
      extra: { reviewIds, errorMessage },
    });
    throw error;
  }
}

export async function disableBitbucketCodeReviewerForIntegration(input: {
  organizationId: string;
  integrationId: string;
}): Promise<CancelledReviewRow[]> {
  try {
    return await db.transaction(async tx => {
      const lockKey = bitbucketCodeReviewerLifecycleLockKey(input.integrationId);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      await tx
        .update(agent_configs)
        .set({ is_enabled: false, updated_at: new Date().toISOString() })
        .where(
          and(
            eq(agent_configs.owned_by_organization_id, input.organizationId),
            eq(agent_configs.agent_type, 'code_review'),
            eq(agent_configs.platform, 'bitbucket')
          )
        );
      return cancelActiveCodeReviewsForIntegrationWithDatabase(
        tx,
        {
          ...input,
          platform: 'bitbucket',
        },
        'Bitbucket Code Reviewer disabled'
      );
    });
  } catch (error) {
    captureException(error, {
      tags: { operation: 'disableBitbucketCodeReviewerForIntegration' },
      extra: input,
    });
    throw error;
  }
}

export async function cancelSupersededReviewsForPR(
  scope: ReviewScope,
  excludeSha: string
): Promise<CancelledReviewRow[]> {
  try {
    return await cancelReviewsForPR(db, scope, excludeSha);
  } catch (error) {
    captureException(error, {
      tags: { operation: 'cancelSupersededReviewsForPR' },
      extra: { scope, excludeSha },
    });
    throw error;
  }
}

export function cancelSupersededReviewsForPRInTransaction(
  tx: DrizzleTransaction,
  scope: ReviewScope,
  excludeSha: string
): Promise<CancelledReviewRow[]> {
  return cancelReviewsForPR(tx, scope, excludeSha);
}

export function cancelActiveReviewsForPRInTransaction(
  tx: DrizzleTransaction,
  scope: ReviewScope
): Promise<CancelledReviewRow[]> {
  return cancelReviewsForPR(tx, scope);
}

/**
 * Finds the most recent completed review in an exact review scope with a different SHA.
 * Returns the previous HEAD SHA and session ID from the same row.
 */
export async function findPreviousCompletedReview(
  scope: ReviewScope,
  excludeSha: string
): Promise<{ head_sha: string; session_id: string | null } | null> {
  try {
    const [review] = await db
      .select({
        head_sha: cloud_agent_code_reviews.head_sha,
        session_id: cloud_agent_code_reviews.session_id,
      })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          ...reviewScopeConditions(scope),
          ne(cloud_agent_code_reviews.head_sha, excludeSha),
          eq(cloud_agent_code_reviews.status, 'completed')
        )
      )
      .orderBy(desc(cloud_agent_code_reviews.created_at))
      .limit(1);

    return review || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findPreviousCompletedReview' },
      extra: { scope, excludeSha },
    });
    throw error;
  }
}

/**
 * Stores the GitHub Check Run ID on a code review record.
 * Called after creating the initial check run so we can update it later.
 */
export async function updateCheckRunId(reviewId: string, checkRunId: number): Promise<void> {
  try {
    await db
      .update(cloud_agent_code_reviews)
      .set({
        check_run_id: checkRunId,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateCheckRunId' },
      extra: { reviewId, checkRunId },
    });
    throw error;
  }
}

/**
 * Repoints an in-flight review at a new head SHA (and optionally a new check
 * run). Used when a merge commit arrives for a PR with a preserved review:
 * the review keeps running on the prior feature-branch content, but its
 * eventual completion needs to update the gate on the new HEAD (which is
 * what branch-protection evaluates) rather than the abandoned prior SHA.
 *
 * Pass `checkRunId = null` for GitLab, whose commit statuses are keyed by
 * (sha, name) rather than by an opaque ID.
 */
export async function updateReviewHeadShaAndCheckRun(
  reviewId: string,
  headSha: string,
  checkRunId: number | null
): Promise<void> {
  try {
    await db
      .update(cloud_agent_code_reviews)
      .set({
        head_sha: headSha,
        check_run_id: checkRunId,
        updated_at: new Date().toISOString(),
      })
      .where(eq(cloud_agent_code_reviews.id, reviewId));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'updateReviewHeadShaAndCheckRun' },
      extra: { reviewId, headSha, checkRunId },
    });
    throw error;
  }
}

/**
 * Verifies that a user owns (or is a member of the org that owns) a code review
 * Returns true if the user has access, false otherwise
 */
export async function userOwnsReview(reviewId: string, userId: string): Promise<boolean> {
  try {
    const [review] = await db
      .select({
        owned_by_user_id: cloud_agent_code_reviews.owned_by_user_id,
        owned_by_organization_id: cloud_agent_code_reviews.owned_by_organization_id,
      })
      .from(cloud_agent_code_reviews)
      .where(eq(cloud_agent_code_reviews.id, reviewId))
      .limit(1);

    if (!review) {
      return false;
    }

    // Check direct user ownership
    if (review.owned_by_user_id === userId) {
      return true;
    }

    // For org ownership, we'd need to check org membership
    // This would require joining with organization_members table
    // For now, we'll rely on tRPC procedures to handle org authorization
    // and only check direct user ownership here
    return false;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'userOwnsReview' },
      extra: { reviewId, userId },
    });
    throw error;
  }
}

/**
 * Result of aggregating billing usage for a session.
 */
export type SessionUsageSummary = {
  model: string;
  totalTokensIn: number;
  totalTokensOut: number;
  tokensIn: number;
  tokensOut: number;
  cachedTokens: number;
  totalCostMusd: number;
};

/**
 * Aggregates LLM usage from the billing tables for a given kilo session ID.
 *
 * This is the fallback path for v2 (cloud-agent-next) reviews where the
 * orchestrator does not accumulate usage from SSE events.  The billing
 * system (processUsage → microdollar_usage) already records per-request
 * usage keyed by session_id, so we aggregate here.
 *
 * The review time bounds let Postgres use the existing
 * `idx_microdollar_usage_metadata_created_at` index instead of seq-scanning
 * the full table (~469 M rows). The upper bound prevents later reviews that
 * continue the same session from changing a completed review's totals.
 */
export async function getSessionUsageFromBilling(
  cliSessionId: string,
  reviewCreatedAt: string,
  reviewCompletedAt?: string
): Promise<SessionUsageSummary | null> {
  try {
    const joinCondition = eq(microdollar_usage.id, microdollar_usage_metadata.id);
    const sessionFilter = and(
      eq(microdollar_usage_metadata.session_id, cliSessionId),
      gte(microdollar_usage_metadata.created_at, reviewCreatedAt),
      reviewCompletedAt ? lte(microdollar_usage_metadata.created_at, reviewCompletedAt) : undefined
    );

    // 1. Session-wide totals (all models combined)
    const [totals] = await db
      .select({
        totalTokensIn: sum(microdollar_usage.input_tokens).mapWith(Number),
        totalTokensOut: sum(microdollar_usage.output_tokens).mapWith(Number),
        totalCacheHitTokens: sum(microdollar_usage.cache_hit_tokens).mapWith(Number),
        totalCacheWriteTokens: sum(microdollar_usage.cache_write_tokens).mapWith(Number),
        totalCostMusd: sum(microdollar_usage.cost).mapWith(Number),
      })
      .from(microdollar_usage)
      .innerJoin(microdollar_usage_metadata, joinCondition)
      .where(sessionFilter);

    if (totals?.totalTokensIn == null) return null;

    // 2. Pick the model with the most tokens (the primary review model)
    const [topModel] = await db
      .select({ model: microdollar_usage.model })
      .from(microdollar_usage)
      .innerJoin(microdollar_usage_metadata, joinCondition)
      .where(sessionFilter)
      .groupBy(microdollar_usage.model)
      .orderBy(
        sql`sum(${microdollar_usage.input_tokens} + ${microdollar_usage.output_tokens}) desc`
      )
      .limit(1);

    if (!topModel?.model) return null;

    const cachedTokens = (totals.totalCacheHitTokens ?? 0) + (totals.totalCacheWriteTokens ?? 0);

    return {
      model: topModel.model,
      totalTokensIn: totals.totalTokensIn,
      totalTokensOut: totals.totalTokensOut ?? 0,
      tokensIn: Math.max(0, totals.totalTokensIn - cachedTokens),
      tokensOut: totals.totalTokensOut ?? 0,
      cachedTokens,
      totalCostMusd: totals.totalCostMusd ?? 0,
    };
  } catch (error) {
    captureException(error, {
      tags: { operation: 'getSessionUsageFromBilling' },
      extra: { cliSessionId },
    });
    return null;
  }
}
