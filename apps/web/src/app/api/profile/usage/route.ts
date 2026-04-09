import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { readDb } from '@/lib/drizzle';
import { timedUsageQuery } from '@/lib/usage-query';
import { microdollar_usage } from '@kilocode/db/schema';
import { eq, sql, desc, isNull, and, gte } from 'drizzle-orm';
import { getDateThreshold, type Period } from '@/routers/user-router';

const VALID_PERIODS = new Set(['week', 'month', 'year', 'all']);

export async function GET(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(request.url);
  const groupByModel = searchParams.get('groupByModel') === 'true';
  const viewType = searchParams.get('viewType') || 'personal'; // 'personal', 'all', or organization ID
  const periodParam = searchParams.get('period') || 'week';
  const period: Period = VALID_PERIODS.has(periodParam) ? (periodParam as Period) : 'week';

  const userId = user.id;

  // Build the select object conditionally
  const selectFields = {
    date: sql<string>`DATE(${microdollar_usage.created_at})`,
    ...(groupByModel && {
      model: sql<
        string | null
      >`COALESCE(${microdollar_usage.requested_model}, ${microdollar_usage.model})`,
    }),
    total_cost: sql<number>`SUM(${microdollar_usage.cost})::float`,
    request_count: sql<number>`COUNT(*)::float`,
    total_input_tokens: sql<number>`SUM(${microdollar_usage.input_tokens})::float`,
    total_output_tokens: sql<number>`SUM(${microdollar_usage.output_tokens})::float`,
    total_cache_write_tokens: sql<number>`SUM(${microdollar_usage.cache_write_tokens})::float`,
    total_cache_hit_tokens: sql<number>`SUM(${microdollar_usage.cache_hit_tokens})::float`,
  };

  // Build the group by and order by clauses conditionally
  const groupByClause = [
    sql`DATE(${microdollar_usage.created_at})`,
    ...(groupByModel
      ? [sql`COALESCE(${microdollar_usage.requested_model}, ${microdollar_usage.model})`]
      : []),
  ];
  const orderByClause = [
    desc(sql`DATE(${microdollar_usage.created_at})`),
    ...(groupByModel
      ? [sql`COALESCE(${microdollar_usage.requested_model}, ${microdollar_usage.model})`]
      : []),
  ];

  // Build where conditions based on view type
  const conditions = [eq(microdollar_usage.kilo_user_id, userId)];

  if (viewType === 'personal') {
    conditions.push(isNull(microdollar_usage.organization_id));
  } else if (viewType !== 'all') {
    conditions.push(eq(microdollar_usage.organization_id, viewType));
  }

  const dateThreshold = getDateThreshold(period);
  if (dateThreshold) {
    conditions.push(gte(microdollar_usage.created_at, dateThreshold));
  }

  // Query usage data
  const usage = await timedUsageQuery(
    {
      db: readDb,
      route: 'profile/usage',
      queryLabel: 'profile_usage_by_date',
      scope: 'user',
      period,
    },
    tx =>
      tx
        .select(selectFields)
        .from(microdollar_usage)
        .where(and(...conditions))
        .groupBy(...groupByClause)
        .orderBy(...orderByClause)
  );

  return NextResponse.json({
    usage,
  });
}
