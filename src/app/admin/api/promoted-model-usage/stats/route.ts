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

  // Get per-IP stats to find IPs at limits (anonymous only)
  const perIpStats = await db
    .select({
      ip_address: free_model_usage.ip_address,
      request_count: sql<number>`COUNT(*)`,
    })
    .from(free_model_usage)
    .where(
      sql`${free_model_usage.created_at} >= NOW() - INTERVAL '${sql.raw(String(PROMOTION_WINDOW_HOURS))} hours' AND ${ANONYMOUS_FILTER}`
    )
    .groupBy(free_model_usage.ip_address);

  const bigIntToNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return Number(value) || 0;
  };

  const windowStats = windowResult[0];

  const windowUniqueIps = bigIntToNumber(windowStats.unique_ips);
  const windowTotalRequests = bigIntToNumber(windowStats.total_requests);

  // Count IPs at or near the promotion limit
  let ipsAtRequestLimit = 0;
  for (const ip of perIpStats) {
    const requestCount = bigIntToNumber(ip.request_count);
    if (requestCount >= PROMOTION_MAX_REQUESTS) {
      ipsAtRequestLimit++;
    }
  }

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
