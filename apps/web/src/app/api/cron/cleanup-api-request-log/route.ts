import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@kilocode/db/schema';
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

  return NextResponse.json({
    deletedCount: result?.rowCount ?? 0,
    batchSize: BATCH_SIZE,
    hasMore: expiredRows.length > BATCH_SIZE,
    cutoffDate,
    timestamp: new Date().toISOString(),
  });
}
