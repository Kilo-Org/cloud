import {
  cloud_agent_code_review_attempts,
  cloud_agent_code_reviews,
  type CloudAgentCodeReview,
} from '@kilocode/db/schema';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

import { db } from '@/lib/drizzle';
import { APP_URL } from '@/lib/constants';
import { CodeReviewPlatformSchema } from '@/lib/code-reviews/core/schemas';
import { NON_TERMINAL_CODE_REVIEW_STATUSES } from '@/lib/code-reviews/dispatch/dispatch-constants';
import { shouldPublishCodeReviewToProvider } from '@/lib/code-reviews/manual-config';
import {
  getGitLabInstanceUrl,
  resolveGitLabAccessToken,
} from '@/lib/code-reviews/platform/gitlab-access';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { updateCheckRun } from '@/lib/integrations/platforms/github/adapter';
import { setCommitStatus } from '@/lib/integrations/platforms/gitlab/adapter';
import { logExceptInTest } from '@/lib/utils.server';

/**
 * How long a review may sit in a non-terminal state before the reaper closes it.
 *
 * Far past anything legitimate: capacity waits resolve in minutes to hours, and
 * the cron drain already stops reconsidering pending work after 75 minutes.
 */
export const REAP_STALE_REVIEW_HOURS = 48;

/**
 * Upper bound on rows closed per invocation.
 *
 * Needed for two independent reasons. Each reaped review can cost a platform
 * API call against a per-installation rate limit. And the alerting detector
 * measures failure rate in a 30 minute window keyed on completion time, so an
 * uncapped first drain would register thousands of failures at once and read
 * as an incident.
 */
export const REAP_DEFAULT_BATCH_SIZE = 25;

const REAP_TERMINAL_REASON = 'abandoned';
const REAP_ERROR_MESSAGE = 'Stopped by Kilo after the review never reached a terminal state';
const REAP_CHECK_TITLE = 'Kilo Code Review stopped';
const REAP_CHECK_SUMMARY = 'This review did not finish and was closed by Kilo.';

export type ReapStaleReviewsSummary = {
  selected: number;
  terminalized: number;
  checksClosed: number;
  providerFailures: number;
  /**
   * Stale rows still waiting after this run. A saturated batch alone cannot
   * distinguish a backlog of dozens from one of thousands; this is the number
   * to watch while the initial drain runs (visible in the Completed log line
   * and the cron response).
   */
  remaining: number;
};

/**
 * Reviews whose last sign of life is older than the reap threshold.
 *
 * The COALESCE mirrors the one the dispatcher uses for staleness, so a row that
 * was updated recently is not reaped purely because it was created long ago.
 *
 * Oldest first: with no notification attached to a reap, there is no freshness
 * window to protect, and the rows that have been spinning a provider-side check
 * the longest are the most useful ones to close first.
 */
function staleReviewCondition() {
  return and(
    inArray(cloud_agent_code_reviews.status, [...NON_TERMINAL_CODE_REVIEW_STATUSES]),
    sql`COALESCE(
      ${cloud_agent_code_reviews.started_at},
      ${cloud_agent_code_reviews.updated_at},
      ${cloud_agent_code_reviews.created_at}
    ) < now() - interval '${sql.raw(String(REAP_STALE_REVIEW_HOURS))} hours'`
  );
}

function selectStaleReviews(limit: number) {
  return db
    .select()
    .from(cloud_agent_code_reviews)
    .where(staleReviewCondition())
    .orderBy(asc(cloud_agent_code_reviews.created_at))
    .limit(limit);
}

/** Shares the selection predicate so the depth count cannot drift from it. */
async function countRemainingStaleReviews(): Promise<number> {
  const [row] = await db
    .select({ remaining: count() })
    .from(cloud_agent_code_reviews)
    .where(staleReviewCondition());
  return Number(row?.remaining) || 0;
}

/**
 * Claim a review terminally, but only if nothing has touched it since selection.
 *
 * The whole batch is selected up front and then walked with provider calls in
 * between, so minutes can pass before a given row is claimed. A status check on
 * its own is not enough: the inline dispatch path has no age bound, so an owner
 * becoming active mid-batch can legitimately re-dispatch one of these very rows,
 * and the reaper would then kill a live review and null the reservation the real
 * callback depends on.
 *
 * Matching on the snapshot's `updated_at` makes the claim an optimistic lock:
 * every write to this table refreshes that column, so any intervening dispatch,
 * callback, or supersede invalidates the claim and the row is skipped this run.
 *
 * On a successful claim the review's own non-terminal attempts are closed with
 * it, the same way the supersede path closes both tables together. Left open,
 * they would count as in-progress work forever in every attempt-level query.
 */
