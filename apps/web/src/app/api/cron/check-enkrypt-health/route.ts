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
import { getEnkryptSyncHealth } from '@/lib/model-stats/enkrypt-status';
import type { EnkryptSyncHealth } from '@/lib/model-stats/enkrypt-status';

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  }

  const run = createScheduledJobRun({
    jobName: 'web.check_enkrypt_health',
    environment: process.env.VERCEL_TARGET_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });
  let health: EnkryptSyncHealth;
  try {
    health = await getEnkryptSyncHealth();
  } catch {
    captureException(new Error('Enkrypt health check operation failed'), {
      tags: { endpoint: 'cron/check-enkrypt-health', category: 'unexpected' },
    });
    health = {
      status: 'unavailable',
      reason: 'monitor_error',
      lastAttemptAt: null,
      lastSuccessAt: null,
      counts: null,
      lastSuccessCounts: null,
      baselineMatchedCount: null,
    };
  }

  const healthy = health.status === 'healthy' || health.status === 'disabled';
  const metadata = {
    status: health.status,
    reason: health.reason ?? undefined,
    skipped: health.status === 'disabled',
    last_attempt_at: health.lastAttemptAt ?? undefined,
    last_success_at: health.lastSuccessAt ?? undefined,
    baseline_matched_count: health.baselineMatchedCount ?? undefined,
    fetched_count: health.counts?.fetchedCount,
    rejected_count: health.counts?.rejectedCount,
    matched_count: health.counts?.matchedCount,
    unmatched_count: health.counts?.unmatchedCount,
    ambiguous_count: health.counts?.ambiguousCount,
    updated_count: health.counts?.updatedCount,
  };
  emitScheduledJobEvent(
    healthy
      ? buildScheduledJobSuccessEvent(run, metadata)
      : buildScheduledJobFailureEvent({
          context: run,
          jobName: run.jobName,
          environment: run.environment,
          error: new Error('Enkrypt synchronization is unhealthy'),
          metadata,
        })
  );
  return NextResponse.json(health, { status: healthy ? 200 : 503, headers });
}
