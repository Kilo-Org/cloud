import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { readDb } from '@/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { timedUsageQuery } from '@/lib/usage-query';

type HourlyData = {
  hour: string;
  abuseCostMicrodollars: number;
  nonAbuseCostMicrodollars: number;
  totalCostMicrodollars: number;
  abusePercentage: number;
};

export async function GET(_request: NextRequest): Promise<
  NextResponse<
    | { error: string }
    | {
        data: HourlyData[];
        summary: {
          totalAbuseCost: number;
          totalNonAbuseCost: number;
          overallAbusePercentage: number;
        };
      }
  >
> {
  // Check authentication and admin status
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  // Query to get hourly abuse statistics for the last 12 hours
  const result = await timedUsageQuery(
    {
      db: readDb,
      route: 'admin/abuse/hourly-stats',
      queryLabel: 'admin_abuse_hourly_breakdown',
      scope: 'admin',
      period: '12h',
    },
    tx =>
      tx
        .select({
          hour: sql<string>`DATE_TRUNC('hour', ${microdollar_usage.created_at})::text`,
          abuse_cost_microdollars: sql<number>`SUM(CASE WHEN ${microdollar_usage.abuse_classification} > 0 THEN ${microdollar_usage.cost} ELSE 0 END)`,
          total_cost_microdollars: sql<number>`SUM(${microdollar_usage.cost})`,
        })
        .from(microdollar_usage)
        .where(sql`${microdollar_usage.created_at} >= NOW() - INTERVAL '12 hours'`)
        .groupBy(sql`DATE_TRUNC('hour', ${microdollar_usage.created_at})`)
        .orderBy(sql`DATE_TRUNC('hour', ${microdollar_usage.created_at})`)
  );

  // Helper function to safely convert BigInt to number
  const bigIntToNumber = (value: unknown): number => {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return Number(value) || 0;
  };

  // Process the results
  const hourlyData: HourlyData[] = result.map(row => {
    const abuseCost = bigIntToNumber(row.abuse_cost_microdollars);
    const totalCost = bigIntToNumber(row.total_cost_microdollars);
    const nonAbuseCost = totalCost - abuseCost;
    const abusePercentage = totalCost > 0 ? (abuseCost / totalCost) * 100 : 0;

    return {
      hour: row.hour,
      abuseCostMicrodollars: abuseCost,
      nonAbuseCostMicrodollars: nonAbuseCost,
      totalCostMicrodollars: totalCost,
      abusePercentage: Math.round(abusePercentage * 100) / 100,
    };
  });

  // Calculate summary statistics
  const totalAbuseCost = hourlyData.reduce((sum, item) => sum + item.abuseCostMicrodollars, 0);
  const totalNonAbuseCost = hourlyData.reduce(
    (sum, item) => sum + item.nonAbuseCostMicrodollars,
    0
  );
  const totalCost = totalAbuseCost + totalNonAbuseCost;
  const overallAbusePercentage =
    totalCost > 0 ? Math.round((totalAbuseCost / totalCost) * 10000) / 100 : 0;

  return NextResponse.json({
    data: hourlyData,
    summary: {
      totalAbuseCost,
      totalNonAbuseCost,
      overallAbusePercentage,
    },
  });
}
