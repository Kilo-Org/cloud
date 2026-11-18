/**
 * Restarting a code review that stopped on a failure.
 *
 * The manual retrigger and the missed-review sweep run this one sequence, so a
 * review restarted without a person cannot diverge from one restarted by hand:
 * a status compare-and-set reset, a new attempt row, a fresh pull request gate
 * check, then the dispatch that owns the retry from there.
 */

import { isLocalCodeReviewDevelopmentEnabled } from '@kilocode/web-shared/lib/config.server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { CloudAgentCodeReview } from '@kilocode/db/schema';
import type { CodeReviewTerminalReason } from '@kilocode/db/schema-types';
import { CODE_REVIEW_TERMINAL_REASONS } from '@kilocode/db/schema-types';
import { getAgentConfigForOwner, type AgentConfigRow } from '@/lib/agent-config/db/agent-configs';
import {
  getCodeReviewActionRequiredCopy,
  getCodeReviewActionRequiredState,
} from '@/lib/code-reviews/action-required';
import { isCodeReviewActionRequiredReason } from '@/lib/code-reviews/action-required-shared';
import type { Owner } from '@/lib/code-reviews/core';
import { CodeReviewPlatformSchema } from '@/lib/code-reviews/core/schemas';
import { getCodeReviewTerminalReasonCopy } from '@/lib/code-reviews/terminal-reason-copy';
import {
  createCodeReviewAttempt,
  ensureCurrentCodeReviewAttemptFromReview,
  getCodeReviewById,
  resetCodeReviewForRetry,
  updateCheckRunId,
} from '@/lib/code-reviews/db/code-reviews';
import { tryDispatchPendingReviews } from '@/lib/code-reviews/dispatch/dispatch-pending-reviews';
import {
  getManualCodeReviewConfig,
  shouldPublishCodeReviewToProvider,
} from '@/lib/code-reviews/manual-config';
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
 * Failure causes known to need a person before a retry can succeed: a retry
 * for one of these produces the same failure, so it is withheld from every
 * unattended caller and the next restart is left to them.
 *
 * This is a deny-list rather than the allow-list it replaced: a failed review
 * whose cause is unclassified, or which this list does not name, restarts
 * under the attempt cap. A cause that fails the same way is stopped by the cap
 * after its second run, while an unclassified transient failure gets the new
 * attempt an unmanaged list used to deny it — so a cause nobody has decided
 * on yet no longer strands its pull request until someone enumerates it here.
 *
 * The transient causes the allow-list curated stay retryable exactly as
 * before, by simply not being listed here.
 */
const RETRY_BLOCKING_TERMINAL_REASON_LIST = [
  // The customer's account, billing, or chosen model.
  'billing',
  'account_blocked',
  'model_not_found',
  'selected_model_unavailable',
  'byok_invalid_key',
  // Rate limits that a customer's own key or quota owns: the same request
  // fails the same way until the customer raises the quota. The managed and
  // unattributed values stay out too; the sweep reads no attempt rows for
  // them, and the attempt cap is not a reason to spend runs on a fault that
  // cannot clear between sweeps by itself.
  'assistant_rate_limited',
  'assistant_rate_limited_byok',
  'assistant_rate_limited_managed',
  // Platform access the customer must grant or lift.
  'github_installation_required',
  'github_ip_allow_list',
  'gitlab_project_access_required',
  // The repository's own credentials, sparse checkout, or setup script.
  'repository_auth_failed',
  'repository_checkout_failed',
  'repeated_repository_clone_timeout',
  'setup_command_failed',
  // The request itself, or a guardrail: the next run repeats it, or a person
  // must change what is asked.
  'assistant_invalid_request',
  'assistant_invalid_request_byok',
  'assistant_context_limit',
  'assistant_output_limit',
  'assistant_content_filter',
  'assistant_structured_output',
  'assistant_no_reply',
  // The generic derived failure: without a recognized code there is nothing
  // that says the next run differs from the last one.
  'assistant_failed',
  // Ends nobody restarts: a person's stop, a newer push, an interrupted
  // session (also persisted with status `cancelled`, which this policy never
  // retries anyway), and the stale-sweep cleanup.
  'user_cancelled',
  'superseded',
  'interrupted',
  'abandoned',
] as const satisfies readonly CodeReviewTerminalReason[];

/**
 * Failed reviews carrying one of these reasons are never restarted unattended;
 * every other reason is, under `AUTOMATIC_RETRY_ATTEMPT_LIMIT`.
 */
