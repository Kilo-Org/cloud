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

import crypto from 'crypto';
import { db, type DrizzleTransaction } from '@/lib/drizzle';
import {
  cloud_agent_code_reviews,
  kilocode_users,
  type CloudAgentCodeReview,
} from '@kilocode/db/schema';
import { eq, and, count, sql, inArray } from 'drizzle-orm';
import type { Owner } from '../core';
import { prepareReviewPayload } from '../triggers/prepare-review-payload';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import {
  ensureCurrentCodeReviewAttemptFromReview,
  failReservedQueuedReview,
  releaseQueuedReviewClaim,
  reviewIsStillQueued,
  reviewIsStillReserved,
  reviewIsSuperseded,
  updateCodeReviewAttemptForCallback,
  updateCodeReviewStatusIfNonTerminal,
} from '../db/code-reviews';
import { captureException } from '@sentry/nextjs';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import { codeReviewWorkerClient } from '../client/code-review-worker-client';
import type { CodeReviewPlatform } from '../core/schemas';
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
} from './dispatch-constants';

export type DispatchResult = {
  dispatched: number;
  notDispatched: number;
  activeCount: number;
};

export type TryDispatchPendingReviewsOptions = {
  /**
   * When provided, restricts pending work selection to reviews whose
   * `created_at` is inside the cron recovery window. Direct dispatch paths
   * leave this unset, and stale queued recovery remains unaffected.
   */
  pendingCreatedAtWindow?: PendingCodeReviewCreatedAtWindow;
};

type ReservedReview = {
  review: CloudAgentCodeReview;
  dispatchReservationId: string;
};

type ReviewReservationBatch = {
  activeCount: number;
  reservations: ReservedReview[];
};

async function getMaxConcurrentReviewsForOwner(
  tx: DrizzleTransaction,
  owner: Owner
): Promise<number> {
  if (owner.type === 'org') return MAX_CONCURRENT_CODE_REVIEWS_PER_ORG;

  const [user] = await tx
    .select({
      totalMicrodollarsAcquired: kilocode_users.total_microdollars_acquired,
      microdollarsUsed: kilocode_users.microdollars_used,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.id, owner.id))
    .limit(1);

  if (!user) {
    logExceptInTest('[getMaxConcurrentReviewsForOwner] User owner not found', { owner });
    return MAX_CONCURRENT_CODE_REVIEWS_PER_DEFAULT_USER;
  }

  const balanceMicrodollars = user.totalMicrodollarsAcquired - user.microdollarsUsed;
  return balanceMicrodollars > FUNDED_CODE_REVIEW_BALANCE_THRESHOLD_MICRODOLLARS
    ? MAX_CONCURRENT_CODE_REVIEWS_PER_FUNDED_USER
    : MAX_CONCURRENT_CODE_REVIEWS_PER_DEFAULT_USER;
}

function ownerReviewCondition(owner: Owner) {
  return owner.type === 'org'
    ? eq(cloud_agent_code_reviews.owned_by_organization_id, owner.id)
    : eq(cloud_agent_code_reviews.owned_by_user_id, owner.id);
}

