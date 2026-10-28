import { enkrypt_guardrail_charges, kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { desc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';

const ListInputSchema = z.object({
  organizationId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(1000).default(200),
});

export const adminEnkryptGuardrailChargesRouter = createTRPCRouter({
  list: adminProcedure.input(ListInputSchema).query(async ({ input }) => {
    const where = input.organizationId
      ? eq(enkrypt_guardrail_charges.organization_id, input.organizationId)
      : undefined;

    const [rows, [summary]] = await Promise.all([
      db
        .select({
          id: enkrypt_guardrail_charges.id,
          organization_id: enkrypt_guardrail_charges.organization_id,
          organization_name: organizations.name,
          kilo_user_id: enkrypt_guardrail_charges.kilo_user_id,
          user_email: kilocode_users.google_user_email,
          session_id: enkrypt_guardrail_charges.session_id,
          api_kind: enkrypt_guardrail_charges.api_kind,
          decision: enkrypt_guardrail_charges.decision,
          enkrypt_credits_cost: enkrypt_guardrail_charges.enkrypt_credits_cost,
          charged_microdollars: enkrypt_guardrail_charges.charged_microdollars,
          added_latency_ms: enkrypt_guardrail_charges.added_latency_ms,
          created_at: enkrypt_guardrail_charges.created_at,
        })
        .from(enkrypt_guardrail_charges)
        .leftJoin(organizations, eq(organizations.id, enkrypt_guardrail_charges.organization_id))
        .leftJoin(kilocode_users, eq(kilocode_users.id, enkrypt_guardrail_charges.kilo_user_id))
        .where(where)
        .orderBy(desc(enkrypt_guardrail_charges.created_at))
        .limit(input.limit),
      db
        .select({
          total_calls: sql<number>`count(*)::int`,
          allowed: sql<number>`count(*) filter (where ${enkrypt_guardrail_charges.decision} = 'allowed')::int`,
          blocked: sql<number>`count(*) filter (where ${enkrypt_guardrail_charges.decision} = 'blocked')::int`,
          errors: sql<number>`count(*) filter (where ${enkrypt_guardrail_charges.decision} = 'error')::int`,
          total_credits: sql<number>`coalesce(sum(${enkrypt_guardrail_charges.enkrypt_credits_cost}), 0)::float8`,
          total_charged_microdollars: sql<number>`coalesce(sum(${enkrypt_guardrail_charges.charged_microdollars}), 0)::float8`,
          avg_added_latency_ms: sql<
            number | null
          >`avg(${enkrypt_guardrail_charges.added_latency_ms})::float8`,
          organizations: sql<number>`count(distinct ${enkrypt_guardrail_charges.organization_id})::int`,
        })
        .from(enkrypt_guardrail_charges)
        .where(where),
    ]);

    return {
      rows: rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() })),
      summary,
    };
  }),
});
