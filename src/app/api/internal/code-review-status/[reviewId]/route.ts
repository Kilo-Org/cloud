/**
 * Internal API Endpoint: Code Review Status Updates
 *
 * Called by:
 * - Code Review Orchestrator (for 'running' status and sessionId updates)
 * - Cloud-agent-next callback (for 'completed', 'failed', or 'interrupted' status)
 *
 * Accepts both legacy format (from orchestrator) and cloud-agent-next callback format:
 * - Legacy: { status, sessionId?, cliSessionId?, errorMessage? }
 * - cloud-agent-next: { status, sessionId?, cloudAgentSessionId?, executionId?,
 *     kiloSessionId?, errorMessage?, lastSeenBranch? }
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
import { addReactionToPR } from '@/lib/integrations/platforms/github/adapter';
import { addReactionToMR } from '@/lib/integrations/platforms/gitlab/adapter';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  getValidGitLabToken,
  getStoredProjectAccessToken,
} from '@/lib/integrations/gitlab-service';
import { captureException, captureMessage } from '@sentry/nextjs';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
/**
 * Payload from the orchestrator DO (legacy format).
 */
type OrchestratorPayload = {
  sessionId?: string;
  cliSessionId?: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  errorMessage?: string;
};

/**
 * Payload from cloud-agent-next callback (ExecutionCallbackPayload).
 */
type CloudAgentNextCallbackPayload = {
  sessionId?: string;
  cloudAgentSessionId?: string;
  executionId?: string;
  kiloSessionId?: string;
  status: 'completed' | 'failed' | 'interrupted';
  errorMessage?: string;
  lastSeenBranch?: string;
};

type StatusUpdatePayload = OrchestratorPayload | CloudAgentNextCallbackPayload;

/**
 * Normalize a payload from either the orchestrator or cloud-agent-next callback
 * into the common format expected by the update logic.
 */
function normalizePayload(raw: StatusUpdatePayload): {
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  sessionId?: string;
  cliSessionId?: string;
  errorMessage?: string;
} {
  // Map cloud-agent-next 'interrupted' → 'cancelled'
  const status = raw.status === 'interrupted' ? 'cancelled' : raw.status;

  // Map cloud-agent-next 'kiloSessionId' → 'cliSessionId'
  const cliSessionId =
    'cliSessionId' in raw
      ? raw.cliSessionId
      : 'kiloSessionId' in raw
        ? raw.kiloSessionId
        : undefined;

  return {
    status,
    sessionId: raw.sessionId,
    cliSessionId,
    errorMessage: raw.errorMessage,
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
    const rawPayload: StatusUpdatePayload = await req.json();
    const { status, sessionId, cliSessionId, errorMessage } = normalizePayload(rawPayload);

    // Validate payload
    if (!status) {
      return NextResponse.json({ error: 'Missing required field: status' }, { status: 400 });
    }

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
      completedAt:
        status === 'completed' || status === 'failed' || status === 'cancelled'
          ? new Date()
          : undefined,
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

      // Add reaction to indicate review completion status (completed or failed only)
      if (status === 'completed' || status === 'failed') {
        if (review.platform_integration_id) {
          try {
            const integration = await getIntegrationById(review.platform_integration_id);
            if (integration) {
              const platform = review.platform || 'github';

              if (platform === 'github' && integration.platform_installation_id) {
                // GitHub: Use installation token and addReactionToPR
                const [repoOwner, repoName] = review.repo_full_name.split('/');
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
              } else if (platform === PLATFORM.GITLAB) {
                // GitLab: Use PrAT for bot identity, fall back to OAuth token
                const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
                const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

                // Use the stored platform_project_id from the review record
                // This is the numeric GitLab project ID stored when the review was created
                const projectId = review.platform_project_id;
                const storedPrat = projectId
                  ? getStoredProjectAccessToken(integration, projectId)
                  : null;
                let accessToken: string;

                if (storedPrat) {
                  accessToken = storedPrat.token;
                } else {
                  // Fallback to OAuth token
                  accessToken = await getValidGitLabToken(integration);
                }

                // GitLab uses emoji names like 'tada' for hooray, 'confused' for confused
                const emoji = status === 'completed' ? 'tada' : 'confused';

                // For GitLab, we need the project ID from the repo_full_name
                // The repo_full_name is the path_with_namespace (e.g., "group/project")
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
              }
            }
          } catch (reactionError) {
            // Non-blocking - log but don't fail the callback
            logExceptInTest(
              '[code-review-status] Failed to add completion reaction:',
              reactionError
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
