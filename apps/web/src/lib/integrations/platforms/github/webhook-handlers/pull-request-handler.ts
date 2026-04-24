import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import type { PullRequestPayload } from '../webhook-schemas';
import { GITHUB_ACTION } from '@/lib/integrations/core/constants';
import { logExceptInTest } from '@/lib/utils.server';
import {
  createCodeReview,
  findExistingReview,
  findActiveReviewsForPR,
} from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { getAgentConfigForOwner } from '@/lib/agent-config/db/agent-configs';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { Owner } from '@/lib/code-reviews/core';
import { getBotUserId } from '@/lib/bot-users/bot-user-service';
import type { CodeReviewAgentConfig } from '@/lib/agent-config/core/types';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/adapter';
import {
  addReactionToPR,
  createCheckRun,
  isMergeCommit,
  updateCheckRun,
} from '@/lib/integrations/platforms/github/adapter';
import { codeReviewWorkerClient } from '@/lib/code-reviews/client/code-review-worker-client';
import { updateCheckRunId } from '@/lib/code-reviews/db/code-reviews';
import { resolvePullRequestCheckoutRef } from './pull-request-checkout-ref';
import { APP_URL } from '@/lib/constants';

/**
 * GitHub Pull Request Event Handler
 * Handles: opened, synchronize, reopened

/**
 * Handles pull request events that trigger code review
 * (opened, synchronize, reopened)
 * Triggers cloud agent code review if agent config is enabled
 */
