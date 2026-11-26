import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { api_request_log_2 } from '@kilocode/db/schema';
import { asc, inArray, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { deleteExpiredRequestLoggingOptIns } from '@kilocode/web-shared/lib/ai-gateway/request-logging-opt-ins';
import {
  apiRequestLogBlobKey,
  deleteApiRequestLogBlobs,
} from '@kilocode/web-shared/lib/r2/api-request-log';

const RETENTION_DAYS = 30;
const BATCH_SIZE = 10_000;

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
      .select({ id: api_request_log_2.id, created_at: api_request_log_2.created_at })
      .from(api_request_log_2)
      .where(lt(api_request_log_2.created_at, cutoffDate))
      .orderBy(asc(api_request_log_2.created_at))
      .limit(BATCH_SIZE + 1);

    const batch = expiredRows.slice(0, BATCH_SIZE);
    let deletedApiRequestLogCount = 0;
    if (batch.length > 0) {
      // Keep the rows if blob deletion fails so the next run can retry.
      await deleteApiRequestLogBlobs(batch.map(apiRequestLogBlobKey));
      const ids = batch.map(row => row.id);
      const result = await db.delete(api_request_log_2).where(inArray(api_request_log_2.id, ids));
      deletedApiRequestLogCount = result.rowCount ?? 0;
    }

    const deletedOptInCount = await deleteExpiredRequestLoggingOptIns();
    const hasMore = expiredRows.length > BATCH_SIZE;
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_api_request_log_count: deletedApiRequestLogCount,
        deleted_request_logging_opt_in_count: deletedOptInCount,
        deleted_count: deletedApiRequestLogCount,
        batch_size: BATCH_SIZE,
        has_more: hasMore,
      })
    );

    return NextResponse.json({
      deletedCount: deletedApiRequestLogCount,
      deletedOptInCount,
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
