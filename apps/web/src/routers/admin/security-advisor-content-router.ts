import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  security_advisor_check_catalog,
  security_advisor_kiloclaw_coverage,
  security_advisor_content,
} from '@kilocode/db/schema';
import { invalidateSecurityAdvisorContentCache } from '@/lib/security-advisor/content-loader';
import { and, arrayOverlaps, asc, eq, ne } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

const SeveritySchema = z.enum(['critical', 'warn', 'info']);

const UpsertCheckSchema = z.object({
  check_id: z.string().min(1).max(200),
  severity: SeveritySchema,
  explanation: z.string().min(1).max(4000),
  risk: z.string().min(1).max(4000),
  is_active: z.boolean().default(true),
});

const UpsertCoverageSchema = z.object({
  area: z.string().min(1).max(100),
  summary: z.string().min(1).max(2000),
  detail: z.string().min(1).max(4000),
  match_check_ids: z.array(z.string().min(1).max(200)).default([]),
  is_active: z.boolean().default(true),
});

const UpsertContentSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().min(1).max(4000),
  description: z.string().max(2000).default(''),
  is_active: z.boolean().default(true),
});

const DeleteByIdSchema = z.object({ id: z.string().uuid() });

// Explicit timestamp for DO UPDATE SET on conflict-update paths — the
// $onUpdateFn defined on the schema only fires for Drizzle ORM update()
// calls, not for the DO UPDATE SET branch of INSERT ... ON CONFLICT.
function nowIso(): string {
  return new Date().toISOString();
}

