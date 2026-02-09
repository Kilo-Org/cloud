import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { api_request_log } from '@/db/schema';
import { lt } from 'drizzle-orm';
import { CRON_SECRET } from '@/lib/config.server';

const BETTERSTACK_HEARTBEAT_URL =
  'https://uptime.betterstack.com/api/v1/heartbeat/UcSxCC84Yvhr8DfSZ8GJ2tx7';

function getDaysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const cutoffDate = getDaysAgo(7).toISOString();
  const result = await db.delete(api_request_log).where(lt(api_request_log.created_at, cutoffDate));

  await fetch(BETTERSTACK_HEARTBEAT_URL);
  // don't report failures to betterstack immediately, it's fine if this fails occasionally

  return NextResponse.json({
    deletedCount: result.rowCount ?? 0,
    cutoffDate,
    timestamp: new Date().toISOString(),
  });
}
