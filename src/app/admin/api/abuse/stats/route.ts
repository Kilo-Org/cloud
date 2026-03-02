import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';

export async function GET(_request: NextRequest): Promise<
  NextResponse<
    | { error: string }
    | {
        hourlyAbusePercentage: number;
        abuseCostMicrodollars: number;
        totalCostMicrodollars: number;
        abuseRequestCount: number;
        totalRequestCount: number;
        dailyAbusePercentage: number;
        dailyAbuseCostMicrodollars: number;
        dailyTotalCostMicrodollars: number;
        dailyAbuseTokenPercentage: number;
        dailyAbuseTokens: number;
        dailyTotalTokens: number;
      }
  >
> {
  // Check authentication and admin status
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  // Execute the query to get abuse statistics for the last hour
  const hourlyResult = await db
    .select({
      abuse_cost_microdollars: sql<number>`SUM(CASE WHEN ${microdollar_usage.abuse_classification} > 0 THEN ${microdollar_usage.cost} ELSE 0 END)`,
      total_cost_microdollars: sql<number>`SUM(${microdollar_usage.cost})`,
      abuse_request_count: sql<number>`COUNT(CASE WHEN ${microdollar_usage.abuse_classification} > 0 THEN 1 END)`,
      total_request_count: sql<number>`COUNT(*)`,
    })
    .from(microdollar_usage)
    .where(sql`${microdollar_usage.created_at} >= NOW() - INTERVAL '1 hour'`);

  const hourlyStats = hourlyResult[0];

  // Execute the query to get abuse statistics for the last 24 hours
  const dailyResult = await db
    .select({
      abuse_cost_microdollars: sql<number>`SUM(CASE WHEN ${microdollar_usage.abuse_classification} > 0 THEN ${microdollar_usage.cost} ELSE 0 END)`,
      total_cost_microdollars: sql<number>`SUM(${microdollar_usage.cost})`,
      abuse_tokens: sql<number>`SUM(CASE WHEN ${microdollar_usage.abuse_classification} > 0 THEN ${microdollar_usage.input_tokens} + ${microdollar_usage.output_tokens} ELSE 0 END)`,
      total_tokens: sql<number>`SUM(${microdollar_usage.input_tokens} + ${microdollar_usage.output_tokens})`,
    })
    .from(microdollar_usage)
    .where(sql`${microdollar_usage.created_at} >= NOW() - INTERVAL '24 hours'`);

  const dailyStats = dailyResult[0];

  // Helper function to safely convert BigInt to number
  const bigIntToNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return Number(value) || 0;
  };

  // Calculate percentages, handling division by zero
  const hourlyAbuseCost = bigIntToNumber(hourlyStats.abuse_cost_microdollars);
  const hourlyTotalCost = bigIntToNumber(hourlyStats.total_cost_microdollars);
  const dailyAbuseCost = bigIntToNumber(dailyStats.abuse_cost_microdollars);
  const dailyTotalCost = bigIntToNumber(dailyStats.total_cost_microdollars);
  const dailyAbuseTokensNum = bigIntToNumber(dailyStats.abuse_tokens);
  const dailyTotalTokensNum = bigIntToNumber(dailyStats.total_tokens);

  const hourlyAbusePercentage =
    hourlyTotalCost > 0 ? Math.round((hourlyAbuseCost / hourlyTotalCost) * 10000) / 100 : 0;

  const dailyAbusePercentage =
    dailyTotalCost > 0 ? Math.round((dailyAbuseCost / dailyTotalCost) * 10000) / 100 : 0;

  const dailyAbuseTokenPercentage =
    dailyTotalTokensNum > 0
      ? Math.round((dailyAbuseTokensNum / dailyTotalTokensNum) * 10000) / 100
      : 0;

  return NextResponse.json({
    hourlyAbusePercentage,
    abuseCostMicrodollars: bigIntToNumber(hourlyStats.abuse_cost_microdollars),
    totalCostMicrodollars: bigIntToNumber(hourlyStats.total_cost_microdollars),
    abuseRequestCount: bigIntToNumber(hourlyStats.abuse_request_count),
    totalRequestCount: bigIntToNumber(hourlyStats.total_request_count),
    dailyAbusePercentage,
    dailyAbuseCostMicrodollars: bigIntToNumber(dailyStats.abuse_cost_microdollars),
    dailyTotalCostMicrodollars: bigIntToNumber(dailyStats.total_cost_microdollars),
    dailyAbuseTokenPercentage,
    dailyAbuseTokens: bigIntToNumber(dailyStats.abuse_tokens),
    dailyTotalTokens: bigIntToNumber(dailyStats.total_tokens),
  });
}
