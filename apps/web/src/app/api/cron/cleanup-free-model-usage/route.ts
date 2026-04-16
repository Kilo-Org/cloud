import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { free_model_usage } from '@kilocode/db/schema';
import { lt, inArray, sql } from 'drizzle-orm';
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
    const result = await db
      .delete(free_model_usage)
      .where(
        inArray(
          free_model_usage.id,
          db
            .select({ id: free_model_usage.id })
            .from(free_model_usage)
            .where(lt(free_model_usage.created_at, cutoffDate))
            .limit(BATCH_SIZE)
        )
      );

    const deleted = result.rowCount ?? 0;
    totalDeleted += deleted;
    iterations++;

    if (deleted < BATCH_SIZE) {
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