export const NON_RETRYABLE_TERMINAL_REASONS: ReadonlySet<string> = new Set(
  RETRY_BLOCKING_TERMINAL_REASON_LIST
);

/** Attempts a review may carry: its first run plus two unattended retries. */
export const AUTOMATIC_RETRY_ATTEMPT_LIMIT = 3;

/** Every terminal reason the database schema can persist. */
const KNOWN_TERMINAL_REASON_SET: ReadonlySet<string> = new Set(CODE_REVIEW_TERMINAL_REASONS);

/**
 * Whether a failed review's cause is still unclassified, so a restart is the
 * cheapest diagnosis anyone can run on it.
 *
 * The stored column answers null for review rows that failed before any reason
 * was derived and 'unknown' for payloads whose cause nobody recognised. Both
 * name the same fact for this policy: the failure's cause is not one of the
 * documented needs-a-person causes, so it is as good a candidate for one retry
 * under the cap as any known transient cause. Also true for a value that is
 * neither null, 'unknown', nor a documented reason, because a reason this
 * module has not seen is as likely to be transient as not.
 */
export function isUnknownFailureCause(reason: CloudAgentCodeReview['terminal_reason']): boolean {
  return reason === null || reason === 'unknown' || !KNOWN_TERMINAL_REASON_SET.has(reason);
}

/**
 * Whether the failure itself can be retried, before the attempt count is read.
 *
 * The policy is a deny-list of terminal reasons (`NON_RETRYABLE_TERMINAL_REASONS`)
 * rather than an allow-list: a documented cause that needs the customer, a
 * credential, or a settings change stays out, and a failure whose cause is
 * unknown (`isUnknownFailureCause`) stays in, under the attempt cap. A caller
 * that has the row can answer this without another query, so the sweep pays for
 * the attempt rows only for a review it can restart.
 */
export function isAutomaticallyRetryableFailure(
  review: Pick<CloudAgentCodeReview, 'status' | 'terminal_reason'>
): boolean {
  if (review.status !== 'failed') return false;
  if (isUnknownFailureCause(review.terminal_reason)) return true;
  return !NON_RETRYABLE_TERMINAL_REASONS.has(review.terminal_reason ?? '');
}

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
  return isAutomaticallyRetryableFailure(review) && attemptCount < AUTOMATIC_RETRY_ATTEMPT_LIMIT;
}

export type RetryCodeReviewOutcome =
  /** The review was reset, given a new attempt, and handed to dispatch. */
  | { outcome: 'retried' }
  /** Another caller already reset this review; nothing was dispatched. */
  | { outcome: 'already_in_flight' }
  /** Reset and dispatched, but dispatch marked the new attempt failed. */
  | { outcome: 'still_failed'; errorMessage: string | null }
  /** The reviewer configuration cannot run this review, so nothing was reset. */
  | { outcome: 'refused'; reason: CodeReviewRetryRefusalReason };

export type CodeReviewRetryRefusalReason =
  /** The Code Reviewer configuration needs attention before it can run. */
  | 'action_required'
  /** The owner switched Code Reviewer off. */
  | 'reviewer_disabled'
  /** A manual Code Reviewer job runs only in local development. */
  | 'local_development_only';

/** The stored reviewer configuration row, as this module reads it. */
export type ReviewerConfigRow = AgentConfigRow | null;

/**
 * Whether the Code Reviewer configuration allows this review to run at all.
 *
 * A restart spends an agent run and closes the pull request gate, so a review
 * whose reviewer the owner switched off, or whose configuration needs
 * attention, must not start. Both callers ask here, so a person and an
 * unattended sweep get the same answer for the same review.
 *
 * A caller that has already read the row for its own gate passes it, so one
 * restart reads the configuration once.
 */
async function getRetryRefusal(
  review: CloudAgentCodeReview,
  owner: Owner,
  knownAgentConfig?: ReviewerConfigRow
): Promise<CodeReviewRetryRefusalReason | null> {
  const manualConfig = getManualCodeReviewConfig(review);
  if (manualConfig?.outputMode === 'kilo' && !isLocalCodeReviewDevelopmentEnabled()) {
    return 'local_development_only';
  }
  if (manualConfig) return null;

  const agentConfig =
    knownAgentConfig === undefined
      ? await getAgentConfigForOwner(
          owner,
          'code_review',
          CodeReviewPlatformSchema.parse(review.platform)
        )
      : knownAgentConfig;
  if (getCodeReviewActionRequiredState(agentConfig)) return 'action_required';
  if (!agentConfig?.is_enabled) return 'reviewer_disabled';
  return null;
}

