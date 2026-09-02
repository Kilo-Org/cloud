import 'server-only';

import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { getEnvVariable } from '@/lib/dotenvx';
import { executeSnowflakeStatement, resolveSnowflakeConfig } from '@/lib/snowflake';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';

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

const SnowflakeMonthlyUsageRowSchema = z
  .tuple([
    z.string().nullable(),
    z
      .enum(['true', 'false', 'TRUE', 'FALSE'])
      .nullable()
      .transform(value => (value === null ? null : value.toLowerCase() === 'true')),
    NonnegativeIntegerStringSchema,
    NonnegativeIntegerStringSchema,
    NullableTokenSumSchema,
    NullableTokenSumSchema,
    NullableTokenSumSchema,
    NullableTokenSumSchema,
    NullableCostSumSchema,
    NullableCostSumSchema,
  ])
  .transform(
    ([
      provider,
      is_byok,
      users,
      logged_in_users,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      cost,
      market_cost,
    ]) => ({
      provider,
      is_byok,
      users,
      logged_in_users,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      cache_write_tokens,
      cost,
      market_cost,
    })
  );

const MONTHLY_USAGE_SQL = `
  SELECT
    provider,
    is_byok,
    COUNT(DISTINCT kilo_user_id) AS users,
    COUNT(DISTINCT CASE WHEN kilo_user_id NOT ILIKE 'anon:%' THEN kilo_user_id END) AS logged_in_users,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(cache_write_tokens) AS cache_write_tokens,
    SUM(cost) AS cost,
    SUM(market_cost) AS market_cost
  FROM microdollar_usage
  WHERE requested_model = ?
    AND is_user_byok = false
    AND usage_date >= TO_DATE(?)
    AND usage_date < TO_DATE(?)
  GROUP BY provider, is_byok
  ORDER BY provider, is_byok
`;

const QUERY_GRACE_MS = 30_000;

function monthlyUsageTimeoutMs(): number {
  const configured = Number(getEnvVariable('USAGE_QUERY_TIMEOUT_ADMIN_MS'));
  const adminTimeoutMs =
    Number.isFinite(configured) && configured > 0 && configured <= 2_147_483_647 - QUERY_GRACE_MS
      ? configured
      : 20_000;
  return Math.max(10 * 60_000, adminTimeoutMs);
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
      const timeoutMs = monthlyUsageTimeoutMs();
      const budgetMs = timeoutMs + QUERY_GRACE_MS;
      const controller = new AbortController();
      const querySignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      const timer = setTimeout(
        () => controller.abort(new DOMException('Gateway usage query timed out', 'TimeoutError')),
        budgetMs
      );

      try {
        querySignal.throwIfAborted();
        const config = resolveSnowflakeConfig();
        if (!config) {
          throw new Error('Snowflake configuration unavailable');
        }

        const startDate = `${input.year}-${String(input.month).padStart(2, '0')}-01`;
        const endYear = input.month === 12 ? input.year + 1 : input.year;
        const endMonth = input.month === 12 ? 1 : input.month + 1;
        const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01`;
        const rows = await executeSnowflakeStatement({
          config,
          statement: MONTHLY_USAGE_SQL,
          bindings: [
            { type: 'TEXT', value: input.model },
            { type: 'TEXT', value: startDate },
            { type: 'TEXT', value: endDate },
          ],
          timeoutSeconds: Math.ceil(timeoutMs / 1000),
          pollTimeoutMs: budgetMs,
          signal: querySignal,
        });
        querySignal.throwIfAborted();
        return z.array(SnowflakeMonthlyUsageRowSchema).parse(rows);
      } catch {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Gateway usage data temporarily unavailable',
        });
      } finally {
        clearTimeout(timer);
      }
    }),
});
