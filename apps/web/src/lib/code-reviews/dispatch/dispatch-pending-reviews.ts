/**
 * Dispatch Pending Reviews
 *
 * Core dispatch logic for code reviews. Checks available slots and dispatches
 * pending reviews to Cloudflare Worker.
 *
 * Triggered by:
 * 1. Webhook handler after creating new pending review
 * 2. Review completion (status update API) to dispatch next in queue
 */

import { db } from '@/lib/drizzle';
import { cloud_agent_code_reviews, type CloudAgentCodeReview } from '@kilocode/db/schema';
import { eq, and, or, count, gte, lt, sql } from 'drizzle-orm';
import type { Owner } from '../core';
import { prepareReviewPayload } from '../triggers/prepare-review-payload';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import { updateCodeReviewStatus } from '../db/code-reviews';
import { captureException } from '@sentry/nextjs';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import { codeReviewWorkerClient } from '../client/code-review-worker-client';
import type { CodeReviewPlatform } from '../core/schemas';

const MAX_CONCURRENT_REVIEWS_PER_OWNER = 20;

// Reviews claimed (queued) but not picked up by the worker within this
// window are considered abandoned (e.g. process crashed after claim) and
// become eligible for re-dispatch.
const STALE_CLAIM_MINUTES = 5;

export interface DispatchResult {
  dispatched: number;
  pending: number;
  activeCount: number;
}

/**
 * Try to dispatch pending reviews for an owner
 * Checks available slots and dispatches up to available capacity
 */
