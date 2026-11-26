import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { pruneSignInContexts, SIGN_IN_CONTEXT_PRUNE_BATCH_SIZE } from '@/lib/auth/sign-in-context';

export const maxDuration = 300;

/**
 * Deletes sign-in contexts past retention and rows under an older digest key,
 * in bounded batches. A run that reaches its batch limit leaves the rest for
 * the next hourly run.
 */
export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.prune_sign_in_contexts',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const result = await pruneSignInContexts();

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_count: result.expiredDeleted + result.otherKeyDeleted,
        deleted_expired_count: result.expiredDeleted,
        deleted_other_key_count: result.otherKeyDeleted,
        batch_size: SIGN_IN_CONTEXT_PRUNE_BATCH_SIZE,
        has_more: result.hasMore,
      })
    );

    return NextResponse.json({ ...result, timestamp: new Date().toISOString() });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
