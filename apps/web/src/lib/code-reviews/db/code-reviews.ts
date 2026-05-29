/**
 * Code Reviews - Database Operations
 *
 * Database operations for cloud agent code reviews.
 * Follows Drizzle ORM patterns used throughout the codebase.
 */

import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { eq, and, asc, desc, count, ne, inArray, sql, sum, gte, isNull } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { CreateReviewParams, CodeReviewStatus, ListReviewsParams, Owner } from '../core';
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
  platform: 'github' | 'gitlab';
  platformProjectId: number | null;
  platformIntegrationId: string | null;
};

const RETRYABLE_PARENT_REVIEW_STATUSES = ['queued', 'running'];

function canCreateInfraRetryAttempt(review: { status: string; terminal_reason: string | null }) {
  return (
    review.terminal_reason !== 'superseded' &&
    !isCodeReviewActionRequiredReason(review.terminal_reason) &&
    RETRYABLE_PARENT_REVIEW_STATUSES.includes(review.status)
  );
}
/**
 * Creates a new code review record
 * Returns the created review ID
 */
export async function createCodeReview(params: CreateReviewParams): Promise<string> {
  try {
    const [review] = await db
      .insert(cloud_agent_code_reviews)
      .values({
        owned_by_organization_id: params.owner.type === 'org' ? params.owner.id : null,
        owned_by_user_id: params.owner.type === 'user' ? params.owner.id : null,
        platform_integration_id: params.platformIntegrationId || null,
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
        agent_version: 'v2',
        status: 'pending',
      })
      .returning({ id: cloud_agent_code_reviews.id });

    return review.id;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'createCodeReview' },
      extra: { params },
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
  } = {}
): Promise<DispatchableCodeReviewOwnerCandidatesResult> {
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1_000));
  const staleQueuedCutoff = staleQueuedCodeReviewCutoffSql();
  const staleRunningCutoff = staleRunningCodeReviewCutoffSql();
  const { pendingCreatedAtWindow } = params;

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
  review: CloudAgentCodeReview
): Promise<CloudAgentCodeReviewAttempt> {
  const latestAttempt = await getLatestCodeReviewAttempt(review.id);
  if (latestAttempt) {
    if (
      latestAttempt.status === 'pending' &&
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
        .where(eq(cloud_agent_code_review_attempts.id, latestAttempt.id))
        .returning();

      return updated ?? latestAttempt;
    }

    return latestAttempt;
  }

  return await createCodeReviewAttempt({
    codeReviewId: review.id,
    status: review.status as CodeReviewAttemptStatus,
    sessionId: review.session_id ?? undefined,
    cliSessionId: review.cli_session_id ?? undefined,
    errorMessage: review.error_message ?? undefined,
    terminalReason: review.terminal_reason as CodeReviewTerminalReason | undefined,
    startedAt: review.started_at ? new Date(review.started_at) : undefined,
    completedAt: review.completed_at ? new Date(review.completed_at) : undefined,
  });
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
  platform?: 'github' | 'gitlab';
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

/**
 * Checks if a code review already exists for a given repo, PR number, and commit SHA
 * Returns the existing review if found, null otherwise
 */
export async function findExistingReview(
  repoFullName: string,
  prNumber: number,
  headSha: string
): Promise<CloudAgentCodeReview | null> {
  try {
    const [review] = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(
        and(
          eq(cloud_agent_code_reviews.repo_full_name, repoFullName),
          eq(cloud_agent_code_reviews.pr_number, prNumber),
          eq(cloud_agent_code_reviews.head_sha, headSha)
        )
      )
      .limit(1);

    return review || null;
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findExistingReview' },
      extra: { repoFullName, prNumber, headSha },
    });
    throw error;
  }
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
 * Finds all active (non-completed) reviews for a PR except the given SHA
 * Returns review IDs that should be cancelled when a new push comes in
 */
export async function findActiveReviewsForPR(
  repoFullName: string,
  prNumber: number,
  excludeSha: string
): Promise<string[]> {
  try {
    const reviews = await db
      .select({ id: cloud_agent_code_reviews.id })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          eq(cloud_agent_code_reviews.repo_full_name, repoFullName),
          eq(cloud_agent_code_reviews.pr_number, prNumber),
          ne(cloud_agent_code_reviews.head_sha, excludeSha),
          inArray(cloud_agent_code_reviews.status, ['pending', 'queued', 'running'])
        )
      );

    return reviews.map(r => r.id);
  } catch (error) {
    captureException(error, {
      tags: { operation: 'findActiveReviewsForPR' },
      extra: { repoFullName, prNumber, excludeSha },
    });
    throw error;
  }
}

