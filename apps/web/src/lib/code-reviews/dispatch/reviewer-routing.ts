import type { CodeReviewReviewerBackend } from '@kilocode/db/schema-types';
import { isOrganizationAllowlistedForIsolateReviews } from '@/lib/posthog-feature-flags';

export type ReviewerRoutingContext = {
  platform?: string | null;
  organizationId?: string | null;
  reviewType?: string | null;
  outputMode?: string | null;
};

export async function selectReviewerBackend(
  context: ReviewerRoutingContext
): Promise<CodeReviewReviewerBackend> {
  if (
    context.platform !== 'github' ||
    !context.organizationId ||
    context.reviewType !== 'standard' ||
    context.outputMode !== 'provider'
  ) {
    return 'legacy';
  }

  return (await isOrganizationAllowlistedForIsolateReviews(context.organizationId))
    ? 'isolate'
    : 'legacy';
}
