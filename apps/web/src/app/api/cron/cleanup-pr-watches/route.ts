import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { cleanupWatchPrData, watchPrRetentionDays } from '@/lib/cloud-agent/watch-pr-cleanup';

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_pr_watches',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const result = await cleanupWatchPrData();

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_pr_watch_activity_count: result.deletedActivityCount,
        deleted_pr_watch_count: result.deletedWatchCount,
        retention_days: watchPrRetentionDays,
        cutoff: result.cutoff,
      })
    );

    return NextResponse.json({
      ...result,
      retentionDays: watchPrRetentionDays,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
