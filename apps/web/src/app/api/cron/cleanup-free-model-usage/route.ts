import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { free_model_usage } from '@kilocode/db/schema';
import { asc, lt } from 'drizzle-orm';
import { CRON_SECRET } from '@/lib/config.server';

const RETENTION_DAYS = 7;
const BATCH_SIZE = 50_000;
const MAX_ITERATIONS = 20;
const PAUSE_BETWEEN_BATCHES_MS = 500;

function getDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cutoffDate = getDaysAgo(RETENTION_DAYS).toISOString();
  let totalDeleted = 0;
  let iterations = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Find the created_at of the BATCH_SIZE-th oldest expired row to use as a batch boundary.
    const boundary = await db
      .select({ created_at: free_model_usage.created_at })
      .from(free_model_usage)
      .where(lt(free_model_usage.created_at, cutoffDate))
      .orderBy(asc(free_model_usage.created_at))
      .offset(BATCH_SIZE - 1)
      .limit(1);

    const batchCutoff = boundary.length > 0 ? boundary[0].created_at : cutoffDate;

    const result = await db
      .delete(free_model_usage)
      .where(lt(free_model_usage.created_at, batchCutoff));

    const deleted = result.rowCount ?? 0;
    totalDeleted += deleted;
    iterations++;

    if (boundary.length === 0 || deleted === 0) {
      break;
    }

    await sleep(PAUSE_BETWEEN_BATCHES_MS);
  }

  return NextResponse.json({
    deletedCount: totalDeleted,
    iterations,
    cutoffDate,
    timestamp: new Date().toISOString(),
  });
}