async function reservePendingReviewsForDispatch(
  owner: Owner,
  options: TryDispatchPendingReviewsOptions = {}
): Promise<ReviewReservationBatch> {
  return await db.transaction(async tx => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`code-review-dispatch:${owner.type}:${owner.id}`}))`
    );

    const staleQueuedCutoff = staleQueuedCodeReviewCutoffSql();
    const staleRunningCutoff = staleRunningCodeReviewCutoffSql();
    const { pendingCreatedAtWindow } = options;
    const ownerCondition = ownerReviewCondition(owner);

    const activeCountResult = await tx
      .select({ count: count() })
      .from(cloud_agent_code_reviews)
      .where(
        and(ownerCondition, activeCodeReviewWorkCondition(staleQueuedCutoff, staleRunningCutoff))
      );

    const activeCount = Number(activeCountResult[0]?.count) || 0;
    const maxConcurrentReviews = await getMaxConcurrentReviewsForOwner(tx, owner);
    const availableSlots = maxConcurrentReviews - activeCount;

    logExceptInTest('[tryDispatchPendingReviews] Active count check', {
      owner,
      activeCount,
      maxConcurrentReviews,
      availableSlots,
    });

    if (availableSlots <= 0) {
      return { activeCount, reservations: [] };
    }

    const candidates = await tx
      .select()
      .from(cloud_agent_code_reviews)
      .where(
        and(
          ownerCondition,
          reconsiderableCodeReviewWorkCondition(staleQueuedCutoff, pendingCreatedAtWindow)
        )
      )
      .orderBy(
        sql`CASE WHEN ${cloud_agent_code_reviews.status} = 'pending' THEN 0 ELSE 1 END`,
        cloud_agent_code_reviews.created_at
      )
      .limit(availableSlots);

    logExceptInTest('[tryDispatchPendingReviews] Found dispatchable reviews', {
      owner,
      dispatchableCount: candidates.length,
      availableSlots,
    });

    if (candidates.length === 0) {
      return { activeCount, reservations: [] };
    }

    const dispatchReservationId = crypto.randomUUID();
    const reservedReviews = await tx
      .update(cloud_agent_code_reviews)
      .set({
        status: 'queued',
        dispatch_reservation_id: dispatchReservationId,
      })
      .where(
        and(
          ownerCondition,
          inArray(
            cloud_agent_code_reviews.id,
            candidates.map(candidate => candidate.id)
          ),
          reconsiderableCodeReviewWorkCondition(staleQueuedCutoff, pendingCreatedAtWindow)
        )
      )
      .returning();

    const reservedReviewsById = new Map(reservedReviews.map(review => [review.id, review]));
    const reservations = candidates.flatMap(candidate => {
      const review = reservedReviewsById.get(candidate.id);
      return review ? [{ review, dispatchReservationId }] : [];
    });

    return { activeCount, reservations };
  });
}

/**
 * Try to dispatch pending reviews for an owner.
 * Checks available slots and dispatches up to available capacity.
 *
 * The default unbounded behavior is intended for direct dispatch paths
 * (webhook, status callbacks, manual retrigger). The cron drain passes
 * `pendingCreatedAtWindow` so it only scans pending rows created inside the
 * cron recovery window; stale queued recovery still runs independently.
 */
export async function tryDispatchPendingReviews(
  owner: Owner,
  options: TryDispatchPendingReviewsOptions = {}
): Promise<DispatchResult> {
  try {
    logExceptInTest('[tryDispatchPendingReviews] Starting dispatch check', { owner });

    const { activeCount, reservations } = await reservePendingReviewsForDispatch(owner, options);

    if (reservations.length === 0) {
      logExceptInTest('[tryDispatchPendingReviews] No reviews reserved', { owner, activeCount });
      return { dispatched: 0, notDispatched: 0, activeCount };
    }

    const results = await Promise.allSettled(
      reservations.map(reservation => dispatchReservedReview(reservation, owner))
    );

    let dispatched = 0;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'fulfilled') {
        if (result.value) {
          dispatched++;
        }
      } else {
        const reservation = reservations[i];
        const error = result.reason;
        errorExceptInTest('[tryDispatchPendingReviews] Failed to dispatch review', {
          reviewId: reservation.review.id,
          error,
        });
        captureException(error, {
          tags: { operation: 'dispatch-pending-review' },
          extra: { reviewId: reservation.review.id, owner },
        });

        try {
          await failReservedQueuedReview(
            reservation.review.id,
            reservation.dispatchReservationId,
            `Dispatch failed: ${error instanceof Error ? error.message : String(error)}`
          );
        } catch (updateError) {
          errorExceptInTest('[tryDispatchPendingReviews] Failed to mark review as failed', {
            reviewId: reservation.review.id,
            updateError,
          });
        }
      }
    }

    logExceptInTest('[tryDispatchPendingReviews] Dispatch complete', {
      owner,
      dispatched,
      total: reservations.length,
    });

    return {
      dispatched,
      notDispatched: reservations.length - dispatched,
      activeCount: activeCount + dispatched,
    };
  } catch (error) {
    errorExceptInTest('[tryDispatchPendingReviews] Error during dispatch', { owner, error });
    captureException(error, {
      tags: { operation: 'try-dispatch-pending-reviews' },
      extra: { owner },
    });
    return { dispatched: 0, notDispatched: 0, activeCount: 0 };
  }
}

async function dispatchReservedReview(reservation: ReservedReview, owner: Owner): Promise<boolean> {
  const { review, dispatchReservationId } = reservation;
  const platform: CodeReviewPlatform = review.platform === 'gitlab' ? 'gitlab' : 'github';

  logExceptInTest('[dispatchReview] Dispatching review', {
    reviewId: review.id,
    owner,
    platform,
  });

  if (!(await reviewIsStillReserved(review.id, dispatchReservationId))) {
    logExceptInTest('[dispatchReview] Review reservation changed before preparation', {
      reviewId: review.id,
    });
    return false;
  }

  const agentConfig = await getAgentConfigForOwner(owner, 'code_review', platform);

  if (!agentConfig) {
    throw new Error(
      `Agent config not found for owner ${owner.type}:${owner.id} on platform ${platform}`
    );
  }

  const payload = await prepareReviewPayload({
    reviewId: review.id,
    owner,
    agentConfig,
    platform,
  });

  if (!(await reviewIsStillReserved(review.id, dispatchReservationId))) {
    logExceptInTest('[dispatchReview] Review reservation changed after preparation', {
      reviewId: review.id,
    });
    return false;
  }

  const agentVersion = 'v2';
  const attempt = await ensureCurrentCodeReviewAttemptFromReview(review);

  if (!(await reviewIsStillReserved(review.id, dispatchReservationId))) {
    if (!(await reviewIsStillQueued(review.id))) {
      const superseded = await reviewIsSuperseded(review.id);
      await updateCodeReviewAttemptForCallback({
        codeReviewId: review.id,
        attemptId: attempt.id,
        status: 'cancelled',
        errorMessage: superseded ? 'Superseded by new push' : 'Review cancelled before dispatch',
        terminalReason: superseded ? 'superseded' : undefined,
        completedAt: new Date(),
      });
      logExceptInTest('[dispatchReview] Review was cancelled before worker dispatch', {
        reviewId: review.id,
        attemptId: attempt.id,
        superseded,
      });
    } else {
      logExceptInTest('[dispatchReview] Review reservation was reclaimed before worker dispatch', {
        reviewId: review.id,
        attemptId: attempt.id,
      });
    }
    return false;
  }

  try {
    await codeReviewWorkerClient.dispatchReview({
      ...payload,
      attemptId: attempt.id,
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
    return handleAmbiguousDispatchFailure(review, owner, attempt.id, dispatchReservationId);
  }

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

async function handleAmbiguousDispatchFailure(
  review: CloudAgentCodeReview,
  owner: Owner,
  attemptId: string,
  dispatchReservationId: string
): Promise<boolean> {
  try {
    const workerStatus = await codeReviewWorkerClient.getReviewStatus(review.id, attemptId);

    if (!workerStatus) {
      const released = await releaseQueuedReviewClaim(review.id, dispatchReservationId);
      logExceptInTest('[dispatchReview] Worker has no DO state after dispatch failure', {
        reviewId: review.id,
        released,
      });
      return false;
    }

    if (workerStatus.status === 'queued' || workerStatus.status === 'running') {
      logExceptInTest('[dispatchReview] Worker accepted review despite dispatch failure', {
        reviewId: review.id,
        status: workerStatus.status,
      });
      return true;
    }

    const completedAt = workerStatus.completedAt ? new Date(workerStatus.completedAt) : undefined;
    await updateCodeReviewAttemptForCallback({
      codeReviewId: review.id,
      attemptId,
      status: workerStatus.status,
      sessionId: workerStatus.sessionId,
      cliSessionId: workerStatus.cliSessionId,
      errorMessage: workerStatus.errorMessage,
      completedAt,
    });
    const parentUpdated = await updateCodeReviewStatusIfNonTerminal(
      review.id,
      workerStatus.status,
      {
        sessionId: workerStatus.sessionId,
        cliSessionId: workerStatus.cliSessionId,
        errorMessage: workerStatus.errorMessage,
        completedAt,
      },
      dispatchReservationId
    );

    logExceptInTest('[dispatchReview] Worker returned terminal status for fresh dispatch', {
      reviewId: review.id,
      attemptId,
      status: workerStatus.status,
      parentUpdated,
    });
    return true;
  } catch (statusError) {
    errorExceptInTest('[dispatchReview] Worker status probe failed, leaving review queued', {
      reviewId: review.id,
      error: statusError,
    });
    captureException(statusError, {
      tags: { operation: 'dispatch-review-worker-status-probe' },
      extra: { reviewId: review.id, owner },
    });
    return false;
  }
}