export const adminSecurityAdvisorContentRouter = createTRPCRouter({
  // ---- Check catalog ----
  checkCatalog: createTRPCRouter({
    list: adminProcedure.query(async () => {
      const rows = await db
        .select()
        .from(security_advisor_check_catalog)
        .orderBy(asc(security_advisor_check_catalog.check_id));
      return { items: rows };
    }),

    upsert: adminProcedure.input(UpsertCheckSchema).mutation(async ({ input }) => {
      // Atomic upsert keyed on check_id — avoids the TOCTOU race between two
      // concurrent admin saves for the same check_id (a read-then-write
      // pattern would have both branches see "no existing row" and both try
      // to insert).
      //
      // By design, `check_id` is the natural key: creating a record with an
      // existing check_id overwrites it, and there is no separate `id`-based
      // rename path. The admin UI disables the check_id input in edit mode,
      // so the only way to "rename" a check via this endpoint is to create
      // a new one and delete the old. Keep in mind if the endpoint grows
      // non-admin callers.
      const [row] = await db
        .insert(security_advisor_check_catalog)
        .values(input)
        .onConflictDoUpdate({
          target: security_advisor_check_catalog.check_id,
          set: {
            severity: input.severity,
            explanation: input.explanation,
            risk: input.risk,
            is_active: input.is_active,
            updated_at: nowIso(),
          },
        })
        .returning();

      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to upsert check catalog entry',
        });
      }

      invalidateSecurityAdvisorContentCache();
      return row;
    }),

    delete: adminProcedure.input(DeleteByIdSchema).mutation(async ({ input }) => {
      const result = await db
        .delete(security_advisor_check_catalog)
        .where(eq(security_advisor_check_catalog.id, input.id));

      if ((result.rowCount ?? 0) === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Check not found' });
      }

      invalidateSecurityAdvisorContentCache();
      return { success: true };
    }),
  }),

  // ---- KiloClaw coverage ----
  kiloclawCoverage: createTRPCRouter({
    list: adminProcedure.query(async () => {
      const rows = await db
        .select()
        .from(security_advisor_kiloclaw_coverage)
        .orderBy(asc(security_advisor_kiloclaw_coverage.area));
      return { items: rows };
    }),

    upsert: adminProcedure.input(UpsertCoverageSchema).mutation(async ({ input }) => {
      // Best-effort UX validation: reject if any incoming checkId is already
      // claimed by a different active coverage row. The load-side
      // `findCoverageForCheckId` already picks deterministically when
      // overlaps exist, but overlaps make the report content confusing to
      // edit, so catch the mistake at save time. Uses PostgreSQL array-
      // overlap (&&) for a single indexed query rather than N per-checkId
      // lookups.
      //
      // NOTE: This is a read-then-write check with a TOCTOU window — two
      // concurrent admin saves for different areas that each introduce an
      // overlap the other is about to introduce can both pass and both
      // land. The load-side deterministic pick still keeps the report
      // coherent; this check is a UX guardrail, not a DB-enforced
      // invariant. Acceptable given admin-UI concurrency is low.
      if (input.is_active && input.match_check_ids.length > 0) {
        const conflicting = await db
          .select({
            area: security_advisor_kiloclaw_coverage.area,
            match_check_ids: security_advisor_kiloclaw_coverage.match_check_ids,
          })
          .from(security_advisor_kiloclaw_coverage)
          .where(
            and(
              eq(security_advisor_kiloclaw_coverage.is_active, true),
              ne(security_advisor_kiloclaw_coverage.area, input.area),
              // Native Drizzle helper — binds the JS array as a single PG
              // `text[]` parameter. Hand-rolling this as raw SQL with
              // `${arr}::text[]` serializes as a tuple `($1, $2, $3)` which
              // `&&` rejects with a syntax error.
              arrayOverlaps(
                security_advisor_kiloclaw_coverage.match_check_ids,
                input.match_check_ids
              )
            )
          );
        if (conflicting.length > 0) {
          const overlaps = conflicting
            .map(c => {
              const shared = c.match_check_ids.filter(id => input.match_check_ids.includes(id));
              return `"${c.area}" (shares: ${shared.join(', ')})`;
            })
            .join('; ');
          throw new TRPCError({
            code: 'CONFLICT',
            message: `One or more checkIds are already covered by another active area: ${overlaps}. Remove them from the other area first, or deactivate it.`,
          });
        }
      }

      const [row] = await db
        .insert(security_advisor_kiloclaw_coverage)
        .values(input)
        .onConflictDoUpdate({
          target: security_advisor_kiloclaw_coverage.area,
          set: {
            summary: input.summary,
            detail: input.detail,
            match_check_ids: input.match_check_ids,
            is_active: input.is_active,
            updated_at: nowIso(),
          },
        })
        .returning();

      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to upsert KiloClaw coverage entry',
        });
      }

      invalidateSecurityAdvisorContentCache();
      return row;
    }),

    delete: adminProcedure.input(DeleteByIdSchema).mutation(async ({ input }) => {
      const result = await db
        .delete(security_advisor_kiloclaw_coverage)
        .where(eq(security_advisor_kiloclaw_coverage.id, input.id));

      if ((result.rowCount ?? 0) === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'KiloClaw coverage entry not found' });
      }

      invalidateSecurityAdvisorContentCache();
      return { success: true };
    }),
  }),

  // ---- Content key-value store ----
  content: createTRPCRouter({
    list: adminProcedure.query(async () => {
      const rows = await db
        .select()
        .from(security_advisor_content)
        .orderBy(asc(security_advisor_content.key));
      return { items: rows };
    }),

    upsert: adminProcedure.input(UpsertContentSchema).mutation(async ({ input }) => {
      const [row] = await db
        .insert(security_advisor_content)
        .values(input)
        .onConflictDoUpdate({
          target: security_advisor_content.key,
          set: {
            value: input.value,
            description: input.description,
            is_active: input.is_active,
            updated_at: nowIso(),
          },
        })
        .returning();

      if (!row) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to upsert content entry',
        });
      }

      invalidateSecurityAdvisorContentCache();
      return row;
    }),

    delete: adminProcedure.input(DeleteByIdSchema).mutation(async ({ input }) => {
      const result = await db
        .delete(security_advisor_content)
        .where(eq(security_advisor_content.id, input.id));

      if ((result.rowCount ?? 0) === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Content key not found' });
      }

      invalidateSecurityAdvisorContentCache();
      return { success: true };
    }),
  }),
});
