import 'server-only';
import { NextResponse } from 'next/server';
import { asc, inArray, lt } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';

// About six months.
const RETENTION_DAYS = 183;
const BATCH_SIZE = 2_500;
const MAX_BATCHES_PER_RUN = 2;

/** An audit table pruned by age: its primary key and its indexed creation time. */
export type AuditLogRetentionTable = {
  table: PgTable;
  id: AnyPgColumn;
  createdAt: AnyPgColumn;
};

type BatchResult = {
  deletedCount: number;
  hasMore: boolean;
};

async function deleteExpiredBatch(
  { table, id, createdAt }: AuditLogRetentionTable,
  cutoffDate: string
): Promise<BatchResult> {
  const expiredRows = await db
    .select({ id })
    .from(table)
    .where(lt(createdAt, cutoffDate))
    .orderBy(asc(createdAt))
    .limit(BATCH_SIZE + 1);

  const batchIds = expiredRows.slice(0, BATCH_SIZE).map(row => row.id);
  const result = batchIds.length > 0 ? await db.delete(table).where(inArray(id, batchIds)) : null;

  return { deletedCount: result?.rowCount ?? 0, hasMore: expiredRows.length > BATCH_SIZE };
}

/**
 * Cron handler that deletes audit rows older than the retention window, in at
 * most {@link MAX_BATCHES_PER_RUN} batches per run so one run stays bounded.
 * `deletedCountField` names the table-specific count in the scheduled-job
 * success event.
 */
export function auditLogRetentionCron(params: {
  jobName: string;
  deletedCountField: string;
  source: AuditLogRetentionTable;
}): (request: Request) => Promise<NextResponse> {
  return async function GET(request: Request) {
    if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const run = createScheduledJobRun({
      jobName: params.jobName,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
    });

    try {
      const cutoffDate = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();

      let deletedCount = 0;
      let hasMore = false;
      let batchesRun = 0;

      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
        const result = await deleteExpiredBatch(params.source, cutoffDate);
        deletedCount += result.deletedCount;
        hasMore = result.hasMore;
        batchesRun++;

        if (!hasMore || result.deletedCount === 0) {
          break;
        }
      }

      emitScheduledJobEvent(
        buildScheduledJobSuccessEvent(run, {
          [params.deletedCountField]: deletedCount,
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
  };
}
