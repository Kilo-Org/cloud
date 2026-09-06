import 'server-only';

import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
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

const UsageDateSchema = z.iso
  .date()
  .length(10)
  .refine(date => date >= '2000-01-01' && date <= '9999-12-31', {
    message: 'Date must be between 2000-01-01 and 9999-12-31',
  });

const UsageAggregatesSchema = z.object({
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

export const adminGatewayUsageRouter = createTRPCRouter({
  getDailyUsage: adminProcedure
    .input(
      z.object({
        date: UsageDateSchema,
        model: z.string().trim().min(1).max(256),
      })
    )
    .output(z.array(UsageAggregatesSchema.extend({ date: UsageDateSchema })))
    .query(async ({ input, signal }) => {
      try {
        signal?.throwIfAborted();
        if (process.env.NODE_ENV === 'production' && !usesSeparateReplica) {
          throw new Error('Gateway usage requires a read replica');
        }

        const rows = await timedUsageQuery(
          {
            db: readDb,
            route: 'admin.gatewayUsage.getDailyUsage',
            queryLabel: 'daily_model_usage',
            scope: 'admin',
            period: input.date,
            timeoutMs: 600_000,
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
                AND mu.input_tokens > 0
                AND mu.created_at >= (${input.date}::date::timestamp AT TIME ZONE 'UTC')
                AND mu.created_at < ((${input.date}::date + 1)::timestamp AT TIME ZONE 'UTC')
              GROUP BY mu.provider, meta.is_byok
              ORDER BY mu.provider, meta.is_byok
            `);
            return result.rows;
          }
        );
        return z
          .array(UsageAggregatesSchema)
          .parse(rows)
          .map(row => ({ ...row, date: input.date }));
      } catch {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Gateway usage data temporarily unavailable',
        });
      }
    }),
});
