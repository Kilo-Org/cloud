/**
 * Internal API Endpoint: Code Review Status Updates
 *
 * Called by:
 * - Code Review Orchestrator (for 'running' status and sessionId updates)
 * - Cloud Agent callback (for 'completed' or 'failed' status)
 *
 * The reviewId is passed in the URL path.
 *
 * URL: POST /api/internal/code-review-status/{reviewId}
 * Protected by internal API secret
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { updateCodeReviewStatus, getCodeReviewById } from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import { logExceptInTest, errorExceptInTest } from '@/lib/utils.server';
import {
  addReactionToPR,
  findKiloReviewComment,
  updateKiloReviewComment,
} from '@/lib/integrations/platforms/github/adapter';
import {
  addReactionToMR,
  findKiloReviewNote,
  updateKiloReviewNote,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  getValidGitLabToken,
  getStoredProjectAccessToken,
} from '@/lib/integrations/gitlab-service';
import { captureException, captureMessage } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { appendUsageFooter } from '@/lib/code-reviews/summary/usage-footer';
import { z } from 'zod';

const StatusUpdatePayloadSchema = z.object({
  sessionId: z.string().optional(),
  cliSessionId: z.string().optional(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  errorMessage: z.string().optional(),
});

/**
 * Read a review's usage data, polling with exponential backoff if not yet available.
 * Handles the race between the orchestrator's usage report and the cloud agent's completion callback.
 */
