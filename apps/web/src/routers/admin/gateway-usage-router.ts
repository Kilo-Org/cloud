import 'server-only';

import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { getEnvVariable } from '@/lib/dotenvx';
import { readDb, usesSeparateReplica } from '@/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { timedUsageQuery } from '@/lib/usage-query';

const NonnegativeIntegerStringSchema = z.string().regex(/^\d+$/);
const DecimalStringSchema = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const NullableTokenSumSchema = z
  .string()
  .regex(/^\d+(?:\.\d+)?$/)
  .nullable();
const NullableCostSumSchema = DecimalStringSchema.nullable();

const MonthlyUsageSchema = z.object({
  provider: z.string().nullable(),
  is_byok: z.boolean().nullable(),
  users: NonnegativeIntegerStringSchema,
  logged_in_users: NonnegativeIntegerStringSchema,
  input_tokens: NullableTokenSumSchema,
  output_tokens: NullableTokenSumSchema,
  cache_read_tokens: NullableTokenSumSchema,
  cache_write_tokens: NullableTokenSumSchema,
  cost: NullableCostSumSchema,
  market_cost: NullableCostSumSchema,
});

function monthlyUsageTimeoutMs(): number {
  const configured = Number(getEnvVariable('USAGE_QUERY_TIMEOUT_ADMIN_MS'));
  const adminTimeoutMs =
    Number.isInteger(configured) && configured >= 0 && configured <= 2_147_483_647
      ? configured
      : 20_000;
  return Math.max(600_000, adminTimeoutMs);
}

export const adminGatewayUsageRouter = createTRPCRouter({
  getMonthlyUsage: adminProcedure
    .input(
      z.object({
        year: z.number().int().min(2000).max(9999),
        month: z.number().int().min(1).max(12),
        model: z.string().trim().min(1).max(256),
      })
    )
    .output(z.array(MonthlyUsageSchema))
    .query(async ({ input, signal }) => {
      try {
        signal?.throwIfAborted();
        if (process.env.NODE_ENV === 'production' && !usesSeparateReplica) {
          throw new Error('Gateway usage requires a read replica');
        }

        const period = `${input.year}-${String(input.month).padStart(2, '0')}`;
        const startDate = `${period}-01 00:00:00+00`;
        const endYear = input.month === 12 ? input.year + 1 : input.year;
        const endMonth = input.month === 12 ? 1 : input.month + 1;
        const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01 00:00:00+00`;
        const rows = await timedUsageQuery(
          {
            db: readDb,
            route: 'admin.gatewayUsage.getMonthlyUsage',
            queryLabel: 'monthly_model_usage',
            scope: 'admin',
            period,
            timeoutMs: monthlyUsageTimeoutMs(),
          },
          async tx => {
            const result = await tx.execute(sql`
              SELECT
                mu.provider,
                meta.is_byok,
                COUNT(DISTINCT mu.kilo_user_id)::text AS users,
                COUNT(DISTINCT CASE WHEN mu.kilo_user_id NOT ILIKE 'anon:%' THEN mu.kilo_user_id END)::text AS logged_in_users,
                SUM(mu.input_tokens)::text AS input_tokens,
                SUM(mu.output_tokens)::text AS output_tokens,
                SUM(mu.cache_hit_tokens)::text AS cache_read_tokens,
                SUM(mu.cache_write_tokens)::text AS cache_write_tokens,
                SUM(mu.cost)::text AS cost,
                SUM(meta.market_cost)::text AS market_cost
              FROM microdollar_usage mu
              INNER JOIN microdollar_usage_metadata meta ON mu.id = meta.id
              WHERE mu.requested_model = ${input.model}
                AND meta.is_user_byok = false
                AND mu.created_at >= ${startDate}::timestamptz
                AND mu.created_at < ${endDate}::timestamptz
              GROUP BY mu.provider, meta.is_byok
              ORDER BY mu.provider, meta.is_byok
            `);
            return result.rows;
          }
        );
        return z.array(MonthlyUsageSchema).parse(rows);
      } catch {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Gateway usage data temporarily unavailable',
        });
      }
    }),
});
