import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { microdollar_usage, microdollar_usage_metadata, feature } from '@/db/schema';
import { eq, sql, desc, isNull, and } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const { user, authFailedResponse } = await getUserFromAuth({
    adminOnly: false,
  });

  if (authFailedResponse) return authFailedResponse;

  const { searchParams } = new URL(request.url);
  const groupByModel = searchParams.get('groupByModel') === 'true';
  const viewType = searchParams.get('viewType') || 'personal'; // 'personal', 'all', or organization ID

  const userId = user.id;

  // Build the select object conditionally
  const selectFields = {
    date: sql<string>`DATE(${microdollar_usage.created_at})`,
    ...(groupByModel && { model: microdollar_usage.model }),
    feature: feature.feature,
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
    ...(groupByModel ? [microdollar_usage.model] : []),
    feature.feature,
  ];
  const orderByClause = [
    desc(sql`DATE(${microdollar_usage.created_at})`),
    ...(groupByModel ? [microdollar_usage.model] : []),
  ];

  // Build where clause based on view type
  let whereClause;
  if (viewType === 'personal') {
    // Personal usage only (no org)
    whereClause = and(
      eq(microdollar_usage.kilo_user_id, userId),
      isNull(microdollar_usage.organization_id)
    );
  } else if (viewType === 'all') {
    // All usage for this user (both personal and org)
    whereClause = eq(microdollar_usage.kilo_user_id, userId);
  } else {
    // Specific organization usage (viewType is the organization ID)
    whereClause = and(
      eq(microdollar_usage.kilo_user_id, userId),
      eq(microdollar_usage.organization_id, viewType)
    );
  }

  // Query usage data
  const usage = await db
    .select(selectFields)
    .from(microdollar_usage)
    .leftJoin(microdollar_usage_metadata, eq(microdollar_usage.id, microdollar_usage_metadata.id))
    .leftJoin(feature, eq(microdollar_usage_metadata.feature_id, feature.feature_id))
    .where(whereClause)
    .groupBy(...groupByClause)
    .orderBy(...orderByClause);

  return NextResponse.json({
    usage,
  });
}
