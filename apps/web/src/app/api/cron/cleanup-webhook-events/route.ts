import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { webhook_events } from '@kilocode/db/schema';
import { asc, inArray, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';

const RETENTION_DAYS = 60;
const BATCH_SIZE = 2_500;
const MAX_BATCHES_PER_RUN = 2;

export const maxDuration = 300;

type BatchResult = {
  deletedCount: number;
  hasMore: boolean;
};

async function deleteExpiredBatch(cutoffDate: string): Promise<BatchResult> {
  const expiredRows = await db
    .select({ id: webhook_events.id })
    .from(webhook_events)
    .where(lt(webhook_events.created_at, cutoffDate))
    .orderBy(asc(webhook_events.created_at))
    .limit(BATCH_SIZE + 1);

  const batchIds = expiredRows.slice(0, BATCH_SIZE).map(row => row.id);
  const result =
    batchIds.length > 0
      ? await db.delete(webhook_events).where(inArray(webhook_events.id, batchIds))
      : null;

  return { deletedCount: result?.rowCount ?? 0, hasMore: expiredRows.length > BATCH_SIZE };
}

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_webhook_events',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();

    let deletedCount = 0;
    let hasMore = false;
    let batchesRun = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const result = await deleteExpiredBatch(cutoffDate);
      deletedCount += result.deletedCount;
      hasMore = result.hasMore;
      batchesRun++;

      if (!hasMore || result.deletedCount === 0) {
        break;
      }
    }

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_webhook_events_count: deletedCount,
        deleted_count: deletedCount,
        batch_size: BATCH_SIZE,
        batches_run: batchesRun,
        has_more: hasMore,
      })
    );

    return NextResponse.json({
      deletedCount,
      batchSize: BATCH_SIZE,
      batchesRun,
      hasMore,
      cutoffDate,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
