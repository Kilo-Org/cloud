import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  recoverMissedReviews,
  RECOVER_MISSED_REVIEWS_LOOKBACK_HOURS,
  RECOVER_MISSED_REVIEWS_PR_LIMIT,
  RECOVER_MISSED_REVIEWS_REPO_LIMIT,
  RECOVER_MISSED_REVIEWS_START_LIMIT,
} from '@/lib/code-reviews/recover-missed-reviews';

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.recover_missed_reviews',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const summary = await recoverMissedReviews();

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        repositories_considered: summary.repositoriesConsidered,
        unavailable_integrations: summary.integrationsUnavailable,
        pull_requests_considered: summary.pullRequestsConsidered,
        reviews_started: summary.reviewsStarted,
        skipped_existing: summary.skippedExisting,
        skipped_active_review: summary.skippedActiveReview,
        unaddressable_repositories: summary.unaddressableRepositories,
        skipped_stale: summary.skippedStale,
        skipped_draft: summary.skippedDraft,
        skipped_without_owner: summary.skippedWithoutOwner,
        skipped_start_limit: summary.skippedStartLimit,
        refused_by_handler: summary.refusedByHandler,
        provider_failures: summary.providerFailures,
      })
    );

    return NextResponse.json({
      ...summary,
      repositorySlice: RECOVER_MISSED_REVIEWS_REPO_LIMIT,
      pullRequestLimit: RECOVER_MISSED_REVIEWS_PR_LIMIT,
      ageLimitHours: RECOVER_MISSED_REVIEWS_LOOKBACK_HOURS,
      startLimit: RECOVER_MISSED_REVIEWS_START_LIMIT,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