async function terminalizeReview(review: CloudAgentCodeReview): Promise<boolean> {
  const now = new Date().toISOString();
  const claimed = await db
    .update(cloud_agent_code_reviews)
    .set({
      status: 'failed',
      terminal_reason: REAP_TERMINAL_REASON,
      error_message: REAP_ERROR_MESSAGE,
      dispatch_reservation_id: null,
      completed_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(cloud_agent_code_reviews.id, review.id),
        inArray(cloud_agent_code_reviews.status, [...NON_TERMINAL_CODE_REVIEW_STATUSES]),
        eq(cloud_agent_code_reviews.updated_at, review.updated_at)
      )
    )
    .returning({ id: cloud_agent_code_reviews.id });

  if (claimed.length === 0) return false;

  await db
    .update(cloud_agent_code_review_attempts)
    .set({
      status: 'failed',
      terminal_reason: REAP_TERMINAL_REASON,
      error_message: REAP_ERROR_MESSAGE,
      completed_at: now,
      updated_at: now,
    })
    .where(
      and(
        eq(cloud_agent_code_review_attempts.code_review_id, review.id),
        inArray(cloud_agent_code_review_attempts.status, [...NON_TERMINAL_CODE_REVIEW_STATUSES])
      )
    );

  return true;
}

/**
 * Close the provider-side gate so the pull request stops showing a check that
 * will never finish. Runs regardless of whether the pull request is still open:
 * a spinning check on a closed pull request is still wrong.
 */
async function closeProviderGate(review: CloudAgentCodeReview): Promise<boolean> {
  // A manual review configured as dashboard-only never published anything to the
  // pull request, so there is nothing to close and nothing may be created now.
  // Every other provider-publish site gates on this; the reaper is no exception.
  if (!shouldPublishCodeReviewToProvider(review)) return false;

  const platform = CodeReviewPlatformSchema.parse(review.platform);
  if (platform === PLATFORM.BITBUCKET) return false;

  if (!review.platform_integration_id) return false;
  const integration = await getIntegrationById(review.platform_integration_id);
  if (!integration) return false;

  const detailsUrl = `${APP_URL}/code-reviews/${review.id}`;

  if (platform === PLATFORM.GITHUB) {
    if (!review.check_run_id || !integration.platform_installation_id) return false;
    const [repoOwner, repoName] = review.repo_full_name.split('/');
    await updateCheckRun(
      integration.platform_installation_id,
      repoOwner,
      repoName,
      review.check_run_id,
      {
        status: 'completed',
        conclusion: 'timed_out',
        detailsUrl,
        output: { title: REAP_CHECK_TITLE, summary: REAP_CHECK_SUMMARY },
      },
      integration.github_app_type ?? 'standard'
    );
    return true;
  }

  const accessToken = await resolveGitLabAccessToken(integration, review.platform_project_id);
  await setCommitStatus(
    accessToken,
    review.platform_project_id ?? review.repo_full_name,
    review.head_sha,
    'canceled',
    { targetUrl: detailsUrl, description: REAP_CHECK_SUMMARY },
    getGitLabInstanceUrl(integration)
  );
  return true;
}

/**
 * Close out reviews that have sat in a non-terminal state past the threshold.
 *
 * Deliberately janitorial: it does not diagnose why a review stranded, only
 * that nothing is going to finish it. All provider work runs inside a per-row
 * catch, so one unreachable installation, malformed legacy row, or suspended
 * integration cannot stall the rest of the batch. Those failures are expected
 * for part of the backlog and are counted rather than retried; the row is
 * already terminal by then either way.
 */
export async function reapStaleCodeReviews(
  batchSize: number = REAP_DEFAULT_BATCH_SIZE
): Promise<ReapStaleReviewsSummary> {
  const stale = await selectStaleReviews(batchSize);
  const summary: ReapStaleReviewsSummary = {
    selected: stale.length,
    terminalized: 0,
    checksClosed: 0,
    providerFailures: 0,
    remaining: 0,
  };

  for (const review of stale) {
    // Claim first. Everything after this is best-effort cleanup, and a provider
    // call that fails must not leave the row selectable forever.
    if (!(await terminalizeReview(review))) continue;
    summary.terminalized += 1;

    try {
      if (await closeProviderGate(review)) summary.checksClosed += 1;
    } catch (error) {
      summary.providerFailures += 1;
      logExceptInTest('[reap-stale-reviews] Failed to close provider gate', {
        reviewId: review.id,
        repo: review.repo_full_name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  summary.remaining = await countRemainingStaleReviews();

  if (summary.providerFailures > 0) {
    captureException(new Error('Stale code review reap completed with provider failures'), {
      level: 'info',
      tags: { operation: 'reap-stale-code-reviews' },
      extra: { ...summary },
    });
  }

  logExceptInTest('[reap-stale-reviews] Completed', summary);
  return summary;
}
