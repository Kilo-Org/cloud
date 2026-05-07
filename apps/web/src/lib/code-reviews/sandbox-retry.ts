import { captureException } from '@sentry/nextjs';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { errorExceptInTest, logExceptInTest } from '@/lib/utils.server';
import {
  claimCodeReviewsForSandboxRetry,
  type ClaimedCodeReviewForSandboxRetry,
} from './db/code-reviews';
import { tryDispatchPendingReviews } from './dispatch/dispatch-pending-reviews';
import { updateCodeReviewRetryingGateCheck } from './gate/retrying-gate-check';

type DispatchOwner =
  | { type: 'org'; id: string; userId: string }
  | { type: 'user'; id: string; userId: string };

function ownerKey(owner: DispatchOwner): string {
  return `${owner.type}:${owner.id}:${owner.userId}`;
}

async function ownerForReview(
  review: ClaimedCodeReviewForSandboxRetry
): Promise<DispatchOwner | null> {
  if (review.owned_by_organization_id) {
    const botUserId = await getBotUserId(review.owned_by_organization_id, 'code-review');
    if (!botUserId) return null;
    return { type: 'org', id: review.owned_by_organization_id, userId: botUserId };
  }

  if (review.owned_by_user_id) {
    return { type: 'user', id: review.owned_by_user_id, userId: review.owned_by_user_id };
  }

  return null;
}

async function updateRetryingGateCheck(review: ClaimedCodeReviewForSandboxRetry): Promise<void> {
  if (!review.platform_integration_id) return;

  const integration = await getIntegrationById(review.platform_integration_id);
  if (!integration) return;

  await updateCodeReviewRetryingGateCheck(review, integration);
}

export async function claimAndDispatchCodeReviewSandboxRetries(params: {
  sandboxId: string;
  destroyedAt?: string;
  source: string;
}): Promise<{ claimed: number; dispatchedOwners: number }> {
  const claimed = await claimCodeReviewsForSandboxRetry(params.sandboxId, {
    reason: 'sandbox_500_destroyed',
    destroyedAt: params.destroyedAt,
  });

  logExceptInTest('[code-review-sandbox-retry] Claimed reviews for retry', {
    sandboxId: params.sandboxId,
    source: params.source,
    claimed: claimed.length,
    reviewIds: claimed.map(review => review.id),
  });

  await Promise.allSettled(
    claimed.map(review =>
      updateRetryingGateCheck(review).catch((error: unknown) => {
        logExceptInTest('[code-review-sandbox-retry] Failed to update retrying gate', {
          reviewId: review.id,
          error,
        });
      })
    )
  );

  const owners = new Map<string, DispatchOwner>();
  for (const review of claimed) {
    const owner = await ownerForReview(review);
    if (!owner) {
      errorExceptInTest('[code-review-sandbox-retry] Could not resolve owner for retry', {
        reviewId: review.id,
      });
      continue;
    }
    owners.set(ownerKey(owner), owner);
  }

  await Promise.all(
    [...owners.values()].map(owner =>
      tryDispatchPendingReviews(owner).catch((error: unknown) => {
        captureException(error, {
          tags: { source: 'code-review-sandbox-retry-dispatch' },
          extra: { owner, sandboxId: params.sandboxId, retrySource: params.source },
        });
        errorExceptInTest('[code-review-sandbox-retry] Dispatch failed for retry owner', {
          owner,
          error,
        });
      })
    )
  );

  logExceptInTest('[code-review-sandbox-retry] Dispatched retry owners', {
    sandboxId: params.sandboxId,
    source: params.source,
    dispatchedOwners: owners.size,
  });

  return { claimed: claimed.length, dispatchedOwners: owners.size };
}
