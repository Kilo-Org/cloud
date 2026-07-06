import 'server-only';

import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import {
  disableBitbucketCodeReviewerForIntegration,
  type CancelledReviewRow,
} from '@/lib/code-reviews/db/code-reviews';
import { deleteBitbucketCodeReviewWorkspaceWebhooksBestEffort } from './code-review-webhooks';

type BitbucketCodeReviewerCleanupWorkspace = {
  uuid: string;
  slug: string;
};

type BitbucketCodeReviewerIntegrationCleanupInput = {
  organizationId: string;
  currentManagerId: string;
  integrationId: string;
  workspace?: BitbucketCodeReviewerCleanupWorkspace | null;
};

async function interruptDisabledBitbucketReviews(
  cancelledReviews: CancelledReviewRow[]
): Promise<void> {
  await Promise.allSettled(
    cancelledReviews
      .filter(review => review.prevStatus === 'queued' || review.prevStatus === 'running')
      .map(review =>
        codeReviewWorkerClient.cancelReview(
          review.id,
          'Bitbucket Code Reviewer disabled',
          review.latestActiveAttemptId ?? undefined
        )
      )
  );
}

export async function cleanupBitbucketCodeReviewerForIntegration(
  input: BitbucketCodeReviewerIntegrationCleanupInput
): Promise<void> {
  const cancelledReviews = await disableBitbucketCodeReviewerForIntegration({
    organizationId: input.organizationId,
    integrationId: input.integrationId,
  });
  await interruptDisabledBitbucketReviews(cancelledReviews);

  if (!input.workspace) return;
  await deleteBitbucketCodeReviewWorkspaceWebhooksBestEffort({
    organizationId: input.organizationId,
    currentManagerId: input.currentManagerId,
    workspace: {
      integrationId: input.integrationId,
      workspaceUuid: input.workspace.uuid,
      workspaceSlug: input.workspace.slug,
    },
  });
}
