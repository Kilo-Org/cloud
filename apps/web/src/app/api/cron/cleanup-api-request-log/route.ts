import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { db } from '@/lib/drizzle';
import { api_request_compress_log, api_request_log } from '@kilocode/db/schema';
import { asc, inArray, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@/lib/config.server';

const RETENTION_DAYS = 30;
const BATCH_SIZE = 1_000;

function getDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_api_request_log',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    const cutoffDate = getDaysAgo(RETENTION_DAYS).toISOString();
    const expiredRows = await db
      .select({ id: api_request_log.id })
      .from(api_request_log)
      .where(lt(api_request_log.created_at, cutoffDate))
      .orderBy(asc(api_request_log.created_at))
      .limit(BATCH_SIZE + 1);

    const batchIds = expiredRows.slice(0, BATCH_SIZE).map(row => row.id);
    const result =
      batchIds.length > 0
        ? await db.delete(api_request_log).where(inArray(api_request_log.id, batchIds))
        : null;

    const expiredCompressRows = await db
      .select({ id: api_request_compress_log.id })
      .from(api_request_compress_log)
      .where(lt(api_request_compress_log.created_at, cutoffDate))
      .orderBy(asc(api_request_compress_log.created_at))
      .limit(BATCH_SIZE + 1);

    const compressBatchIds = expiredCompressRows.slice(0, BATCH_SIZE).map(row => row.id);
    const compressResult =
      compressBatchIds.length > 0
        ? await db
            .delete(api_request_compress_log)
            .where(inArray(api_request_compress_log.id, compressBatchIds))
        : null;
    const deletedApiRequestLogCount = result?.rowCount ?? 0;
    const deletedApiRequestCompressLogCount = compressResult?.rowCount ?? 0;
    const deletedCount = deletedApiRequestLogCount + deletedApiRequestCompressLogCount;
    const hasMore = expiredRows.length > BATCH_SIZE || expiredCompressRows.length > BATCH_SIZE;
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_api_request_log_count: deletedApiRequestLogCount,
        deleted_api_request_compress_log_count: deletedApiRequestCompressLogCount,
        deleted_count: deletedCount,
        batch_size: BATCH_SIZE,
        has_more: hasMore,
      })
    );

    return NextResponse.json({
      deletedCount,
      batchSize: BATCH_SIZE,
      hasMore,
      cutoffDate,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
    throw error;
  }
}
