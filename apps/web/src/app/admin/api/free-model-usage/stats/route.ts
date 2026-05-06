import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { free_model_usage, kilocode_users } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import {
  FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
  FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
  ADMIN_RATE_LIMIT_TEST_MODEL,
} from '@/lib/constants';

export type UserAtLimit = {
  kiloUserId: string;
  requestCount: number;
  googleUserName: string | null;
  googleUserEmail: string | null;
  googleUserImageUrl: string | null;
};

export type FreeModelUsageStatsResponse = {
  // Current window stats
  windowUniqueIps: number;
  windowTotalRequests: number;
  windowAvgRequestsPerIp: number;
  // Anonymous IPs whose anonymous-only request count has reached the limit.
  windowAnonymousIpsAtRequestLimit: number;
  // Authenticated users whose per-user request count has reached the limit.
  windowUsersAtRequestLimit: number;
  windowUsersAtLimitList: UserAtLimit[];
  windowAnonymousRequests: number;
  windowAuthenticatedRequests: number;

  // Last 24 hours stats
  dailyUniqueIps: number;
  dailyTotalRequests: number;
  dailyAnonymousRequests: number;
  dailyAuthenticatedRequests: number;

  // Rate limit configuration
  rateLimitWindowHours: number;
  maxRequestsPerWindow: number;
};

export async function GET(
  _request: NextRequest
): Promise<NextResponse<{ error: string } | FreeModelUsageStatsResponse>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const TEST_ROW_FILTER = sql`${free_model_usage.model} != ${ADMIN_RATE_LIMIT_TEST_MODEL}`;

  // Get stats for the current rate limit window
  const windowResult = await db
    .select({
      unique_ips: sql<number>`COUNT(DISTINCT ${free_model_usage.ip_address})`,
      total_requests: sql<number>`COUNT(*)`,
      anonymous_requests: sql<number>`COUNT(*) FILTER (WHERE ${free_model_usage.kilo_user_id} IS NULL)`,
      authenticated_requests: sql<number>`COUNT(*) FILTER (WHERE ${free_model_usage.kilo_user_id} IS NOT NULL)`,
    })
    .from(free_model_usage)
    .where(
      sql`${free_model_usage.created_at} >= NOW() - INTERVAL '${sql.raw(String(FREE_MODEL_RATE_LIMIT_WINDOW_HOURS))} hours' AND ${TEST_ROW_FILTER}`
    );

  // Anonymous IPs at the per-IP limit (anonymous-only rows, matching checkFreeModelRateLimit).
  const anonymousIpsAtLimitResult = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(
      sql`(
        SELECT ${free_model_usage.ip_address}
        FROM ${free_model_usage}
        WHERE ${free_model_usage.created_at} >= NOW() - INTERVAL '${sql.raw(String(FREE_MODEL_RATE_LIMIT_WINDOW_HOURS))} hours'
          AND ${TEST_ROW_FILTER}
          AND ${free_model_usage.kilo_user_id} IS NULL
        GROUP BY ${free_model_usage.ip_address}
        HAVING COUNT(*) >= ${FREE_MODEL_MAX_REQUESTS_PER_WINDOW}
      ) sub`
    );

  // Authenticated users at the per-user limit (matching checkFreeModelRateLimitByUser).
  // Returns the actual user rows (joined with kilocode_users for display) ordered by
  // request count desc; the count of all such users is the length of this array.
  const usersAtLimitRows = await db
    .select({
      kiloUserId: free_model_usage.kilo_user_id,
      requestCount: sql<number>`COUNT(*)`.as('request_count'),
      googleUserName: kilocode_users.google_user_name,
      googleUserEmail: kilocode_users.google_user_email,
      googleUserImageUrl: kilocode_users.google_user_image_url,
    })
    .from(free_model_usage)
    .leftJoin(kilocode_users, sql`${kilocode_users.id} = ${free_model_usage.kilo_user_id}`)
    .where(
      sql`${free_model_usage.created_at} >= NOW() - INTERVAL '${sql.raw(String(FREE_MODEL_RATE_LIMIT_WINDOW_HOURS))} hours'
        AND ${TEST_ROW_FILTER}
        AND ${free_model_usage.kilo_user_id} IS NOT NULL`
    )
    .groupBy(
      free_model_usage.kilo_user_id,
      kilocode_users.google_user_name,
      kilocode_users.google_user_email,
      kilocode_users.google_user_image_url
    )
    .having(sql`COUNT(*) >= ${FREE_MODEL_MAX_REQUESTS_PER_WINDOW}`)
    .orderBy(sql`request_count DESC`);

  // Get stats for the last 24 hours
  const dailyResult = await db
    .select({
      unique_ips: sql<number>`COUNT(DISTINCT ${free_model_usage.ip_address})`,
      total_requests: sql<number>`COUNT(*)`,
      anonymous_requests: sql<number>`COUNT(*) FILTER (WHERE ${free_model_usage.kilo_user_id} IS NULL)`,
      authenticated_requests: sql<number>`COUNT(*) FILTER (WHERE ${free_model_usage.kilo_user_id} IS NOT NULL)`,
    })
    .from(free_model_usage)
    .where(
      sql`${free_model_usage.created_at} >= NOW() - INTERVAL '24 hours' AND ${TEST_ROW_FILTER}`
    );

  const bigIntToNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return Number(value) || 0;
  };

  const windowStats = windowResult[0];
  const dailyStats = dailyResult[0];

  const windowUniqueIps = bigIntToNumber(windowStats.unique_ips);
  const windowTotalRequests = bigIntToNumber(windowStats.total_requests);

  return NextResponse.json({
    // Current window stats
    windowUniqueIps,
    windowTotalRequests,
    windowAvgRequestsPerIp:
      windowUniqueIps > 0 ? Math.round(windowTotalRequests / windowUniqueIps) : 0,
    windowAnonymousIpsAtRequestLimit: bigIntToNumber(anonymousIpsAtLimitResult[0]?.count ?? 0),
    windowUsersAtRequestLimit: usersAtLimitRows.length,
    windowUsersAtLimitList: usersAtLimitRows.map(row => ({
      kiloUserId: row.kiloUserId ?? '',
      requestCount: bigIntToNumber(row.requestCount),
      googleUserName: row.googleUserName,
      googleUserEmail: row.googleUserEmail,
      googleUserImageUrl: row.googleUserImageUrl,
    })),
    windowAnonymousRequests: bigIntToNumber(windowStats.anonymous_requests),
    windowAuthenticatedRequests: bigIntToNumber(windowStats.authenticated_requests),

    // Last 24 hours stats
    dailyUniqueIps: bigIntToNumber(dailyStats.unique_ips),
    dailyTotalRequests: bigIntToNumber(dailyStats.total_requests),
    dailyAnonymousRequests: bigIntToNumber(dailyStats.anonymous_requests),
    dailyAuthenticatedRequests: bigIntToNumber(dailyStats.authenticated_requests),

    // Rate limit configuration
    rateLimitWindowHours: FREE_MODEL_RATE_LIMIT_WINDOW_HOURS,
    maxRequestsPerWindow: FREE_MODEL_MAX_REQUESTS_PER_WINDOW,
  });
}