export async function tryDispatchPendingReviews(owner: Owner): Promise<DispatchResult> {
  try {
    logExceptInTest(`[tryDispatchPendingReviews] Starting dispatch check`, { owner });

    const staleCutoff = sql`now() - interval '${sql.raw(String(STALE_CLAIM_MINUTES))} minutes'`;

    // 1. Get active review count for this owner.
    //    Stale queued rows are excluded so abandoned claims do not block recovery.
    const activeCountResult = await db
      .select({ count: count() })
      .from(cloud_agent_code_reviews)
      .where(
        and(
          owner.type === 'org'
            ? eq(cloud_agent_code_reviews.owned_by_organization_id, owner.id)
            : eq(cloud_agent_code_reviews.owned_by_user_id, owner.id),
          or(
            eq(cloud_agent_code_reviews.status, 'running'),
            and(
              eq(cloud_agent_code_reviews.status, 'queued'),
              gte(cloud_agent_code_reviews.updated_at, staleCutoff)
            )
          )
        )
      );

    const activeCount = activeCountResult[0]?.count || 0;
    const availableSlots = MAX_CONCURRENT_REVIEWS_PER_OWNER - activeCount;

    logExceptInTest('[tryDispatchPendingReviews] Active count check', {
      owner,
      activeCount,
      availableSlots,
    });

    // 2. If no slots available, return early
    if (availableSlots <= 0) {
      logExceptInTest('[tryDispatchPendingReviews] No slots available', { owner, activeCount });
      return { dispatched: 0, pending: 0, activeCount };
    }

    // 3. Get dispatchable reviews: pending, or queued-but-stale (abandoned claim).
    //    A review is stale-queued if it was claimed but the process crashed
    //    before the worker dispatch completed.
    const pendingReviews = await db
      .select()
      .from(cloud_agent_code_reviews)
      .where(
        and(
          owner.type === 'org'
            ? eq(cloud_agent_code_reviews.owned_by_organization_id, owner.id)
            : eq(cloud_agent_code_reviews.owned_by_user_id, owner.id),
          or(
            eq(cloud_agent_code_reviews.status, 'pending'),
            and(
              eq(cloud_agent_code_reviews.status, 'queued'),
              lt(cloud_agent_code_reviews.updated_at, staleCutoff)
            )
          )
        )
      )
      .orderBy(cloud_agent_code_reviews.created_at)
      .limit(availableSlots);

    logExceptInTest('[tryDispatchPendingReviews] Found pending reviews', {
      owner,
      pendingCount: pendingReviews.length,
      availableSlots,
    });

    // 4. If no pending reviews, return early
    if (pendingReviews.length === 0) {
      return { dispatched: 0, pending: 0, activeCount };
    }

    // 5. Dispatch all pending reviews in parallel
    const results = await Promise.allSettled(
      pendingReviews.map(review => dispatchReview(review, owner, staleCutoff))
    );

    let dispatched = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        if (result.value) {
          dispatched++;
        }
      } else {
        const review = pendingReviews[i];
        const error = result.reason;
        errorExceptInTest('[tryDispatchPendingReviews] Failed to dispatch review', {
          reviewId: review.id,
          error,
        });
        captureException(error, {
          tags: { operation: 'dispatch-pending-review' },
          extra: { reviewId: review.id, owner },
        });

        // Mark as failed so it doesn't block the queue
        try {
          await updateCodeReviewStatus(review.id, 'failed', {
            errorMessage: `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
          });
        } catch (updateError) {
          errorExceptInTest('[tryDispatchPendingReviews] Failed to mark review as failed', {
            reviewId: review.id,
            updateError,
          });
        }
      }
    }

    logExceptInTest('[tryDispatchPendingReviews] Dispatch complete', {
      owner,
      dispatched,
      total: pendingReviews.length,
    });

    return {
      dispatched,
      pending: pendingReviews.length - dispatched,
      activeCount: activeCount + dispatched,
    };
  } catch (error) {
    errorExceptInTest('[tryDispatchPendingReviews] Error during dispatch', { owner, error });
    captureException(error, {
      tags: { operation: 'try-dispatch-pending-reviews' },
      extra: { owner },
    });
    return { dispatched: 0, pending: 0, activeCount: 0 };
  }
}

/**
 * Dispatch a single review to Cloudflare Worker.
 * Returns true if the review was dispatched, false if it was already claimed
 * by another concurrent dispatcher.
 */
async function dispatchReview(
  review: CloudAgentCodeReview,
  owner: Owner,
  staleCutoff: ReturnType<typeof sql>
): Promise<boolean> {
  // Get platform from review (defaults to 'github' for backward compatibility)
  const platform = (review.platform || 'github') as CodeReviewPlatform;

  logExceptInTest('[dispatchReview] Dispatching review', {
    reviewId: review.id,
    owner,
    platform,
  });

  // 1. Get agent config for owner (use platform from review)
  const agentConfig = await getAgentConfigForOwner(owner, 'code_review', platform);

  if (!agentConfig) {
    throw new Error(
      `Agent config not found for owner ${owner.type}:${owner.id} on platform ${platform}`
    );
  }

  // 2. Prepare complete payload for cloud agent
  const payload = await prepareReviewPayload({
    reviewId: review.id,
    owner,
    agentConfig,
    platform,
  });

  // 3. Atomically claim the review to prevent concurrent dispatchers from
  //    picking the same review. Done as late as possible (after all prep work)
  //    to minimise the crash window between claim and dispatch.
  //    Accepts 'pending' (normal) or stale 'queued' (abandoned claim recovery).
  const claimed = await db
    .update(cloud_agent_code_reviews)
    .set({ status: 'queued' })
    .where(
      and(
        eq(cloud_agent_code_reviews.id, review.id),
        or(
          eq(cloud_agent_code_reviews.status, 'pending'),
          and(
            eq(cloud_agent_code_reviews.status, 'queued'),
            lt(cloud_agent_code_reviews.updated_at, staleCutoff)
          )
        )
      )
    )
    .returning({ id: cloud_agent_code_reviews.id });

  if (claimed.length === 0) {
    logExceptInTest('[dispatchReview] Review already claimed by another dispatcher', {
      reviewId: review.id,
    });
    return false;
  }

  // 4. Dispatch to Cloudflare Worker to create CodeReviewOrchestrator DO.
  //    If this fails, keep the claim in `queued` and rely on stale-claim
  //    recovery. A transport failure is ambiguous: the worker may have
  //    created the DO even if this request did not observe the response.
  const agentVersion = 'v2';
  try {
    await codeReviewWorkerClient.dispatchReview({
      ...payload,
      skipBalanceCheck: true,
      agentVersion,
    });
  } catch (dispatchError) {
    errorExceptInTest('[dispatchReview] Worker dispatch failed, leaving review queued', {
      reviewId: review.id,
      error: dispatchError,
    });
    captureException(dispatchError, {
      tags: { operation: 'dispatch-review-worker-call' },
      extra: { reviewId: review.id, owner },
    });
    return false;
  }

  // 5. Record which agent version was dispatched without rewriting status.
  //    The worker may already have advanced the review to running/completed.
  try {
    await db
      .update(cloud_agent_code_reviews)
      .set({ agent_version: agentVersion })
      .where(eq(cloud_agent_code_reviews.id, review.id));
  } catch (error) {
    errorExceptInTest('[dispatchReview] Failed to persist agent version after dispatch', {
      reviewId: review.id,
      error,
    });
    captureException(error, {
      tags: { operation: 'dispatch-review-record-agent-version' },
      extra: { reviewId: review.id, owner, agentVersion },
    });
  }

  logExceptInTest('[dispatchReview] Review dispatched successfully', {
    reviewId: review.id,
    platform,
  });

  return true;
}
