/**
 * Code Reviews - Database Operations
 *
 * Database operations for cloud agent code reviews.
 * Follows Drizzle ORM patterns used throughout the codebase.
 */

import { db } from '@/lib/drizzle';
import {
  cloud_agent_code_reviews,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { eq, and, desc, count, ne, inArray, sql, sum, gte } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { CreateReviewParams, CodeReviewStatus, ListReviewsParams, Owner } from '../core';
import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type { CodeReviewTerminalReason } from '@kilocode/db/schema-types';

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
        session_id: null,
        cli_session_id: null,
        error_message: null,
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

/**
 * Finds the most recent completed review for the same PR with a different SHA.
 * Used for incremental reviews: returns the previous HEAD SHA so the agent
 * can diff against it instead of re-reviewing the entire PR.
 * Also returns session_id (nullable) so the caller can derive both the
 * incremental diff base and the session continuation target from a single row.
 */
export async function findPreviousCompletedReview(
  repoFullName: string,
  prNumber: number,
  excludeSha: string,
  platform: string = 'github'
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
          eq(cloud_agent_code_reviews.repo_full_name, repoFullName),
          eq(cloud_agent_code_reviews.pr_number, prNumber),
          eq(cloud_agent_code_reviews.platform, platform),
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
      extra: { repoFullName, prNumber, excludeSha, platform },
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