async function getReviewUsageData(reviewId: string) {
  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 200;

  let review = await getCodeReviewById(reviewId);

  for (let attempt = 0; attempt < MAX_RETRIES && review && !review.model; attempt++) {
    await new Promise(resolve => setTimeout(resolve, BASE_DELAY_MS * 2 ** attempt));
    review = await getCodeReviewById(reviewId);
  }

  return {
    model: review?.model ?? null,
    tokensIn: review?.total_tokens_in ?? null,
    tokensOut: review?.total_tokens_out ?? null,
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> }
) {
  try {
    // Validate internal API secret
    const secret = req.headers.get('X-Internal-Secret');
    if (secret !== INTERNAL_API_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { reviewId } = await params;
    const rawPayload = await req.json();
    const parseResult = StatusUpdatePayloadSchema.safeParse(rawPayload);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid payload', details: parseResult.error.flatten() },
        { status: 400 }
      );
    }
    const { sessionId, cliSessionId, status, errorMessage } = parseResult.data;

    logExceptInTest('[code-review-status] Received status update', {
      reviewId,
      sessionId,
      cliSessionId,
      status,
      hasError: !!errorMessage,
    });

    // Get current review to check if update is needed
    const review = await getCodeReviewById(reviewId);

    if (!review) {
      logExceptInTest('[code-review-status] Review not found', { reviewId });
      return NextResponse.json({ error: 'Review not found' }, { status: 404 });
    }

    // Determine valid transitions based on incoming status
    const isTerminalState =
      review.status === 'completed' || review.status === 'failed' || review.status === 'cancelled';

    if (isTerminalState) {
      // Already in terminal state - skip update
      logExceptInTest('[code-review-status] Review already in terminal state, skipping update', {
        reviewId,
        currentStatus: review.status,
        requestedStatus: status,
      });
      return NextResponse.json({
        success: true,
        message: 'Review already in terminal state',
        currentStatus: review.status,
      });
    }

    // Valid transitions:
    // - queued -> running (orchestrator starting)
    // - running -> running (sessionId update)
    // - running -> completed/failed (callback)
    // - queued -> completed/failed (edge case: immediate failure)

    // Update review status in database
    await updateCodeReviewStatus(reviewId, status, {
      sessionId,
      cliSessionId,
      errorMessage,
      startedAt: status === 'running' ? new Date() : undefined,
      completedAt: status === 'completed' || status === 'failed' ? new Date() : undefined,
    });

    logExceptInTest('[code-review-status] Updated review status', {
      reviewId,
      sessionId,
      cliSessionId,
      status,
    });

    // Only trigger dispatch for terminal states (completed/failed/cancelled)
    // This frees up a slot for the next pending review
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      let owner;
      if (review.owned_by_organization_id) {
        const botUserId = await getBotUserId(review.owned_by_organization_id, 'code-review');
        if (botUserId) {
          owner = {
            type: 'org' as const,
            id: review.owned_by_organization_id,
            userId: botUserId,
          };
        } else {
          errorExceptInTest('[code-review-status] Bot user not found for organization', {
            organizationId: review.owned_by_organization_id,
            reviewId,
          });
          captureMessage('Bot user missing for organization code review', {
            level: 'error',
            tags: { source: 'code-review-status' },
            extra: { organizationId: review.owned_by_organization_id, reviewId },
          });
        }
      } else {
        owner = {
          type: 'user' as const,
          id: review.owned_by_user_id || '',
          userId: review.owned_by_user_id || '',
        };
      }

      if (owner) {
        // Trigger dispatch in background (don't await - fire and forget)
        tryDispatchPendingReviews(owner).catch(dispatchError => {
          errorExceptInTest(
            '[code-review-status] Error dispatching pending reviews:',
            dispatchError
          );
          captureException(dispatchError, {
            tags: { source: 'code-review-status-dispatch' },
            extra: { reviewId, owner },
          });
        });

        logExceptInTest('[code-review-status] Triggered dispatch for pending reviews', {
          reviewId,
          owner,
        });
      }

      // Add reaction to indicate review completion status AND update usage footer
      if (status === 'completed' || status === 'failed') {
        if (review.platform_integration_id) {
          try {
            const integration = await getIntegrationById(review.platform_integration_id);
            if (integration) {
              const platform = review.platform || 'github';

              if (platform === 'github' && integration.platform_installation_id) {
                const [repoOwner, repoName] = review.repo_full_name.split('/');

                // Reaction
                const reaction = status === 'completed' ? 'hooray' : 'confused';
                await addReactionToPR(
                  integration.platform_installation_id,
                  repoOwner,
                  repoName,
                  review.pr_number,
                  reaction
                );
                logExceptInTest(
                  `[code-review-status] Added ${reaction} reaction to ${review.repo_full_name}#${review.pr_number}`
                );

                // Usage footer (completed only)
                if (status === 'completed') {
                  const { model, tokensIn, tokensOut } = await getReviewUsageData(reviewId);

                  if (model && tokensIn != null && tokensOut != null) {
                    const existing = await findKiloReviewComment(
                      integration.platform_installation_id,
                      repoOwner,
                      repoName,
                      review.pr_number
                    );
                    if (existing) {
                      const updatedBody = appendUsageFooter(
                        existing.body,
                        model,
                        tokensIn,
                        tokensOut
                      );
                      await updateKiloReviewComment(
                        integration.platform_installation_id,
                        repoOwner,
                        repoName,
                        existing.commentId,
                        updatedBody
                      );
                      logExceptInTest(
                        `[code-review-status] Updated summary comment with usage footer on ${review.repo_full_name}#${review.pr_number}`
                      );
                    }
                  } else {
                    logExceptInTest(
                      '[code-review-status] Usage data not available for footer update',
                      {
                        reviewId,
                        model,
                        tokensIn,
                        tokensOut,
                      }
                    );
                  }
                }
              } else if (platform === PLATFORM.GITLAB) {
                const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
                const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';
                const projectId = review.platform_project_id;
                const storedPrat = projectId
                  ? getStoredProjectAccessToken(integration, projectId)
                  : null;
                const accessToken = storedPrat
                  ? storedPrat.token
                  : await getValidGitLabToken(integration);

                // Reaction
                const emoji = status === 'completed' ? 'tada' : 'confused';
                await addReactionToMR(
                  accessToken,
                  review.repo_full_name,
                  review.pr_number,
                  emoji,
                  instanceUrl
                );
                logExceptInTest(
                  `[code-review-status] Added ${emoji} reaction to GitLab MR ${review.repo_full_name}!${review.pr_number}`
                );

                // Usage footer (completed only)
                if (status === 'completed') {
                  const { model, tokensIn, tokensOut } = await getReviewUsageData(reviewId);

                  if (model && tokensIn != null && tokensOut != null) {
                    const existing = await findKiloReviewNote(
                      accessToken,
                      review.repo_full_name,
                      review.pr_number,
                      instanceUrl
                    );
                    if (existing) {
                      const updatedBody = appendUsageFooter(
                        existing.body,
                        model,
                        tokensIn,
                        tokensOut
                      );
                      await updateKiloReviewNote(
                        accessToken,
                        review.repo_full_name,
                        review.pr_number,
                        existing.noteId,
                        updatedBody,
                        instanceUrl
                      );
                      logExceptInTest(
                        `[code-review-status] Updated summary note with usage footer on GitLab MR ${review.repo_full_name}!${review.pr_number}`
                      );
                    }
                  } else {
                    logExceptInTest(
                      '[code-review-status] Usage data not available for footer update',
                      {
                        reviewId,
                        model,
                        tokensIn,
                        tokensOut,
                      }
                    );
                  }
                }
              }
            }
          } catch (postCompletionError) {
            // Non-blocking - log but don't fail the callback
            logExceptInTest(
              '[code-review-status] Failed to add completion reaction or usage footer:',
              postCompletionError
            );
          }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    errorExceptInTest('[code-review-status] Error processing status update:', error);
    captureException(error, {
      tags: { source: 'code-review-status-api' },
    });

    return NextResponse.json(
      {
        error: 'Failed to process status update',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
