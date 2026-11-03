import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { alertIfSyncStale } from '@/lib/providers/openrouter/sync-providers-stale-alert';
import { syncAndStoreDirectByokProviders } from '@/lib/providers/direct-byok/sync-direct-byok';

// The cron job runs every 5 minutes; keep this below the schedule interval in vercel.json.
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.sync_direct_byok_providers',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    await alertIfSyncStale('direct_byok');
  } catch (error) {
    console.error('[sync-direct-byok-providers] stale sync alert escaped', error);
  }

  try {
    const summary = await syncAndStoreDirectByokProviders();
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
