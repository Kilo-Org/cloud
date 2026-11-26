import 'server-only';
import { NextResponse } from 'next/server';
import { asc, inArray, lt, sql } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getPostgresErrorCode } from '@/lib/db-errors';

// About six months.
const RETENTION_DAYS = 183;
const BATCH_SIZE = 2_500;
// The cron routes allow 300 s. No batch starts after this budget, and each
// batch's statements are bounded by what is left of it, so the last one ends
// well before the platform stops the function.
const TIME_BUDGET_MS = 120_000;
// The least a batch's statements get, so a batch started just before the
// deadline still has a usable timeout.
const MIN_BATCH_TIMEOUT_MS = 1_000;
// lock_not_available (lock_timeout) and query_canceled (statement_timeout).
const BATCH_TIMEOUT_SQLSTATES: ReadonlySet<string> = new Set(['55P03', '57014']);

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

/**
 * Deletes one batch in its own transaction. Each statement, and each lock wait
 * (a row held by an account anonymization, for example), is cancelled by the
 * server after `timeoutMs`, which rolls the batch back.
 */
async function deleteExpiredBatch(
  { table, id, createdAt }: AuditLogRetentionTable,
  cutoffDate: string,
  timeoutMs: number
): Promise<BatchResult> {
  return db.transaction(async tx => {
    // PostgreSQL rejects a parameterized SET; the caller passes an integer.
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${timeoutMs}'`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${timeoutMs}'`));

    const expiredRows = await tx
      .select({ id })
      .from(table)
      .where(lt(createdAt, cutoffDate))
      .orderBy(asc(createdAt))
      .limit(BATCH_SIZE + 1);

    const batchIds = expiredRows.slice(0, BATCH_SIZE).map(row => row.id);
    const result = batchIds.length > 0 ? await tx.delete(table).where(inArray(id, batchIds)) : null;

    return { deletedCount: result?.rowCount ?? 0, hasMore: expiredRows.length > BATCH_SIZE };
  });
}

/**
 * Cron handler that deletes audit rows older than the retention window, batch
 * after batch until none are left or {@link TIME_BUDGET_MS} has passed. A batch
 * that hits its statement or lock timeout stops the run. `has_more` is
 * reported when the budget ran out, or a timeout stopped the run, with expired
 * rows left; `timed_out` says which. `deletedCountField` names the
 * table-specific count in the scheduled-job success event.
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
      const startedAt = Date.now();
      const cutoffDate = new Date(startedAt - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
      const deadline = startedAt + TIME_BUDGET_MS;

      let deletedCount = 0;
      let hasMore = false;
      let timedOut = false;
      let batchesRun = 0;

      for (;;) {
        const timeoutMs = Math.max(MIN_BATCH_TIMEOUT_MS, Math.floor(deadline - Date.now()));
        let result: BatchResult;
        try {
          result = await deleteExpiredBatch(params.source, cutoffDate, timeoutMs);
        } catch (error) {
          const code = getPostgresErrorCode(error);
          if (code === null || !BATCH_TIMEOUT_SQLSTATES.has(code)) throw error;
          // The batch rolled back, so the rows it selected are still there.
          batchesRun++;
          hasMore = true;
          timedOut = true;
          break;
        }
        deletedCount += result.deletedCount;
        batchesRun++;

        if (!result.hasMore || result.deletedCount === 0) break;
        if (Date.now() >= deadline) {
          hasMore = true;
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
          timed_out: timedOut,
        })
      );

      return NextResponse.json({
        deletedCount,
        batchSize: BATCH_SIZE,
        batchesRun,
        hasMore,
        timedOut,
        cutoffDate,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));
      throw error;
    }
  };
}
