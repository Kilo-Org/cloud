import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { free_model_usage } from '@/db/schema';
import { sql } from 'drizzle-orm';
import { PROMOTION_WINDOW_HOURS, PROMOTION_MAX_REQUESTS } from '@/lib/constants';

export type PromotedModelUsageStatsResponse = {
  // Current window stats (anonymous only, last PROMOTION_WINDOW_HOURS)
  windowUniqueIps: number;
  windowTotalRequests: number;
  windowAvgRequestsPerIp: number;
  windowIpsAtRequestLimit: number;

  // Rate limit configuration
  promotionWindowHours: number;
  promotionMaxRequests: number;
};

const ANONYMOUS_FILTER = sql`${free_model_usage.kilo_user_id} IS NULL`;

export async function GET(
  _request: NextRequest
): Promise<NextResponse<{ error: string } | PromotedModelUsageStatsResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  // Get stats for the current promotion window (anonymous only)
  const windowResult = await db
    .select({
      unique_ips: sql<number>`COUNT(DISTINCT ${free_model_usage.ip_address})`,
      total_requests: sql<number>`COUNT(*)`,
    })
    .from(free_model_usage)
    .where(
      sql`${free_model_usage.created_at} >= NOW() - INTERVAL '${sql.raw(String(PROMOTION_WINDOW_HOURS))} hours' AND ${ANONYMOUS_FILTER}`
    );

  // Count IPs at or above the promotion limit threshold using a SQL subquery (anonymous only)
  const ipsAtLimitResult = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(
      sql`(
        SELECT ${free_model_usage.ip_address}
        FROM ${free_model_usage}
        WHERE ${free_model_usage.created_at} >= NOW() - INTERVAL '${sql.raw(String(PROMOTION_WINDOW_HOURS))} hours' AND ${ANONYMOUS_FILTER}
        GROUP BY ${free_model_usage.ip_address}
        HAVING COUNT(*) >= ${PROMOTION_MAX_REQUESTS}
      ) sub`
    );

  const bigIntToNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return Number(value) || 0;
  };

  const windowStats = windowResult[0];

  const windowUniqueIps = bigIntToNumber(windowStats.unique_ips);
  const windowTotalRequests = bigIntToNumber(windowStats.total_requests);
  const ipsAtRequestLimit = bigIntToNumber(ipsAtLimitResult[0]?.count ?? 0);

  return NextResponse.json({
    // Current window stats
    windowUniqueIps,
    windowTotalRequests,
    windowAvgRequestsPerIp:
      windowUniqueIps > 0 ? Math.round(windowTotalRequests / windowUniqueIps) : 0,
    windowIpsAtRequestLimit: ipsAtRequestLimit,

    // Rate limit configuration
    promotionWindowHours: PROMOTION_WINDOW_HOURS,
    promotionMaxRequests: PROMOTION_MAX_REQUESTS,
  });
}
