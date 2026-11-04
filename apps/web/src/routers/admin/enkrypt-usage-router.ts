import {
  api_kind,
  enkrypt_usage,
  enkrypt_usage_decision,
  enkrypt_usage_guardrail,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import * as z from 'zod';
import type { EnkryptGuardrailDirection } from '@kilocode/db/schema-types';

const ENKRYPT_USAGE_WINDOW_DAYS = 30;

/** Rows recorded before the output guardrail existed have no guardrail and are input calls. */
const guardrail = sql<EnkryptGuardrailDirection>`coalesce(${enkrypt_usage_guardrail.guardrail}, 'input')`;

const ListInputSchema = z.object({
  organizationId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});

export const adminEnkryptUsageRouter = createTRPCRouter({
  list: adminProcedure.input(ListInputSchema).query(async ({ input }) => {
    const where = and(
      gte(
        enkrypt_usage.created_at,
        sql`now() - make_interval(days => ${ENKRYPT_USAGE_WINDOW_DAYS})`
      ),
      input.organizationId ? eq(enkrypt_usage.organization_id, input.organizationId) : undefined
    );

    const [rows, [summary]] = await Promise.all([
      db
        .select({
          id: enkrypt_usage.id,
          organization_id: enkrypt_usage.organization_id,
          organization_name: organizations.name,
          kilo_user_id: enkrypt_usage.kilo_user_id,
          user_email: kilocode_users.google_user_email,
          session_id: enkrypt_usage.session_id,
          api_kind: api_kind.api_kind,
          decision: enkrypt_usage_decision.decision,
          enkrypt_credits_cost: enkrypt_usage.enkrypt_credits_cost,
          charged_microdollars: enkrypt_usage.charged_microdollars,
          added_latency_ms: enkrypt_usage.added_latency_ms,
          guardrail,
          created_at: enkrypt_usage.created_at,
        })
        .from(enkrypt_usage)
        .innerJoin(api_kind, eq(api_kind.api_kind_id, enkrypt_usage.api_kind_id))
        .innerJoin(
          enkrypt_usage_decision,
          eq(enkrypt_usage_decision.decision_id, enkrypt_usage.decision_id)
        )
        .leftJoin(
          enkrypt_usage_guardrail,
          eq(enkrypt_usage_guardrail.guardrail_id, enkrypt_usage.guardrail_id)
        )
        .leftJoin(organizations, eq(organizations.id, enkrypt_usage.organization_id))
        .leftJoin(kilocode_users, eq(kilocode_users.id, enkrypt_usage.kilo_user_id))
        .where(where)
        .orderBy(desc(enkrypt_usage.created_at))
        .limit(input.limit),
      db
        .select({
          total_calls: sql<number>`count(*)::int`,
          allowed: sql<number>`count(*) filter (where ${enkrypt_usage_decision.decision} = 'allowed')::int`,
          blocked: sql<number>`count(*) filter (where ${enkrypt_usage_decision.decision} = 'blocked')::int`,
          errors: sql<number>`count(*) filter (where ${enkrypt_usage_decision.decision} = 'error')::int`,
          total_credits: sql<number>`coalesce(sum(${enkrypt_usage.enkrypt_credits_cost}), 0)::float8`,
          total_charged_microdollars: sql<number>`coalesce(sum(${enkrypt_usage.charged_microdollars}), 0)::float8`,
          avg_added_latency_ms: sql<
            number | null
          >`(avg(${enkrypt_usage.added_latency_ms}) filter (where ${guardrail} = 'input'))::float8`,
          avg_output_added_latency_ms: sql<
            number | null
          >`(avg(${enkrypt_usage.added_latency_ms}) filter (where ${guardrail} = 'output'))::float8`,
          organizations: sql<number>`count(distinct ${enkrypt_usage.organization_id})::int`,
        })
        .from(enkrypt_usage)
        .innerJoin(
          enkrypt_usage_decision,
          eq(enkrypt_usage_decision.decision_id, enkrypt_usage.decision_id)
        )
        .leftJoin(
          enkrypt_usage_guardrail,
          eq(enkrypt_usage_guardrail.guardrail_id, enkrypt_usage.guardrail_id)
        )
        .where(where),
    ]);

    return {
      rows: rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
      summary,
    };
  }),
});
