import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { microdollar_usage_view_with_session } from '@/db/schema';
import { eq, desc, count, and, gt } from 'drizzle-orm';
import type { HeuristicAnalysisResponse } from '../types';
import { ABUSE_CLASSIFICATION } from '@/types/AbuseClassification';

export async function GET(request: NextRequest): Promise<NextResponse<HeuristicAnalysisResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId');
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '100')));
  const onlyAbuse = searchParams.get('onlyAbuse') === 'true';

  if (!userId) {
    return NextResponse.json({ error: 'userId is required' }, { status: 400 });
  }

  const baseCondition = eq(microdollar_usage_view_with_session.kilo_user_id, userId);
  const whereCondition = onlyAbuse
    ? and(
        baseCondition,
        gt(
          microdollar_usage_view_with_session.abuse_classification,
          ABUSE_CLASSIFICATION.NOT_CLASSIFIED
        )
      )
    : baseCondition;

  const totalQuery = db
    .select({ total: count() })
    .from(microdollar_usage_view_with_session)
    .where(whereCondition);

  const dataQuery = db
    .select()
    .from(microdollar_usage_view_with_session)
    .where(whereCondition)
    .orderBy(desc(microdollar_usage_view_with_session.created_at))
    .limit(limit)
    .offset((page - 1) * limit);

  const [[{ total }], rawData] = await Promise.all([totalQuery, dataQuery]);
  const totalPages = Math.ceil(total / limit);

  return NextResponse.json({
    data: rawData.map(o => ({
      ...o,
      // TODO: Pull this from the abuse classification service
      is_ja4_whitelisted: false,
    })),
    pagination: { page, limit, total, totalPages },
  });
}
