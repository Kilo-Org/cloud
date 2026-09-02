import 'server-only';

import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import { getCodeReviewAttemptForReview, getLatestCodeReviewAttempt } from '../db/code-reviews';
import { legacyCodeReviewWorkerClient } from './legacy-code-review-worker-client';
import {
  controlQueuedIsolateReview,
  getIsolateFenceForAttempt,
  startQueuedIsolateReview,
  type QueuedIsolatePayload,
} from './queued-isolate-review-client';
import type {
  DispatchReviewResponse,
  ReviewStatusResponse,
} from './legacy-code-review-worker-client';

export type {
  DispatchReviewResponse,
  ReviewStatusResponse,
  CancelReviewResponse,
  RetryReviewFreshResponse,
} from './legacy-code-review-worker-client';

async function resolveAttempt(reviewId: string, attemptId?: string) {
  const attempt = attemptId
    ? await getCodeReviewAttemptForReview(reviewId, attemptId)
    : await getLatestCodeReviewAttempt(reviewId);
  if (attemptId && !attempt) throw new Error('Code review attempt does not belong to review');
  return attempt;
}

export const codeReviewWorkerClient = {
  async dispatchReview(
    payload: CodeReviewPayload | QueuedIsolatePayload
  ): Promise<DispatchReviewResponse> {
    if ('admission' in payload) {
      const { identity } = payload.admission;
      const attempt = await resolveAttempt(identity.reviewId, identity.attemptId);
      if (attempt?.reviewer_backend !== 'isolate')
        throw new Error('Isolate attempt affinity required');
      const status = await startQueuedIsolateReview(payload);
      return {
        reviewId: identity.reviewId,
        attemptId: identity.attemptId,
        status: status.safety.execution === 'not_started' ? 'queued' : status.safety.execution,
      };
    }
    const attempt = await resolveAttempt(payload.reviewId, payload.attemptId);
    if (attempt?.reviewer_backend !== 'legacy') throw new Error('Legacy attempt affinity required');
    return legacyCodeReviewWorkerClient.dispatchReview({ ...payload, attemptId: attempt.id });
  },

  async cancelReview(reviewId: string, reason?: string, attemptId?: string) {
    const attempt = await resolveAttempt(reviewId, attemptId);
    if (attempt?.reviewer_backend === 'isolate') {
      const fence = await getIsolateFenceForAttempt(reviewId, attempt.id);
      if (fence.released_at) return { success: true, reviewId };
      const status = await controlQueuedIsolateReview(fence.identity, 'cancel');
      return { success: status !== null, reviewId };
    }
    if (attempt?.reviewer_backend === 'unselected') return { success: false, reviewId };
    return legacyCodeReviewWorkerClient.cancelReview(reviewId, reason, attempt?.id);
  },

  async getReviewStatus(
    reviewId: string,
    attemptId?: string
  ): Promise<ReviewStatusResponse | null> {
    const attempt = await resolveAttempt(reviewId, attemptId);
    if (attempt?.reviewer_backend === 'isolate') {
      const fence = await getIsolateFenceForAttempt(reviewId, attempt.id);
      const status = await controlQueuedIsolateReview(fence.identity, 'status');
      return status
        ? {
            reviewId,
            attemptId: attempt.id,
            status: status.safety.execution === 'not_started' ? 'queued' : status.safety.execution,
          }
        : null;
    }
    if (attempt?.reviewer_backend === 'unselected') return null;
    return legacyCodeReviewWorkerClient.getReviewStatus(reviewId, attempt?.id);
  },

  async retryReviewFresh(
    reviewId: string,
    input: Parameters<typeof legacyCodeReviewWorkerClient.retryReviewFresh>[1]
  ) {
    const attempt = await resolveAttempt(reviewId, input.failedAttemptId);
    if (attempt && attempt.reviewer_backend !== 'legacy')
      throw new Error('Fresh session retries are legacy-only');
    return legacyCodeReviewWorkerClient.retryReviewFresh(reviewId, {
      ...input,
      failedAttemptId: attempt?.id,
    });
  },
};
