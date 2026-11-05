import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { backfillByokEnvelopes } from '@/lib/byok/backfill-envelopes';

export const maxDuration = 300;

/** Leaves the rest of `maxDuration` for the rows already in flight and the response. */
const WORK_BUDGET_MS = 240_000;

/**
 * Creates the KMS envelope of existing BYOK rows, a batch per tick, until none lacks one. Every
 * tick logs `remaining_count`, the rows still without an envelope; `drained: true` with
 * `remaining_count: 0` and `enabled: true` is the signal that the legacy column is no longer
 * needed for reads. Once drained a tick is two cheap queries, so the schedule can stay in place
 * until the job is removed.
 */
export async function GET(request: Request) {
  if (
    !CRON_SECRET ||
    !isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.backfill_byok_envelopes',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const summary = await backfillByokEnvelopes({ deadlineAt: Date.now() + WORK_BUDGET_MS });
    const metadata = {
      enabled: summary.enabled,
      scanned_count: summary.scanned,
      migrated_count: summary.migrated,
      skipped_concurrent_write_count: summary.skippedConcurrentWrite,
      failed_count: summary.failed,
      remaining_count: summary.remaining,
      drained: summary.drained,
    };

    // A row that cannot be migrated needs attention, so the tick is reported failed and the
    // scheduler marks it red; the rest of the batch is still migrated.
    if (summary.failed > 0) {
      emitScheduledJobEvent(
        buildScheduledJobFailureEvent({
          context: run,
          jobName: run.jobName,
          environment: run.environment,
          metadata,
          error: new Error('BYOK envelope backfill failed for some rows'),
        })
      );
      return NextResponse.json(summary, { status: 500 });
    }

    emitScheduledJobEvent(buildScheduledJobSuccessEvent(run, metadata));
    return NextResponse.json(summary);
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