export async function handlePullRequestCodeReview(
  payload: PullRequestPayload,
  integration: PlatformIntegration
) {
  const { pull_request, repository } = payload;

  try {
    const checkoutRef = resolvePullRequestCheckoutRef(payload);

    logExceptInTest('Pull request event received:', {
      action: payload.action,
      pr_number: pull_request.number,
      repo: repository.full_name,
      title: pull_request.title,
      author: pull_request.user?.login,
    });
    logExceptInTest('Resolved pull request checkout ref:', {
      pr_number: pull_request.number,
      repo: repository.full_name,
      isForkPr: checkoutRef.isForkPr,
      headRepoFullName: checkoutRef.headRepoFullName,
      checkoutRef: checkoutRef.checkoutRef,
    });

    // Skip draft PRs - only trigger code review for ready PRs
    if (pull_request.draft === true) {
      logExceptInTest('Skipping draft PR:', {
        pr_number: pull_request.number,
        repo: repository.full_name,
      });
      return NextResponse.json({ message: 'Skipped draft PR' }, { status: 200 });
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

    // 2. Check if code review agent is enabled for this owner
    const agentConfig = await getAgentConfigForOwner(owner, 'code_review', 'github');

    if (!agentConfig || !agentConfig.is_enabled) {
      logExceptInTest(
        `Code review agent not enabled for ${owner.type} ${owner.id} (repo: ${repository.full_name})`
      );
      return NextResponse.json(
        { message: 'Code review agent not enabled for this repository' },
        { status: 200 }
      );
    }

    logExceptInTest(
      `Code review agent enabled for ${owner.type} ${owner.id}, processing ${repository.full_name}#${pull_request.number}`
    );

    // 3. Check if repository is in allowed list (when using selected repositories mode)
    const config = agentConfig.config as CodeReviewAgentConfig;
    if (
      config?.repository_selection_mode === 'selected' &&
      Array.isArray(config?.selected_repository_ids)
    ) {
      const isRepositoryAllowed = config.selected_repository_ids.includes(repository.id);

      if (!isRepositoryAllowed) {
        logExceptInTest(
          `Repository ${repository.full_name} (ID: ${repository.id}) not in allowed list for ${owner.type} ${owner.id}`
        );
        return NextResponse.json(
          { message: 'Repository not configured for code reviews' },
          { status: 200 }
        );
      }

      logExceptInTest(
        `Repository ${repository.full_name} (ID: ${repository.id}) is in allowed list, proceeding with review`
      );
    }

    const appType = integration.github_app_type ?? 'standard';
    const headFullName = checkoutRef.headRepoFullName ?? repository.full_name;
    const [headOwner, headRepoName] = headFullName.split('/');

    // 4. Skip merge commits on synchronize (e.g. merging base branch into feature branch).
    // Runs before cancellation so that an in-flight review at an earlier SHA is preserved:
    // a merge commit introduces no new feature work and should not supersede the existing review.
    if (
      headOwner &&
      headRepoName &&
      (await shouldSkipSynchronizeForMergeCommit({
        action: payload.action,
        installationId: integration.platform_installation_id as string,
        headOwner,
        headRepoName,
        headSha: pull_request.head.sha,
        appType,
      }))
    ) {
      logExceptInTest('Skipping merge commit:', {
        pr_number: pull_request.number,
        repo: repository.full_name,
        head_sha: pull_request.head.sha,
      });
      return NextResponse.json({ message: 'Skipped merge commit' }, { status: 200 });
    }

    // 5. Cancel any existing reviews for this PR (different SHA)
    // This prevents spam when user pushes multiple commits quickly
    const oldReviewIds = await findActiveReviewsForPR(
      repository.full_name,
      pull_request.number,
      pull_request.head.sha
    );

    if (oldReviewIds.length > 0) {
      logExceptInTest(
        `Cancelling ${oldReviewIds.length} old review(s) for ${repository.full_name}#${pull_request.number}`
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

    // 6. Check for duplicate review (same repo, PR, SHA)
    const existingReview = await findExistingReview(
      repository.full_name,
      pull_request.number,
      pull_request.head.sha
    );

    if (existingReview) {
      logExceptInTest(
        `Duplicate code review detected for ${repository.full_name}#${pull_request.number} @ ${pull_request.head.sha}`
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

    // 7. Create review record (session_id will be updated async)
    const reviewId = await createCodeReview({
      owner,
      platformIntegrationId: integration.id,
      repoFullName: repository.full_name,
      prNumber: pull_request.number,
      prUrl: pull_request.html_url as string,
      prTitle: pull_request.title,
      prAuthor: pull_request.user.login,
      prAuthorGithubId: String(pull_request.user.id),
      baseRef: pull_request.base.ref,
      headRef: checkoutRef.checkoutRef,
      headSha: pull_request.head.sha,
      platform: 'github',
    });

    logExceptInTest(
      `Created code review ${reviewId} for ${repository.full_name}#${pull_request.number}`
    );

    const [repoOwner, repoName] = repository.full_name.split('/');

    // 8. Create GitHub Check Run (PR gate) — skip for lite (read-only) app
    if (appType !== 'lite') {
      let checkRunId: number | undefined;
      try {
        const detailsUrl = `${APP_URL}/code-reviews/${reviewId}`;
        checkRunId = await createCheckRun(
          integration.platform_installation_id as string,
          repoOwner,
          repoName,
          pull_request.head.sha,
          {
            detailsUrl,
            output: {
              title: 'Kilo Code Review queued',
              summary: 'Waiting for a review slot...',
            },
          },
          appType
        );
        await updateCheckRunId(reviewId, checkRunId);
        logExceptInTest(
          `Created check run ${checkRunId} for ${repository.full_name}#${pull_request.number}`
        );
      } catch (checkRunError) {
        // Non-blocking — the review still proceeds even if the check run fails
        // (e.g. the app may not yet have the checks:write permission)
        logExceptInTest('Failed to create check run:', checkRunError);
        // If we created the check run on GitHub but failed to persist its ID,
        // cancel it so it doesn't block merging on repos with required checks.
        if (checkRunId !== undefined) {
          try {
            await updateCheckRun(
              integration.platform_installation_id as string,
              repoOwner,
              repoName,
              checkRunId,
              { status: 'completed', conclusion: 'cancelled' }
            );
            logExceptInTest(
              `Cancelled orphaned check run ${checkRunId} for ${repository.full_name}#${pull_request.number}`
            );
          } catch (cancelError) {
            logExceptInTest('Failed to cancel orphaned check run:', cancelError);
          }
        }
      }
    }

    // 9. Post 👀 reaction to show Kilo is reviewing
    try {
      await addReactionToPR(
        integration.platform_installation_id as string,
        repoOwner,
        repoName,
        pull_request.number,
        'eyes'
      );
      logExceptInTest(`Added eyes reaction to ${repository.full_name}#${pull_request.number}`);
    } catch (reactionError) {
      // Non-blocking - log but don't fail the review
      logExceptInTest('Failed to add eyes reaction:', reactionError);
    }

    // 10. Try to dispatch pending reviews (including this new one)
    // Review is created with status='pending' and dispatch will pick it up if slots available
    try {
      const dispatchResult = await tryDispatchPendingReviews(owner);

      logExceptInTest(`Dispatch attempt for ${repository.full_name}#${pull_request.number}`, {
        reviewId,
        dispatched: dispatchResult.dispatched,
        pending: dispatchResult.pending,
        activeCount: dispatchResult.activeCount,
      });
    } catch (dispatchError) {
      logExceptInTest('Error during dispatch:', dispatchError);
      captureException(dispatchError, {
        tags: { source: 'pull_request_webhook_dispatch' },
        extra: {
          reviewId,
          repository: repository.full_name,
          prNumber: pull_request.number,
          owner,
        },
      });
      // Don't throw - review record created as pending, will be picked up later
    }

    // 11. Return 202 Accepted (always succeeds, review queued as pending)
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
      tags: { source: 'pull_request_webhook' },
      extra: {
        repository: repository.full_name,
        prNumber: pull_request.number,
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
 * Decides whether a pull_request webhook should bail out because its head
 * commit is a merge commit (e.g. produced by GitHub's "Update branch" button
 * or a manual `git merge main`). Only applies to synchronize events.
 *
 * Extracted so tests can inject a fake `isMergeCommitFn` without mocking the
 * GitHub adapter module.
 */
export async function shouldSkipSynchronizeForMergeCommit(args: {
  action: string;
  installationId: string;
  headOwner: string;
  headRepoName: string;
  headSha: string;
  appType: GitHubAppType;
  isMergeCommitFn?: (
    installationId: string,
    owner: string,
    repo: string,
    sha: string,
    appType: GitHubAppType
  ) => Promise<boolean>;
}): Promise<boolean> {
  if (args.action !== GITHUB_ACTION.SYNCHRONIZE) return false;
  const check = args.isMergeCommitFn ?? isMergeCommit;
  return check(args.installationId, args.headOwner, args.headRepoName, args.headSha, args.appType);
}

/**
 * Main router for pull request events
 */
export async function handlePullRequest(
  payload: PullRequestPayload,
  integration: PlatformIntegration
) {
  const { action } = payload;

  switch (action) {
    case GITHUB_ACTION.OPENED:
    case GITHUB_ACTION.SYNCHRONIZE:
    case GITHUB_ACTION.REOPENED:
    case GITHUB_ACTION.READY_FOR_REVIEW:
      return handlePullRequestCodeReview(payload, integration);
    default:
      return NextResponse.json({ message: 'Event received' }, { status: 200 });
  }
}
