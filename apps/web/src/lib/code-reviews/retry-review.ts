/**
 * Restarting a code review that stopped on a failure.
 *
 * The manual retrigger and the missed-review sweep run this one sequence, so a
 * review restarted without a person cannot diverge from one restarted by hand:
 * a status compare-and-set reset, a new attempt row, a fresh pull request gate
 * check, then the dispatch that owns the retry from there.
 */

import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type { CodeReviewTerminalReason } from '@kilocode/db/schema-types';
import type { Owner } from '@/lib/code-reviews/core';
import { CodeReviewPlatformSchema } from '@/lib/code-reviews/core/schemas';
import {
  createCodeReviewAttempt,
  ensureCurrentCodeReviewAttemptFromReview,
  getCodeReviewById,
  resetCodeReviewForRetry,
  updateCheckRunId,
} from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import { shouldPublishCodeReviewToProvider } from '@/lib/code-reviews/manual-config';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { createCheckRun, updateCheckRun } from '@/lib/integrations/platforms/github/adapter';
import { setCommitStatus } from '@/lib/integrations/platforms/gitlab/adapter';
import type { GitLabCredentialActor } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import {
  getValidGitLabProjectAccessToken,
  getValidGitLabToken,
} from '@/lib/integrations/gitlab-service';
import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Failure causes that cost one agent run to retry and nothing to diagnose,
 * because the same request has a real chance of finishing the next time.
 *
 * An allow-list rather than a deny-list: a retry for a cause that needs the
 * customer, a credential, or a settings change produces the same failure and
 * bills a second run. A cause added later stays out of this set until someone
 * decides it is transient.
 */
const AUTOMATIC_RETRY_TERMINAL_REASON_LIST = [
  'timeout',
  'assistant_timeout',
  'assistant_unavailable',
  'assistant_gateway_unavailable',
  'assistant_provider_disconnect',
  'upstream_error',
  'sandbox_error',
  'sandbox_connection',
  'container_shutdown',
  'workspace_capacity',
  'workspace_setup_failed',
  'runtime_startup_failed',
  'wrapper_failed',
  'delivery_failed',
  'session_import_failed',
] as const satisfies readonly CodeReviewTerminalReason[];

/**
 * Note on a user-driven stop: an interrupted session is persisted with status
 * `cancelled`, which this policy never retries, so it needs no entry here.
 */
export const AUTOMATIC_RETRY_TERMINAL_REASONS: ReadonlySet<string> = new Set(
  AUTOMATIC_RETRY_TERMINAL_REASON_LIST
);

/** Attempts a review may carry: its first run plus two unattended retries. */
export const AUTOMATIC_RETRY_ATTEMPT_LIMIT = 3;

/**
 * Whether a sweep may restart this review without a person deciding to.
 *
 * The attempt count is what stops a persistent fault from billing a review run
 * every sweep; the terminal reason is what stops a retry that cannot succeed.
 */
export function isAutomaticallyRetryableReview(
  review: Pick<CloudAgentCodeReview, 'status' | 'terminal_reason'>,
  attemptCount: number
): boolean {
  if (review.status !== 'failed') return false;
  if (attemptCount >= AUTOMATIC_RETRY_ATTEMPT_LIMIT) return false;
  const reason = review.terminal_reason;
  return reason !== null && AUTOMATIC_RETRY_TERMINAL_REASONS.has(reason);
}

export type RetryCodeReviewOutcome =
  /** The review was reset, given a new attempt, and handed to dispatch. */
  | { outcome: 'retried' }
  /** Another caller already reset this review; nothing was dispatched. */
  | { outcome: 'already_in_flight' }
  /** Reset and dispatched, but dispatch marked the new attempt failed. */
  | { outcome: 'still_failed'; errorMessage: string | null };

/**
 * Restarts a review in a retriggable state.
 *
 * The reset is a status compare-and-set: only a review still in a retriggable
 * terminal state matches, so a concurrent restart of the same review answers
 * `already_in_flight` instead of dispatching twice.
 */
