import { db } from '@/lib/drizzle';
import { promoCreditCategories } from '@/lib/promoCreditCategories';
import { has_Payment } from '@/lib/promoCustomerRequirement';
import { sql } from 'drizzle-orm';

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

// Legacy credit fields retain their existing credit_transactions semantics.
// Service-fee fields are a separate settled-assessment series grouped in UTC;
// they do not represent product or gross payment revenue.
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
  collected_service_fee_dollars: number;
  missed_service_fee_dollars: number;
  exempted_service_fee_dollars: number;
  disputed_service_fee_dollars: number;
  service_fee_charged_count: number;
  service_fee_missed_count: number;
  service_fee_exempt_count: number;
};

export type RevenueKpiResponse = {
  data: RevenueKpiData[];
  multiplierCategories: string[];
};

/** Fetch daily legacy credit metrics and separate settled service-fee metrics. */
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
            AND ft.created_at < pt.created_at + INTERVAL '1800 second'
            AND ft.credit_category IN (${sql.join(
              multiplierCategories.map(c => sql`${c}`),
              sql`, `
            )})
        WHERE pt.is_free = false AND pt.amount_microdollars > 0
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
    ),
    service_fee_by_date AS (
        SELECT
            (sa.settled_at AT TIME ZONE 'UTC')::date AS transaction_day,
            SUM(GREATEST(sa.charged_fee_minor - sa.refunded_fee_minor - sa.disputed_fee_minor, 0)) / 100.0 AS collected_service_fee_dollars,
            COALESCE(SUM(sa.expected_fee_minor) FILTER (WHERE sa.outcome = 'missed'), 0) / 100.0 AS missed_service_fee_dollars,
            COALESCE(SUM(sa.expected_fee_minor) FILTER (WHERE sa.outcome = 'exempt'), 0) / 100.0 AS exempted_service_fee_dollars,
            SUM(sa.disputed_fee_minor) / 100.0 AS disputed_service_fee_dollars,
            COUNT(*) FILTER (WHERE sa.outcome = 'charged') AS service_fee_charged_count,
            COUNT(*) FILTER (WHERE sa.outcome = 'missed') AS service_fee_missed_count,
            COUNT(*) FILTER (WHERE sa.outcome = 'exempt') AS service_fee_exempt_count
        FROM public.stripe_service_fee_assessments sa
        WHERE sa.settled_at IS NOT NULL
          AND (sa.settled_at AT TIME ZONE 'UTC')::date BETWEEN ${startDate}::date AND ${endDate}::date
        GROUP BY transaction_day
    )
    SELECT
        COALESCE(pbd.transaction_day, fbd.transaction_day, sfbd.transaction_day) AS transaction_day,
        COALESCE(pbd.transaction_count, 0) AS paid_transaction_count,
        COALESCE(pbd.total_dollars, 0) AS paid_total_dollars,
        COALESCE(fbd.transaction_count, 0) AS free_transaction_count,
        COALESCE(fbd.total_dollars, 0) AS free_total_dollars,
        COALESCE(pmbd.transaction_count, 0) AS multiplied_transaction_count,
        COALESCE(pmbd.total_dollars, 0) AS multiplied_total_dollars,
        COALESCE(pbd.transaction_count, 0) - COALESCE(pmbd.transaction_count, 0) AS unmultiplied_transaction_count,
        COALESCE(pbd.total_dollars, 0) - COALESCE(pmbd.total_dollars, 0) AS unmultiplied_total_dollars,
        COALESCE(sfbd.collected_service_fee_dollars, 0) AS collected_service_fee_dollars,
        COALESCE(sfbd.missed_service_fee_dollars, 0) AS missed_service_fee_dollars,
        COALESCE(sfbd.exempted_service_fee_dollars, 0) AS exempted_service_fee_dollars,
        COALESCE(sfbd.disputed_service_fee_dollars, 0) AS disputed_service_fee_dollars,
        COALESCE(sfbd.service_fee_charged_count, 0) AS service_fee_charged_count,
        COALESCE(sfbd.service_fee_missed_count, 0) AS service_fee_missed_count,
        COALESCE(sfbd.service_fee_exempt_count, 0) AS service_fee_exempt_count
    FROM paid_by_date pbd
    FULL OUTER JOIN free_by_date fbd ON pbd.transaction_day = fbd.transaction_day
    FULL OUTER JOIN service_fee_by_date sfbd
      ON sfbd.transaction_day = COALESCE(pbd.transaction_day, fbd.transaction_day)
    LEFT JOIN paid_but_multiplied_by_date pmbd
      ON COALESCE(pbd.transaction_day, fbd.transaction_day, sfbd.transaction_day) = pmbd.transaction_day
    WHERE COALESCE(pbd.transaction_day, fbd.transaction_day, sfbd.transaction_day)
      BETWEEN ${startDate}::date AND ${endDate}::date
    ORDER BY COALESCE(pbd.transaction_day, fbd.transaction_day, sfbd.transaction_day) ASC;
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
    collected_service_fee_dollars: Number(row.collected_service_fee_dollars),
    missed_service_fee_dollars: Number(row.missed_service_fee_dollars),
    exempted_service_fee_dollars: Number(row.exempted_service_fee_dollars),
    disputed_service_fee_dollars: Number(row.disputed_service_fee_dollars),
    service_fee_charged_count: Number(row.service_fee_charged_count),
    service_fee_missed_count: Number(row.service_fee_missed_count),
    service_fee_exempt_count: Number(row.service_fee_exempt_count),
  }));

  return { data, multiplierCategories };
}
