import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { cleanupEnvironmentSetupRuns } from '@/lib/cloud-agent/environment-setup/cleanup';

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_environment_setup_runs',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const result = await cleanupEnvironmentSetupRuns();

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        abandoned_count: result.abandoned,
        drafts_deleted_count: result.draftsDeleted,
        previous_configurations_cleared_count: result.previousConfigurationsCleared,
      })
    );

    return NextResponse.json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
