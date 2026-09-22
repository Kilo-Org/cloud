import { NextResponse } from 'next/server';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { webhook_events } from '@kilocode/db/schema';
import { asc, inArray, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';

const RETENTION_DAYS = 7;
const BATCH_SIZE = 1_000;

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

    const deletedCount = result?.rowCount ?? 0;
    const hasMore = expiredRows.length > BATCH_SIZE;
    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        deleted_webhook_events_count: deletedCount,
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
