import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { refreshMetadataCache } from '@/lib/providers/metadata-cache/refresh-metadata-cache';

export const maxDuration = 240;

export async function GET(request: NextRequest) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.refresh_ai_gateway_metadata_cache',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const summary = await refreshMetadataCache();
    emitScheduledJobEvent(buildScheduledJobSuccessEvent(run, summary));
    return NextResponse.json(summary);
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