export async function cancelSupersededReviewsForPR(
  repoFullName: string,
  prNumber: number,
  excludeSha: string
): Promise<CancelledReviewRow[]> {
  try {
    const result = await db.execute<{
      id: string;
      prev_status: 'pending' | 'queued' | 'running';
      session_id: string | null;
      latest_active_attempt_id: string | null;
      check_run_id: number | null;
      head_sha: string;
      platform: 'github' | 'gitlab';
      platform_project_id: number | null;
      platform_integration_id: string | null;
    }>(sql`
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
        WHERE ${cloud_agent_code_reviews.repo_full_name} = ${repoFullName}
          AND ${cloud_agent_code_reviews.pr_number} = ${prNumber}
          AND ${cloud_agent_code_reviews.head_sha} != ${excludeSha}
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

    return result.rows.map(row => ({
      id: row.id,
      prevStatus: row.prev_status,
      sessionId: row.session_id,
      latestActiveAttemptId: row.latest_active_attempt_id,
      checkRunId: row.check_run_id,
      headSha: row.head_sha,
      platform: row.platform,
      platformProjectId: row.platform_project_id,
      platformIntegrationId: row.platform_integration_id,
    }));
  } catch (error) {
    captureException(error, {
      tags: { operation: 'cancelSupersededReviewsForPR' },
      extra: { repoFullName, prNumber, excludeSha },
    });
    throw error;
  }
}

export type ReviewContinuationScope =
  | { platform: 'github' }
  | { platform: 'gitlab'; integrationId: string; projectId: number };

/**
 * Finds the most recent completed review for the same PR with a different SHA.
 * Used for incremental reviews: returns the previous HEAD SHA so the agent
 * can diff against it instead of re-reviewing the entire PR.
 * Also returns session_id (nullable) so the caller can derive both the
 * incremental diff base and the session continuation target from a single row.
 * GitLab continuation requires the exact integration and project identity so
 * equivalent project paths on separate GitLab instances never share sessions.
 */
export async function findPreviousCompletedReview(
  repoFullName: string,
  prNumber: number,
  excludeSha: string,
  scope: ReviewContinuationScope = { platform: 'github' }
): Promise<{ head_sha: string; session_id: string | null } | null> {
  try {
    const gitLabScopeFilter =
      scope.platform === 'gitlab'
        ? and(
            eq(cloud_agent_code_reviews.platform_integration_id, scope.integrationId),
            eq(cloud_agent_code_reviews.platform_project_id, scope.projectId)
          )
        : undefined;
    const [review] = await db
      .select({
        head_sha: cloud_agent_code_reviews.head_sha,
        session_id: cloud_agent_code_reviews.session_id,
      })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          eq(cloud_agent_code_reviews.repo_full_name, repoFullName),
          eq(cloud_agent_code_reviews.pr_number, prNumber),
          eq(cloud_agent_code_reviews.platform, scope.platform),
          gitLabScopeFilter,
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
      extra: { repoFullName, prNumber, excludeSha, scope },
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
 * The `reviewCreatedAt` lower bound lets Postgres use the existing
 * `idx_microdollar_usage_metadata_created_at` index instead of seq-scanning
 * the full table (~469 M rows). Billing rows cannot exist before the review.
 */
export async function getSessionUsageFromBilling(
  cliSessionId: string,
  reviewCreatedAt: string
): Promise<SessionUsageSummary | null> {
  try {
    const joinCondition = eq(microdollar_usage.id, microdollar_usage_metadata.id);
    const sessionFilter = and(
      eq(microdollar_usage_metadata.session_id, cliSessionId),
      gte(microdollar_usage_metadata.created_at, reviewCreatedAt)
    );

    // 1. Session-wide totals (all models combined)
    const [totals] = await db
      .select({
        totalTokensIn: sum(microdollar_usage.input_tokens).mapWith(Number),
        totalTokensOut: sum(microdollar_usage.output_tokens).mapWith(Number),
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

    return {
      model: topModel.model,
      totalTokensIn: totals.totalTokensIn,
      totalTokensOut: totals.totalTokensOut ?? 0,
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
