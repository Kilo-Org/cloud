import { db } from '@/lib/drizzle';
import { promoCreditCategories } from '@/lib/promoCreditCategories';
import { has_Payment } from '@/lib/promoCustomerRequirement';
import { sql } from 'drizzle-orm';

// Define the first top-up categories that can optionally be included as multipliers
const coreMultiplierCategories = [
  'multiplier-promo',
  'fibonacci-topup-bonus',
  'payment-tripled',
  'non-card-payment-promotion',
];
const multiplierCategoriesIncludingFirstTopUp = [
  '20-usd-after-first-top-up',
  'first-topup-bonus',
  ...coreMultiplierCategories,
];

// Define the promo credit categories that count as multipliers
function getMultiplierCategories(includeFirstTopupCategories: boolean): string[] {
  const baseCategories = includeFirstTopupCategories
    ? multiplierCategoriesIncludingFirstTopUp
    : coreMultiplierCategories;
  return promoCreditCategories
    .filter(
      c => baseCategories.includes(c.credit_category) || c.customer_requirement === has_Payment
    )
    .map(c => c.credit_category);
}

// Define the result type for our revenue KPI data
export type RevenueKpiData = {
  transaction_day: string;
  paid_transaction_count: number;
  paid_total_dollars: number;
  free_transaction_count: number;
  free_total_dollars: number;
  multiplied_transaction_count: number;
  multiplied_total_dollars: number;
  unmultiplied_transaction_count: number;
  unmultiplied_total_dollars: number;
};

export type RevenueKpiResponse = {
  data: RevenueKpiData[];
  multiplierCategories: string[];
};

/**
 * Fetches revenue KPI data for a date range, including totals by day
 * @param includeFirstTopupCategories - Whether to include first top-up categories as multipliers
 * @param startDate - Inclusive start date (YYYY-MM-DD)
 * @param endDate - Inclusive end date (YYYY-MM-DD)
 * @returns Promise<RevenueKpiResponse> Object containing revenue KPI data by day and multiplier categories
 */
export async function getRevenueKpiData(
  includeFirstTopupCategories: boolean,
  startDate: string,
  endDate: string
): Promise<RevenueKpiResponse> {
  const multiplierCategories = getMultiplierCategories(includeFirstTopupCategories);
  const query = sql`
    WITH ranked_paid_multiplier_transactions AS (
        SELECT
            pt.*,
            ft.id AS free_id,
            ft.credit_category AS free_credit_category,
            ft.description AS free_description,
            ROW_NUMBER() OVER (
                PARTITION BY pt.id 
                ORDER BY pt.created_at DESC
            ) AS match_rank
        FROM public.credit_transactions AS pt
        JOIN public.credit_transactions AS ft 
            ON ft.kilo_user_id = pt.kilo_user_id 
            AND ft.is_free = true
            AND ft.created_at >= pt.created_at - INTERVAL '3 second' 
            AND ft.created_at <  pt.created_at + INTERVAL '1800 second'
            AND ft.credit_category IN (${sql.join(
              multiplierCategories.map(c => sql`${c}`),
              sql`, `
            )})
        WHERE pt.is_free = false and pt.amount_microdollars > 0
    ),
    paid_but_multiplied_by_date AS (
        SELECT 
            (rpt.created_at)::date AS transaction_day,
            COUNT(*) AS transaction_count,
            SUM(rpt.amount_microdollars) / 1000000.0 AS total_dollars
        FROM ranked_paid_multiplier_transactions rpt
        WHERE rpt.match_rank = 1
        GROUP BY transaction_day
    ),
    paid_by_date AS (
        SELECT
            (pt.created_at)::date AS transaction_day,
            COUNT(*) AS transaction_count,
            SUM(pt.amount_microdollars) / 1000000.0 AS total_dollars
        FROM public.credit_transactions pt
        WHERE pt.is_free = false
        GROUP BY transaction_day
    ),
    free_by_date AS (
        SELECT
            (ft.created_at)::date AS transaction_day,
            COUNT(*) AS transaction_count,
            SUM(ft.amount_microdollars) / 1000000.0 AS total_dollars
        FROM public.credit_transactions ft
        WHERE ft.is_free = true
        GROUP BY transaction_day
    )
    SELECT
        COALESCE(pbd.transaction_day, fbd.transaction_day) AS transaction_day,
        COALESCE(pbd.transaction_count, 0) AS paid_transaction_count,
        COALESCE(pbd.total_dollars, 0) AS paid_total_dollars,
        COALESCE(fbd.transaction_count, 0) AS free_transaction_count,
        COALESCE(fbd.total_dollars, 0) AS free_total_dollars,
        COALESCE(pmbd.transaction_count, 0) AS multiplied_transaction_count,
        COALESCE(pmbd.total_dollars, 0) AS multiplied_total_dollars,
        COALESCE(pbd.transaction_count, 0) - COALESCE(pmbd.transaction_count, 0) AS unmultiplied_transaction_count,
        COALESCE(pbd.total_dollars, 0) - COALESCE(pmbd.total_dollars, 0) AS unmultiplied_total_dollars
    FROM paid_by_date pbd
    FULL OUTER JOIN free_by_date fbd ON pbd.transaction_day = fbd.transaction_day
    LEFT JOIN paid_but_multiplied_by_date pmbd ON COALESCE(pbd.transaction_day, fbd.transaction_day) = pmbd.transaction_day
    WHERE COALESCE(pbd.transaction_day, fbd.transaction_day) BETWEEN ${startDate}::date AND ${endDate}::date
    ORDER BY COALESCE(pbd.transaction_day, fbd.transaction_day) ASC;
  `;

  const result = await db.execute(query);

  const data = result.rows.map(row => ({
    transaction_day: row.transaction_day as string,
    paid_transaction_count: Number(row.paid_transaction_count),
    paid_total_dollars: Number(row.paid_total_dollars),
    free_transaction_count: Number(row.free_transaction_count),
    free_total_dollars: Number(row.free_total_dollars),
    multiplied_transaction_count: Number(row.multiplied_transaction_count),
    multiplied_total_dollars: Number(row.multiplied_total_dollars),
    unmultiplied_transaction_count: Number(row.unmultiplied_transaction_count),
    unmultiplied_total_dollars: Number(row.unmultiplied_total_dollars),
  }));

  return {
    data,
    multiplierCategories,
  };
}