export async function retryFailedCodeReview(params: {
  review: CloudAgentCodeReview;
  owner: Owner;
  retryReason: string;
}): Promise<RetryCodeReviewOutcome> {
  const { review, owner, retryReason } = params;

  const currentAttempt = await ensureCurrentCodeReviewAttemptFromReview(review);

  const resetCount = await resetCodeReviewForRetry(review.id);
  if (resetCount === 0) {
    return { outcome: 'already_in_flight' };
  }

  await createCodeReviewAttempt({
    codeReviewId: review.id,
    retryOfAttemptId: currentAttempt.id,
    retryReason,
    status: 'pending',
  });

  try {
    await recreatePRGateCheck(review, actorFromOwner(owner));
  } catch (gateError) {
    // Non-blocking: the review still retries even if the gate check fails, and
    // a missing gate only costs the pull request a stale check.
    logExceptInTest('[retry] Failed to re-create PR gate check:', gateError);
  }

  await tryDispatchPendingReviews(owner);

  // Dispatch owns the retry from here: a worker that refuses the job marks the
  // review failed again. Reporting success would show a retry that never ran.
  const retriedReview = await getCodeReviewById(review.id);
  if (retriedReview?.status === 'failed') {
    return { outcome: 'still_failed', errorMessage: retriedReview.error_message };
  }
  return { outcome: 'retried' };
}

function actorFromOwner(owner: Owner): GitLabCredentialActor {
  return owner.type === 'org'
    ? { userId: owner.userId, organizationId: owner.id }
    : { userId: owner.userId };
}

/**
 * Re-creates the PR gate check (GitHub Check Run / GitLab commit status)
 * after a review has been reset for retry. Without this, `updatePRGateCheck()`
 * would be a no-op for all subsequent status callbacks because `check_run_id`
 * was cleared during reset.
 */
async function recreatePRGateCheck(review: CloudAgentCodeReview, actor: GitLabCredentialActor) {
  const platform = CodeReviewPlatformSchema.parse(review.platform);
  if (!shouldPublishCodeReviewToProvider(review)) return;
  if (platform === PLATFORM.BITBUCKET || !review.platform_integration_id) return;

  const integration = await getIntegrationById(review.platform_integration_id);
  if (!integration) return;

  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  if (platform === PLATFORM.GITHUB && integration.platform_installation_id) {
    const appType = integration.github_app_type ?? 'standard';
    if (appType === 'lite') return;

    const [repoOwner, repoName] = review.repo_full_name.split('/');
    const checkRunId = await createCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.head_sha,
      {
        detailsUrl,
        output: { title: 'Kilo Code Review queued', summary: 'Waiting for a review slot...' },
      },
      appType
    );
    try {
      await updateCheckRunId(review.id, checkRunId);
    } catch (dbError) {
      // Cancel the orphaned check run so it doesn't block merging
      try {
        await updateCheckRun(
          integration.platform_installation_id,
          repoOwner,
          repoName,
          checkRunId,
          { status: 'completed', conclusion: 'cancelled' },
          appType
        );
        logExceptInTest(
          `[retry] Cancelled orphaned check run ${checkRunId} for ${review.repo_full_name}#${review.pr_number}`
        );
      } catch (cancelError) {
        logExceptInTest('[retry] Failed to cancel orphaned check run:', cancelError);
      }
      throw dbError;
    }
    logExceptInTest(
      `[retry] Created check run ${checkRunId} for ${review.repo_full_name}#${review.pr_number}`
    );
    return;
  }

  if (platform === PLATFORM.GITLAB) {
    const accessToken = review.platform_project_id
      ? await getValidGitLabProjectAccessToken(integration, review.platform_project_id, actor)
      : await getValidGitLabToken(integration, actor);
    const metadata = integration.metadata as { gitlab_instance_url?: string } | null;
    const instanceUrl = metadata?.gitlab_instance_url || 'https://gitlab.com';

    await setCommitStatus(
      accessToken,
      review.platform_project_id ?? review.repo_full_name,
      review.head_sha,
      'pending',
      { targetUrl: detailsUrl, description: 'Kilo Code Review queued' },
      instanceUrl
    );
    logExceptInTest(
      `[retry] Set commit status 'pending' on ${review.repo_full_name}!${review.pr_number}`
    );
  }
}
