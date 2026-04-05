import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { sql, eq, isNull } from 'drizzle-orm';
import type {
  GuiCreditCategoryStatistics,
  CreditCategoriesApiResponse,
} from '@/lib/PromoCreditCategoryConfig';
import { toGuiCreditCategory } from '@/lib/PromoCreditCategoryConfig';
import { promoCreditCategories, promoCreditCategoriesByKey } from '@/lib/promoCreditCategories';

export async function GET(
  request: NextRequest
): Promise<NextResponse<CreditCategoriesApiResponse>> {
  const searchParams = request.nextUrl.searchParams;
  const key = searchParams.get('key'); // Filter by specific credit category key
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);

  const whereCondition = !key
    ? undefined
    : key === '<null:paid>'
      ? isNull(credit_transactions.credit_category)
      : eq(credit_transactions.credit_category, key);

  const creditCategoryStats = (
    await db
      .select({
        credit_category: credit_transactions.credit_category,
        user_count: sql<number>`COUNT(DISTINCT ${credit_transactions.kilo_user_id})::int`,
        credit_count: sql<number>`COUNT(${credit_transactions.id})::int`,
        total_dollars: sql<number>`COALESCE(SUM(${credit_transactions.amount_microdollars}) / 1000000.0, 0)::float`,
        user_count_last_week: sql<number>`COUNT(DISTINCT CASE WHEN ${credit_transactions.created_at} >= ${oneWeekAgo.toISOString()} THEN ${credit_transactions.kilo_user_id} END)::int`,
        credit_count_last_week: sql<number>`COUNT(CASE WHEN ${credit_transactions.created_at} >= ${oneWeekAgo.toISOString()} THEN ${credit_transactions.id} END)::int`,
        total_dollars_last_week: sql<number>`COALESCE(SUM(CASE WHEN ${credit_transactions.created_at} >= ${oneWeekAgo.toISOString()} THEN ${credit_transactions.amount_microdollars} END) / 1000000.0, 0)::float`,
        first_used_at: sql<string | null>`MIN(${credit_transactions.created_at})`,
        last_used_at: sql<string | null>`MAX(${credit_transactions.created_at})`,
        blocked_user_count: sql<number>`COUNT(DISTINCT CASE WHEN ${kilocode_users.blocked_reason} IS NOT NULL THEN ${credit_transactions.kilo_user_id} END)::int`,
      })
      .from(credit_transactions)
      .innerJoin(kilocode_users, eq(credit_transactions.kilo_user_id, kilocode_users.id))
      .where(whereCondition)
      .groupBy(credit_transactions.credit_category)
  ).sort((a, b) => b.total_dollars_last_week - a.total_dollars_last_week);

  const creditCategoriesWithCounts: GuiCreditCategoryStatistics[] = creditCategoryStats.map(
    stats => {
      const credit_category = stats.credit_category ?? '<null:paid>';
      const config = promoCreditCategoriesByKey.get(credit_category);

      return {
        customer_requirement_name: undefined,
        organization_requirement_name: undefined,
        ...(config && toGuiCreditCategory(config)),
        credit_category,
        user_count: stats.user_count,
        credit_count: stats.credit_count,
        total_dollars: stats.total_dollars,
        user_count_last_week: stats.user_count_last_week,
        credit_count_last_week: stats.credit_count_last_week,
        total_dollars_last_week: stats.total_dollars_last_week,
        first_used_at: stats.first_used_at ? new Date(stats.first_used_at) : null,
        last_used_at: stats.last_used_at ? new Date(stats.last_used_at) : null,
        blocked_user_count: stats.blocked_user_count,
      };
    }
  );

  // Add configured categories that have zero redemptions (not in DB results)
  if (!key) {
    const existingKeys = new Set(creditCategoriesWithCounts.map(c => c.credit_category));
    for (const config of promoCreditCategories) {
      if (!existingKeys.has(config.credit_category)) {
        creditCategoriesWithCounts.push({
          ...toGuiCreditCategory(config),
          credit_category: config.credit_category,
          user_count: 0,
          credit_count: 0,
          total_dollars: 0,
          user_count_last_week: 0,
          credit_count_last_week: 0,
          total_dollars_last_week: 0,
          first_used_at: null,
          last_used_at: null,
          blocked_user_count: 0,
        });
      }
    }
    creditCategoriesWithCounts.sort(
      (a, b) => b.total_dollars_last_week - a.total_dollars_last_week
    );
  }

  return NextResponse.json({
    creditCategories: creditCategoriesWithCounts,
  });
}
