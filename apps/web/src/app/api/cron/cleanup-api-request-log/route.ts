import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { db } from '@/lib/drizzle';
import { api_request_log, api_request_log_payload_deletions } from '@kilocode/db/schema';
import { asc, inArray, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@/lib/config.server';
import { deleteApiRequestLogPayloads } from '@/lib/r2/api-request-logs';

export const maxDuration = 300;

const RETENTION_DAYS = 7;
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
      .select({ id: api_request_log.id, payloadObjectKey: api_request_log.payload_object_key })
      .from(api_request_log)
      .where(lt(api_request_log.created_at, cutoffDate))
      .orderBy(asc(api_request_log.created_at))
      .limit(BATCH_SIZE + 1);

    const batchIds = expiredRows.slice(0, BATCH_SIZE).map(row => row.id);
    const payloadObjectKeys = expiredRows
      .slice(0, BATCH_SIZE)
      .flatMap(row => (row.payloadObjectKey ? [row.payloadObjectKey] : []));
    const result =
      batchIds.length > 0
        ? await db.transaction(async tx => {
            if (payloadObjectKeys.length > 0) {
              await tx
                .insert(api_request_log_payload_deletions)
                .values(payloadObjectKeys.map(object_key => ({ object_key })))
                .onConflictDoNothing();
            }
            return tx.delete(api_request_log).where(inArray(api_request_log.id, batchIds));
          })
        : null;

    const deletedApiRequestLogCount = result?.rowCount ?? 0;
    const hasMore = expiredRows.length > BATCH_SIZE;
    const pendingPayloadDeletions = await db
      .select({ objectKey: api_request_log_payload_deletions.object_key })
      .from(api_request_log_payload_deletions)
      .orderBy(asc(api_request_log_payload_deletions.created_at))
      .limit(BATCH_SIZE);
    const pendingPayloadKeys = pendingPayloadDeletions.map(row => row.objectKey);
    let deletedPayloadCount = 0;
    if (pendingPayloadKeys.length > 0) {
      const deleteResult = await deleteApiRequestLogPayloads(pendingPayloadKeys);
      if (deleteResult.deletedKeys.length > 0) {
        const payloadDeleteResult = await db
          .delete(api_request_log_payload_deletions)
          .where(inArray(api_request_log_payload_deletions.object_key, deleteResult.deletedKeys));
        deletedPayloadCount = payloadDeleteResult.rowCount ?? 0;
      }
      if (deleteResult.failedKeys.length > 0) {
        throw new Error(
          `Failed to delete ${deleteResult.failedKeys.length} API request log payloads`
        );
      }
    }
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_api_request_log_count: deletedApiRequestLogCount,
        deleted_count: deletedApiRequestLogCount,
        queued_payload_count: payloadObjectKeys.length,
        deleted_payload_count: deletedPayloadCount,
        batch_size: BATCH_SIZE,
        has_more: hasMore,
      })
    );

    return NextResponse.json({
      deletedCount: deletedApiRequestLogCount,
      queuedPayloadCount: payloadObjectKeys.length,
      deletedPayloadCount,
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
