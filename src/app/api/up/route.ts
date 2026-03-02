import { db, sql } from '@/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import { and, gte, gt } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

export async function GET(): Promise<
  NextResponse<{ database: boolean; recentAIActivity: boolean }>
> {
  const statusDetails = {
    database: false,
    recentAIActivity: false,
  };
  try {
    const db_usage_shows_recent_llm_usage = await db.query.microdollar_usage.findFirst({
      columns: { id: true },
      where: and(
        gte(microdollar_usage.created_at, sql`NOW() - INTERVAL '5 minutes'`),
        gt(microdollar_usage.cost, 0.0) // openrouter 401's are still logged, so we need to filter those out
      ),
    });

    statusDetails.database = true;
    statusDetails.recentAIActivity = !!db_usage_shows_recent_llm_usage;
  } catch (error) {
    captureException(error);
  }

  const status = statusDetails.database && statusDetails.recentAIActivity ? 200 : 503;
  return NextResponse.json(statusDetails, { status });
}
