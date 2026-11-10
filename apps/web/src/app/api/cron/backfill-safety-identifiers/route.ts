import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import {
  regenerateSafetyIdentifiers,
  SAFETY_IDENTIFIER_BACKFILL_ERROR,
  SAFETY_IDENTIFIER_WORK_BUDGET_MS,
} from '@/lib/safety-identifiers';

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const run = createScheduledJobRun({
    jobName: 'web.backfill_safety_identifiers',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });
  try {
    const result = await regenerateSafetyIdentifiers({
      deadlineAt: Date.now() + SAFETY_IDENTIFIER_WORK_BUDGET_MS,
    });
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        processed_count: result.processed,
        remaining: result.remaining,
        skipped: result.skipped,
      })
    );
    return NextResponse.json(result);
  } catch {
    emitScheduledJobEvent(
      buildScheduledJobFailureEvent(run, new Error(SAFETY_IDENTIFIER_BACKFILL_ERROR))
    );
    return NextResponse.json({ error: SAFETY_IDENTIFIER_BACKFILL_ERROR }, { status: 500 });
  }
}
