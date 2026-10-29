import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { organization_mcp_connect_events } from '@kilocode/db/schema';
import { asc, inArray, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';

const RETENTION_DAYS = 90;
const BATCH_SIZE = 2_500;

export const maxDuration = 300;

type BatchResult = {
  deletedCount: number;
  hasMore: boolean;
};

async function deleteExpiredBatch(cutoffDate: string): Promise<BatchResult> {
  const expiredRows = await db
    .select({ id: organization_mcp_connect_events.id })
    .from(organization_mcp_connect_events)
    .where(lt(organization_mcp_connect_events.created_at, cutoffDate))
    .orderBy(asc(organization_mcp_connect_events.created_at))
    .limit(BATCH_SIZE + 1);

  const batchIds = expiredRows.slice(0, BATCH_SIZE).map(row => row.id);
  const result =
    batchIds.length > 0
      ? await db
          .delete(organization_mcp_connect_events)
          .where(inArray(organization_mcp_connect_events.id, batchIds))
      : null;

  return { deletedCount: result?.rowCount ?? 0, hasMore: expiredRows.length > BATCH_SIZE };
}

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_mcp_connect_events',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();

    let deletedCount = 0;
    let hasMore = false;
    let batchesRun = 0;

    do {
      const result = await deleteExpiredBatch(cutoffDate);
      deletedCount += result.deletedCount;
      hasMore = result.hasMore && result.deletedCount > 0;
      batchesRun++;
    } while (hasMore);

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_mcp_connect_events_count: deletedCount,
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
