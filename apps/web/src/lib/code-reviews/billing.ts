/**
 * Customer-facing billing failure handling for Code Reviewer.
 *
 * One source of truth for the copy and the provider side effects of a review
 * that cannot run because its paying account has insufficient credits. The
 * code-review status callback and the dispatch admission gate both use it, so a
 * review refused before dispatch and one refused by the worker report the same
 * outcome.
 */

import { captureException } from '@sentry/nextjs';
import type { CloudAgentCodeReview, PlatformIntegration } from '@kilocode/db/schema';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import {
  createPRComment,
  hasPRCommentWithMarker,
  updateCheckRun,
} from '@/lib/integrations/platforms/github/adapter';
import {
  createMRNote,
  hasMRNoteWithMarker,
  setCommitStatus,
} from '@/lib/integrations/platforms/gitlab/adapter';
import { getGitLabInstanceUrl, resolveGitLabAccessToken } from './platform/gitlab-access';

/** Identifies the billing notice comment Kilo posts on a pull request. */
export const CODE_REVIEW_BILLING_NOTICE_MARKER = '<!-- kilo-billing-notice -->';

/** User-facing reason stored on the review and shown in the app. */
export const CODE_REVIEW_BILLING_FAILURE_MESSAGE =
  'Kilo Code Review could not run because the account has insufficient credits. ' +
  'Add credits or choose a model that costs nothing, then re-run the review.';

/** GitHub check run title for a review refused for insufficient credits. */
export const CODE_REVIEW_BILLING_CHECK_TITLE = 'Insufficient credits to run review';

/** GitHub check run summary and GitLab commit status description. */
export const CODE_REVIEW_BILLING_CHECK_SUMMARY =
  'Review could not start because the account has insufficient credits.';

const CODE_REVIEW_BILLING_NOTICE_BODY = `${CODE_REVIEW_BILLING_NOTICE_MARKER}
**Kilo Code Review could not run — your account is out of credits.**

[Add credits](https://app.kilo.ai/) or [switch to a free model](https://app.kilo.ai/code-reviews) to enable reviews on this change.`;

type BillingNoticeReview = Pick<
  CloudAgentCodeReview,
  'platform' | 'repo_full_name' | 'pr_number' | 'platform_project_id'
>;

/**
 * Post the billing notice on the pull request or merge request, unless an
 * earlier attempt already left one. Returns whether a comment was created.
 */
export async function postCodeReviewBillingNotice(
  review: BillingNoticeReview,
  integration: PlatformIntegration,
  options: { gitlabAccessToken?: string } = {}
): Promise<boolean> {
  if (review.platform === PLATFORM.GITHUB) {
    if (!integration.platform_installation_id) return false;
    const [repoOwner, repoName] = review.repo_full_name.split('/');
    const appType = integration.github_app_type ?? 'standard';
    const alreadyPosted = await hasPRCommentWithMarker(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.pr_number,
      CODE_REVIEW_BILLING_NOTICE_MARKER,
      appType
    );
    if (alreadyPosted) return false;

    await createPRComment(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.pr_number,
      CODE_REVIEW_BILLING_NOTICE_BODY,
      appType
    );
    logExceptInTest(
      `[code-review-billing] Posted billing notice on ${review.repo_full_name}#${review.pr_number}`
    );
    return true;
  }

  if (review.platform === PLATFORM.GITLAB) {
    const instanceUrl = getGitLabInstanceUrl(integration);
    const accessToken =
      options.gitlabAccessToken ??
      (await resolveGitLabAccessToken(integration, review.platform_project_id));
    const alreadyPosted = await hasMRNoteWithMarker(
      accessToken,
      review.repo_full_name,
      review.pr_number,
      CODE_REVIEW_BILLING_NOTICE_MARKER,
      instanceUrl
    );
    if (alreadyPosted) return false;

    await createMRNote(
      accessToken,
      review.repo_full_name,
      review.pr_number,
      CODE_REVIEW_BILLING_NOTICE_BODY,
      instanceUrl
    );
    logExceptInTest(
      `[code-review-billing] Posted billing notice on GitLab MR ${review.repo_full_name}!${review.pr_number}`
    );
    return true;
  }

  return false;
}

async function closeProviderGate(
  review: CloudAgentCodeReview,
  integration: PlatformIntegration
): Promise<void> {
  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  if (review.platform === PLATFORM.GITHUB) {
    if (!review.check_run_id || !integration.platform_installation_id) return;
    const [repoOwner, repoName] = review.repo_full_name.split('/');
    await updateCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.check_run_id,
      {
        status: 'completed',
        conclusion: 'action_required',
        detailsUrl,
        output: {
          title: CODE_REVIEW_BILLING_CHECK_TITLE,
          summary: CODE_REVIEW_BILLING_CHECK_SUMMARY,
        },
      },
      integration.github_app_type ?? 'standard'
    );
    return;
  }

  if (review.platform === PLATFORM.GITLAB) {
    const accessToken = await resolveGitLabAccessToken(integration, review.platform_project_id);
    await setCommitStatus(
      accessToken,
      review.platform_project_id ?? review.repo_full_name,
      review.head_sha,
      'failed',
      { targetUrl: detailsUrl, description: CODE_REVIEW_BILLING_CHECK_TITLE },
      getGitLabInstanceUrl(integration)
    );
  }
}

/**
 * Record a billing failure on the provider without throwing: close the gate
 * (GitHub check / GitLab commit status) and post the notice. Provider failures
 * are logged and captured so a review that is already terminal still reports
 * cleanly.
 */
export async function finalizeCodeReviewBillingFailure(
  review: CloudAgentCodeReview
): Promise<void> {
  if (!review.platform_integration_id) return;

  let integration: PlatformIntegration | null = null;
  try {
    integration = await getIntegrationById(review.platform_integration_id);
  } catch (error) {
    errorExceptInTest('[code-review-billing] Failed to load integration', {
      reviewId: review.id,
      error,
    });
  }
  if (!integration) return;

  try {
    await closeProviderGate(review, integration);
  } catch (error) {
    errorExceptInTest('[code-review-billing] Failed to close provider gate', {
      reviewId: review.id,
      error,
    });
    captureException(error, {
      tags: { operation: 'code-review-billing-close-provider-gate' },
      extra: { reviewId: review.id },
    });
  }

  try {
    await postCodeReviewBillingNotice(review, integration);
  } catch (error) {
    errorExceptInTest('[code-review-billing] Failed to post billing notice', {
      reviewId: review.id,
      error,
    });
    captureException(error, {
      tags: { operation: 'code-review-billing-post-notice' },
      extra: { reviewId: review.id },
    });
  }
}
