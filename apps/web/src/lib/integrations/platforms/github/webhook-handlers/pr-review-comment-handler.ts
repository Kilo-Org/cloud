/**
 * GitHub PR Review Comment Handler
 *
 * Handles pull_request_review_comment events.
 * When a comment contains "@kilo fix" (or similar), delegates to
 * ReviewCommentWebhookProcessor to trigger a scoped auto-fix.
 */

import type { PlatformIntegration } from '@kilocode/db/schema';
import type { PullRequestReviewCommentPayload } from '@/lib/integrations/platforms/github/webhook-schemas';
import { ReviewCommentWebhookProcessor } from '@/lib/auto-fix/application/webhook/review-comment-webhook-processor';

/**
 * Handles PR review comment created events
 * Delegates to ReviewCommentWebhookProcessor for @kilo fix mentions
 */
export async function handlePRReviewComment(
  payload: PullRequestReviewCommentPayload,
  integration: PlatformIntegration
): Promise<void> {
  const processor = new ReviewCommentWebhookProcessor();
  await processor.process(payload, integration);
}
