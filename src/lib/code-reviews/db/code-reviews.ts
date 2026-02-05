/**
 * Code Reviews - Database Operations
 *
 * Database operations for cloud agent code reviews.
 * Follows Drizzle ORM patterns used throughout the codebase.
 */

import { db } from '@/lib/drizzle';
import { cloud_agent_code_reviews } from '@/db/schema';
import { eq, and, desc, count, ne, inArray } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import type { CreateReviewParams, CodeReviewStatus, ListReviewsParams, Owner } from '../core';
import type { CloudAgentCodeReview } from '@/db/schema';

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
    startedAt?: Date;
    completedAt?: Date;
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
    if (updates.startedAt !== undefined) {
      updateData.started_at = updates.startedAt.toISOString();
    }
    if (updates.completedAt !== undefined) {
      updateData.completed_at = updates.completedAt.toISOString();
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
        started_at: null,
        completed_at: null,
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