/**
 * Restarts a review in a retriggable state.
 *
 * The reset is a status compare-and-set: only a review still in a retriggable
 * terminal state matches, so a concurrent restart of the same review answers
 * `already_in_flight` instead of dispatching twice.
 *
 * A caller that already read the reviewer configuration for its own gate passes
 * it as `agentConfig`, so one restart reads the configuration once.
 */
export async function retryFailedCodeReview(params: {
  review: CloudAgentCodeReview;
  owner: Owner;
  retryReason: string;
  agentConfig?: ReviewerConfigRow;
}): Promise<RetryCodeReviewOutcome> {
  const { review, owner, retryReason, agentConfig } = params;

  const refusal = await getRetryRefusal(review, owner, agentConfig);
  if (refusal !== null) {
    return { outcome: 'refused', reason: refusal };
  }

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

  const actor = actorFromOwner(owner);

  try {
    await recreatePRGateCheck(review, actor);
  } catch (gateError) {
    // Non-blocking: the review still retries even if the gate check fails, and
    // a missing gate only costs the pull request a stale check.
    logExceptInTest('[retry] Failed to re-create PR gate check:', gateError);
  }

  await tryDispatchPendingReviews(owner);

  // Dispatch owns the retry from here: a worker that refuses the job marks the
  // review failed again. Reporting success would show a retry that never ran.
  const retriedReview = await getCodeReviewById(review.id);
  if (retriedReview?.status === 'failed' || retriedReview?.status === 'cancelled') {
    try {
      await finalizeRetryGateCheck(retriedReview, actor);
    } catch (gateError) {
      // Non-blocking: the stored failure is the answer the caller needs, and
      // the sweep reaches this review again on its next pass.
      logExceptInTest('[retry] Failed to close the re-created PR gate check:', gateError);
    }
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
 * Closes the PR gate check re-created for a retry that then did not start.
 *
 * Without this the pull request keeps a queued check that no worker will ever
 * finish, so the merge gate stays blocked on a review that already stopped. A
 * billing refusal closes the gate on its own path for either platform, and an
 * action-required cause closes it there for a provider review on GitHub, so
 * those cases are already settled; every other case is closed here with the
 * conclusion the status callback gives the same review state.
 */
async function finalizeRetryGateCheck(
  review: CloudAgentCodeReview,
  actor: GitLabCredentialActor
): Promise<void> {
  if (review.terminal_reason === 'billing') return;
  if (!shouldPublishCodeReviewToProvider(review)) return;
  if (!review.platform_integration_id) return;

  const platform = CodeReviewPlatformSchema.parse(review.platform);
  if (platform === PLATFORM.BITBUCKET) return;

  const actionRequiredReason = isCodeReviewActionRequiredReason(review.terminal_reason)
    ? review.terminal_reason
    : null;
  if (
    actionRequiredReason &&
    platform === PLATFORM.GITHUB &&
    getManualCodeReviewConfig(review) === null
  ) {
    return;
  }

  const integration = await getIntegrationById(review.platform_integration_id);
  if (!integration) return;

  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;
  const cancelled = review.status === 'cancelled';
  const terminalCopy = getCodeReviewTerminalReasonCopy(review.terminal_reason);
  const actionCopy = actionRequiredReason
    ? getCodeReviewActionRequiredCopy(actionRequiredReason)
    : null;
  const title = actionCopy
    ? actionCopy.checkTitle
    : cancelled
      ? 'Kilo Code Review cancelled'
      : (terminalCopy?.checkTitle ?? 'Kilo Code Review failed');
  const summary = actionCopy
    ? actionCopy.checkSummary
    : cancelled
      ? 'Review was cancelled.'
      : (terminalCopy?.checkSummary ?? 'Review failed.');

  if (platform === PLATFORM.GITHUB && integration.platform_installation_id) {
    const appType = integration.github_app_type ?? 'standard';
    if (appType === 'lite') return;
    if (!review.check_run_id) return;

    const [repoOwner, repoName] = review.repo_full_name.split('/');
    await updateCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.check_run_id,
      {
        status: 'completed',
        conclusion: actionCopy ? 'action_required' : cancelled ? 'cancelled' : 'failure',
        detailsUrl,
        output: { title, summary },
      },
      appType
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
      cancelled ? 'canceled' : 'failed',
      { targetUrl: detailsUrl, description: summary },
      instanceUrl
    );
  }
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
