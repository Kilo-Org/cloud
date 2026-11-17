import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
  type ScheduledJobMetadata,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { runScheduledBackfills } from '@/lib/backfills/scheduled';

export const maxDuration = 300;

/** Leaves the rest of `maxDuration` for the backfill already in flight and the response. */
const WORK_BUDGET_MS = 180_000;

export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const run = createScheduledJobRun({
    jobName: 'web.backfill_users',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  const outcomes = await runScheduledBackfills({ deadlineAt: Date.now() + WORK_BUDGET_MS });
  const metadata: ScheduledJobMetadata = {};
  const failed: string[] = [];
  const skipped: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'failed') {
      failed.push(outcome.name);
    } else if (outcome.status === 'skipped') {
      skipped.push(outcome.name);
    } else {
      metadata[`${outcome.name}_processed_count`] = outcome.processed;
      metadata[`${outcome.name}_remaining`] = outcome.remaining;
    }
  }
  metadata.failed_count = failed.length;
  metadata.skipped_count = skipped.length;
  if (skipped.length > 0) metadata.skipped_backfills = skipped.join(',');

  if (failed.length > 0) {
    metadata.failed_backfills = failed.join(',');
    emitScheduledJobEvent(
      buildScheduledJobFailureEvent({
        context: run,
        jobName: run.jobName,
        environment: run.environment,
        metadata,
        error: new Error('One or more backfills failed'),
      })
    );
    return NextResponse.json({ backfills: outcomes }, { status: 500 });
  }

  emitScheduledJobEvent(buildScheduledJobSuccessEvent(run, metadata));
  return NextResponse.json({ backfills: outcomes });
}
