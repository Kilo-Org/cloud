import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { EnkryptFailureCategorySchema, EnkryptSyncCountsSchema } from '@kilocode/db/schema-types';
import type { EnkryptSyncCounts } from '@kilocode/db/schema-types';
import * as z from 'zod';
import { CRON_SECRET } from '@/lib/config.server';
import { EnkryptSyncError } from '@/lib/model-stats/enkrypt-errors';
import { syncEnkryptBenchmarks } from '@/lib/model-stats/sync-enkrypt';

export const maxDuration = 120;

const SuccessSchema = EnkryptSyncCountsSchema.extend({
  status: z.literal('succeeded'),
  ingestedAt: z.string().datetime(),
});
const HttpStatusSchema = z.number().int().min(100).max(599);

function countMetadata(counts: EnkryptSyncCounts | undefined) {
  return {
    fetched_count: counts?.fetchedCount,
    rejected_count: counts?.rejectedCount,
    matched_count: counts?.matchedCount,
    unmatched_count: counts?.unmatchedCount,
    ambiguous_count: counts?.ambiguousCount,
    updated_count: counts?.updatedCount,
  };
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.sync_enkrypt',
    environment: process.env.VERCEL_TARGET_ENV ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const result = await syncEnkryptBenchmarks();
    if (result.status === 'disabled') {
      emitScheduledJobEvent(
        buildScheduledJobSuccessEvent(run, { status: 'disabled', skipped: true })
      );
      return NextResponse.json({ status: 'disabled' });
    }

    const parsed = SuccessSchema.safeParse(result);
    if (!parsed.success) throw new EnkryptSyncError('unexpected');
    const summary = parsed.data;
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        status: summary.status,
        ingested_at: summary.ingestedAt,
        ...countMetadata(summary),
      })
    );

    return NextResponse.json(summary);
  } catch (caught) {
    const category = EnkryptFailureCategorySchema.safeParse(
      caught instanceof EnkryptSyncError ? caught.category : undefined
    );
    const counts = EnkryptSyncCountsSchema.safeParse(
      caught instanceof EnkryptSyncError ? caught.counts : undefined
    );
    const httpStatus = HttpStatusSchema.safeParse(
      caught instanceof EnkryptSyncError ? caught.httpStatus : undefined
    );
    const error = new EnkryptSyncError(category.success ? category.data : 'unexpected', {
      ...(counts.success ? { counts: counts.data } : {}),
      ...(httpStatus.success ? { httpStatus: httpStatus.data } : {}),
    });
    const metadata = {
      category: error.category,
      ...countMetadata(error.counts),
      ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
    };
    captureException(error, {
      tags: { endpoint: 'cron/sync-enkrypt', ...metadata },
    });
    emitScheduledJobEvent(
      buildScheduledJobFailureEvent({
        context: run,
        jobName: run.jobName,
        environment: run.environment,
        error,
        metadata: { status: 'failed', sync_failure_count: 1, ...metadata },
      })
    );

    return NextResponse.json(
      {
        status: 'failed',
        error: 'Failed to sync Enkrypt benchmarks',
        category: error.category,
        ...(error.counts === undefined ? {} : { counts: error.counts }),
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      },
      { status: 500 }
    );
  }
}
