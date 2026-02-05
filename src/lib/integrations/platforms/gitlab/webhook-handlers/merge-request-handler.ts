/**
 * GitLab Merge Request Event Handler
 *
 * Handles merge request events that trigger code review:
 * - open: New MR created
 * - update: MR updated (new commits pushed)
 * - reopen: MR reopened
 */

import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { MergeRequestPayload } from '../webhook-schemas';
import { GITLAB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import {
  createCodeReview,
  findExistingReview,
  findActiveReviewsForPR,
} from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import type { PlatformIntegration } from '@/db/schema';
import type { Owner } from '@/lib/code-reviews/core';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import { addReactionToMR } from '../adapter';
import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { getOrCreateProjectAccessToken } from '@/lib/integrations/gitlab-service';

/**
 * Handles merge request events that trigger code review
 * (open, update, reopen)
 */
export async function handleMergeRequestCodeReview(
  payload: MergeRequestPayload,
  integration: PlatformIntegration
) {
  const { object_attributes: mr, project } = payload;

  try {
    logExceptInTest('Merge request event received:', {
      action: mr.action,
      mr_iid: mr.iid,
      project: project.path_with_namespace,
      title: mr.title,
      author: payload.user?.username,
    });

    // Skip draft/WIP MRs - only trigger code review for ready MRs
    if (mr.draft === true || mr.work_in_progress === true) {
      logExceptInTest('Skipping draft/WIP MR:', {
        mr_iid: mr.iid,
        project: project.path_with_namespace,
      });
      return NextResponse.json({ message: 'Skipped draft MR' }, { status: 200 });
    }

    // Debug: Log integration fields
    logExceptInTest('Integration fields:', {
      id: integration.id,
      owned_by_organization_id: integration.owned_by_organization_id,
      owned_by_user_id: integration.owned_by_user_id,
      kilo_requester_user_id: integration.kilo_requester_user_id,
    });

    // 1. Determine owner from integration
    // For orgs: use bot user, fallback to integration creator
    const orgBotUserId = integration.owned_by_organization_id
      ? await getBotUserId(integration.owned_by_organization_id, 'code-review')
      : null;

    const owner: Owner = integration.owned_by_organization_id
      ? {
          type: 'org',
          id: integration.owned_by_organization_id,
          // Use bot user if available, fallback to integration creator
          userId: (orgBotUserId ?? integration.kilo_requester_user_id) as string,
        }
      : {
          type: 'user',
          id: integration.owned_by_user_id as string,
          userId: integration.owned_by_user_id as string,
        };

    // Validate we have a valid user ID
    if (!owner.userId) {
      logExceptInTest('No valid user ID found for integration:', {
        integrationId: integration.id,
        ownedByOrgId: integration.owned_by_organization_id,
        ownedByUserId: integration.owned_by_user_id,
        kiloRequesterId: integration.kilo_requester_user_id,
      });
      return NextResponse.json({ message: 'Integration missing user context' }, { status: 500 });
    }

    // 2. Check if code review agent is enabled for this owner (GitLab platform)
    const agentConfig = await getAgentConfigForOwner(owner, 'code_review', 'gitlab');

    if (!agentConfig || !agentConfig.is_enabled) {
      logExceptInTest(
        `Code review agent not enabled for ${owner.type} ${owner.id} (project: ${project.path_with_namespace})`
      );
      return NextResponse.json(
        { message: 'Code review agent not enabled for this project' },
        { status: 200 }
      );
    }

    logExceptInTest(
      `Code review agent enabled for ${owner.type} ${owner.id}, processing ${project.path_with_namespace}!${mr.iid}`
    );

    // 3. Check if repository is in allowed list (when using selected repositories mode)
    const config = agentConfig.config as CodeReviewAgentConfig;
    if (
      config?.repository_selection_mode === 'selected' &&
      Array.isArray(config?.selected_repository_ids)
    ) {
      // Check both selected_repository_ids and manually_added_repositories
      const isInSelectedList = config.selected_repository_ids.includes(project.id);
      const isInManuallyAddedList = Array.isArray(config.manually_added_repositories)
        ? config.manually_added_repositories.some(repo => repo.id === project.id)
        : false;
      const isRepositoryAllowed = isInSelectedList || isInManuallyAddedList;

      if (!isRepositoryAllowed) {
        logExceptInTest(
          `Project ${project.path_with_namespace} (ID: ${project.id}) not in allowed list for ${owner.type} ${owner.id}`
        );
        return NextResponse.json(
          { message: 'Project not configured for code reviews' },
          { status: 200 }
        );
      }

      logExceptInTest(
        `Project ${project.path_with_namespace} (ID: ${project.id}) is in allowed list, proceeding with review`
      );
    }

    // Get the head SHA from the last commit
    const headSha = mr.last_commit?.id;
    if (!headSha) {
      logExceptInTest('No head commit SHA found in MR payload:', {
        mr_iid: mr.iid,
        project: project.path_with_namespace,
      });
      return NextResponse.json({ message: 'No head commit found' }, { status: 400 });
    }

    // 4. Cancel any existing reviews for this MR (different SHA)
    // This prevents spam when user pushes multiple commits quickly
    const oldReviewIds = await findActiveReviewsForPR(project.path_with_namespace, mr.iid, headSha);

    if (oldReviewIds.length > 0) {
      logExceptInTest(
        `Cancelling ${oldReviewIds.length} old review(s) for ${project.path_with_namespace}!${mr.iid}`
      );

      // Cancel each review via the orchestrator (fire-and-forget, don't block new review)
      await Promise.allSettled(
        oldReviewIds.map(reviewId =>
          codeReviewWorkerClient.cancelReview(reviewId, 'Superseded by new push').catch(err => {
            logExceptInTest(`Failed to cancel review ${reviewId}:`, err);
            return { success: false, reviewId };
          })
        )
      );
    }

    // 5. Check for duplicate review (same project, MR, SHA)
    const existingReview = await findExistingReview(project.path_with_namespace, mr.iid, headSha);

    if (existingReview) {
      logExceptInTest(
        `Duplicate code review detected for ${project.path_with_namespace}!${mr.iid} @ ${headSha}`
      );
      return NextResponse.json(
        {
          message: 'Review already exists for this commit',
          reviewId: existingReview.id,
          sessionId: existingReview.session_id,
        },
        { status: 200 }
      );
    }

    // 6. Create review record (session_id will be updated async)
    const reviewId = await createCodeReview({
      owner,
      platformIntegrationId: integration.id,
      repoFullName: project.path_with_namespace,
      prNumber: mr.iid,
      prUrl: mr.url,
      prTitle: mr.title,
      prAuthor: payload.user.username,
      baseRef: mr.target_branch,
      headRef: mr.source_branch,
      headSha,
      platform: 'gitlab',
      platformProjectId: project.id,
    });

    logExceptInTest(`Created code review ${reviewId} for ${project.path_with_namespace}!${mr.iid}`);

    // 7. Get or create Project Access Token (PrAT) for bot identity
    // This is also used later in prepare-review-payload.ts for the actual review
    const fullIntegration = await getIntegrationById(integration.id);
    const metadata = fullIntegration?.metadata as {
      gitlab_instance_url?: string;
    } | null;
    const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

    // 8. Post 👀 reaction to show Kilo is reviewing (using PrAT for bot identity)
    if (fullIntegration) {
      try {
        const pratToken = await getOrCreateProjectAccessToken(fullIntegration, project.id);
        logExceptInTest(`Got PrAT for project ${project.path_with_namespace}`, {
          projectId: project.id,
        });

        await addReactionToMR(pratToken, project.id, mr.iid, 'eyes', instanceUrl);
        logExceptInTest(`Added eyes reaction to ${project.path_with_namespace}!${mr.iid}`);
      } catch (reactionError) {
        // Non-blocking - log but don't fail the review
        // If this is a PrAT permission error, the review will fail later with a clear message
        logExceptInTest('Failed to add eyes reaction (PrAT may not be available):', {
          projectId: project.id,
          error: reactionError instanceof Error ? reactionError.message : String(reactionError),
        });
      }
    }

    // 9. Try to dispatch pending reviews (including this new one)
    // Review is created with status='pending' and dispatch will pick it up if slots available
    try {
      const dispatchResult = await tryDispatchPendingReviews(owner);

      logExceptInTest(`Dispatch attempt for ${project.path_with_namespace}!${mr.iid}`, {
        reviewId,
        dispatched: dispatchResult.dispatched,
        pending: dispatchResult.pending,
        activeCount: dispatchResult.activeCount,
      });
    } catch (dispatchError) {
      logExceptInTest('Error during dispatch:', dispatchError);
      captureException(dispatchError, {
        tags: { source: 'merge_request_webhook_dispatch' },
        extra: {
          reviewId,
          project: project.path_with_namespace,
          mrIid: mr.iid,
          owner,
        },
      });
      // Don't throw - review record created as pending, will be picked up later
    }

    // 10. Return 202 Accepted (always succeeds, review queued as pending)
    return NextResponse.json(
      {
        message: 'Code review queued',
        reviewId,
      },
      { status: 202 }
    );
  } catch (error) {
    logExceptInTest('Error processing code review:', error);
    captureException(error, {
      tags: { source: 'merge_request_webhook' },
      extra: {
        project: project.path_with_namespace,
        mrIid: mr.iid,
      },
    });

    return NextResponse.json(
      {
        error: 'Failed to trigger code review',
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

/**
 * Main router for merge request events
 */
export async function handleMergeRequest(
  payload: MergeRequestPayload,
  integration: PlatformIntegration
) {
  const { action } = payload.object_attributes;

  switch (action) {
    case GITLAB_ACTION.OPEN:
    case GITLAB_ACTION.UPDATE:
    case GITLAB_ACTION.REOPEN:
      return handleMergeRequestCodeReview(payload, integration);
    default:
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
  }
}
