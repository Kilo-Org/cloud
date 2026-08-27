import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@/lib/config.server';
import { syncEnkryptBenchmarks } from '@/lib/model-stats/sync-enkrypt';

export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.sync_enkrypt',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const { fetchedCount, matchedCount, unmatchedCount, ambiguousCount, updatedCount } =
      await syncEnkryptBenchmarks();

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        fetched_count: fetchedCount,
        matched_count: matchedCount,
        unmatched_count: unmatchedCount,
        ambiguous_count: ambiguousCount,
        updated_count: updatedCount,
      })
    );

    return NextResponse.json({
      success: true,
      fetchedCount,
      matchedCount,
      unmatchedCount,
      ambiguousCount,
      updatedCount,
    });
  } catch {
    const error = new Error('Failed to sync Enkrypt benchmarks');
    captureException(error, {
      tags: { endpoint: 'cron/sync-enkrypt' },
    });
    emitScheduledJobEvent(
      buildScheduledJobFailureEvent({
        context: run,
        jobName: run.jobName,
        environment: run.environment,
        error,
        metadata: { sync_failure_count: 1 },
      })
    );

    return NextResponse.json(
      { success: false, error: 'Failed to sync Enkrypt benchmarks' },
      { status: 500 }
    );
  }
}
