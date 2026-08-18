import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@/lib/config.server';
import { alertIfSyncProvidersStale } from '@/lib/ai-gateway/providers/openrouter/sync-providers-stale-alert';
import { syncAndStoreProviders } from '@/lib/ai-gateway/providers/openrouter/sync-providers';

// The cron job runs every 5 minutes, so if increasing the timeout beyond 4 minutes
// becomes necessary, the cron schedule in vercel.json should probably be adjusted as well.
export const maxDuration = 240;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.sync_providers',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    await alertIfSyncProvidersStale();
  } catch (error) {
    console.error('[sync-providers] stale full-sync alert escaped', error);
  }

  try {
    const summary = await syncAndStoreProviders();
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        total_provider_count: summary.total_providers,
        total_model_count: summary.total_models,
      })
    );

    return NextResponse.json(summary);
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
