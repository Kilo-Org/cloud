import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  security_advisor_check_catalog,
  security_advisor_kiloclaw_coverage,
  security_advisor_content,
} from '@kilocode/db/schema';
import { invalidateSecurityAdvisorContentCache } from '@/lib/security-advisor/content-loader';
import { asc, eq } from 'drizzle-orm';
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
      const existing = await db.query.security_advisor_check_catalog.findFirst({
        where: eq(security_advisor_check_catalog.check_id, input.check_id),
      });

      let row;
      if (existing) {
        const [updated] = await db
          .update(security_advisor_check_catalog)
          .set({
            severity: input.severity,
            explanation: input.explanation,
            risk: input.risk,
            is_active: input.is_active,
          })
          .where(eq(security_advisor_check_catalog.check_id, input.check_id))
          .returning();
        row = updated;
      } else {
        const [inserted] = await db
          .insert(security_advisor_check_catalog)
          .values(input)
          .returning();
        row = inserted;
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
      const existing = await db.query.security_advisor_kiloclaw_coverage.findFirst({
        where: eq(security_advisor_kiloclaw_coverage.area, input.area),
      });

      let row;
      if (existing) {
        const [updated] = await db
          .update(security_advisor_kiloclaw_coverage)
          .set({
            summary: input.summary,
            detail: input.detail,
            match_check_ids: input.match_check_ids,
            is_active: input.is_active,
          })
          .where(eq(security_advisor_kiloclaw_coverage.area, input.area))
          .returning();
        row = updated;
      } else {
        const [inserted] = await db
          .insert(security_advisor_kiloclaw_coverage)
          .values(input)
          .returning();
        row = inserted;
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
      const existing = await db.query.security_advisor_content.findFirst({
        where: eq(security_advisor_content.key, input.key),
      });

      let row;
      if (existing) {
        const [updated] = await db
          .update(security_advisor_content)
          .set({
            value: input.value,
            description: input.description,
            is_active: input.is_active,
          })
          .where(eq(security_advisor_content.key, input.key))
          .returning();
        row = updated;
      } else {
        const [inserted] = await db.insert(security_advisor_content).values(input).returning();
        row = inserted;
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
