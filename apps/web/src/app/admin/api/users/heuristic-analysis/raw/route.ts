import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { db } from '@/lib/drizzle';
import { microdollar_usage_view } from '@kilocode/db/schema';
import { eq, desc, and, gt, gte, sql } from 'drizzle-orm';
import type { HeuristicAnalysisResponse } from '../types';
import { ABUSE_CLASSIFICATION } from '@/types/AbuseClassification';
import { parseTimeWindow, timeWindowToInterval } from '../timeWindow';

export async function GET(request: NextRequest): Promise<NextResponse<HeuristicAnalysisResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '100')));
  const onlyAbuse = searchParams.get('onlyAbuse') === 'true';
  const timeWindow = parseTimeWindow(searchParams.get('since'));
  const interval = timeWindowToInterval(timeWindow);

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  const conditions = [eq(microdollar_usage_view.kilo_user_id, userId)];
  if (onlyAbuse) {
    conditions.push(
      gt(microdollar_usage_view.abuse_classification, ABUSE_CLASSIFICATION.NOT_CLASSIFIED)
    );
  }
  if (interval) {
    conditions.push(
      gte(microdollar_usage_view.created_at, sql`NOW() - ${sql.raw(`INTERVAL '${interval}'`)}`)
    );
  }
  const whereCondition = conditions.length === 1 ? conditions[0] : and(...conditions);

  // Fetch limit + 1 to detect whether another page exists, avoiding an
  // unbounded COUNT(*) over the user's full history.
  const rawData = await db
    .select()
    .from(microdollar_usage_view)
    .where(whereCondition)
    .orderBy(desc(microdollar_usage_view.created_at))
    .limit(limit + 1)
    .offset((page - 1) * limit);

  const hasMore = rawData.length > limit;
  const pageRows = hasMore ? rawData.slice(0, limit) : rawData;

  return NextResponse.json({
    data: pageRows.map(o => ({
      ...o,
      // TODO: Pull this from the abuse classification service
      is_ja4_whitelisted: false,
    })),
    pagination: { page, limit, hasMore },
  });
}
