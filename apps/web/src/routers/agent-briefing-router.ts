import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { after } from 'next/server';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { agent_briefing_context_preferences, agent_briefing_reports } from '@kilocode/db/schema';
import {
  briefingPreferencesSchema,
  briefingReportSchema,
  briefingEstimateSchema,
} from '@kilocode/app-shared/agent-briefing';
import {
  briefingContextSettings,
  briefingReportRow,
  getBriefingPreferences,
  getOneOffBriefingPreferences,
  listBriefings,
  prepareOneOffBriefing,
  saveBriefingPreferences,
  serializeBriefing,
} from '@/lib/agent-briefing/store';
import {
  estimateBriefingSummary,
  createOneOffBriefing,
  queueBriefingSummary,
  reconcileBriefingCharge,
  verifyBriefingEstimate,
  runBriefingSummary,
} from '@/lib/agent-briefing/summary';

const timezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(value => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
      return true;
    } catch {
      return false;
    }
  }, 'Invalid timezone');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const reportInput = z.object({ reportId: z.uuid() });
const safeguardInput = {
  model: z.string().min(1).max(200).optional(),
  maxSpendMicrodollars: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  maxDurationSeconds: z.number().int().min(1).max(600).optional(),
};
export const agentBriefingRouter = createTRPCRouter({
  preferences: baseProcedure
    .input(
      z
        .object({
          timezone: timezoneSchema.optional(),
          language: z.string().min(1).max(35).optional(),
        })
        .optional()
    )
    .output(briefingPreferencesSchema)
    .query(({ ctx, input }) =>
      getBriefingPreferences(ctx.user.id, input?.timezone, input?.language)
    ),
  oneOffPreferences: baseProcedure
    .input(
      z
        .object({
          timezone: timezoneSchema.optional(),
          language: z.string().min(1).max(35).optional(),
        })
        .optional()
    )
    .output(briefingPreferencesSchema)
    .query(({ ctx, input }) =>
      getOneOffBriefingPreferences(ctx.user.id, input?.timezone, input?.language)
    ),
  updatePreferences: baseProcedure
    .input(
      z.object({
        timezone: timezoneSchema.optional(),
        language: z.string().min(1).max(35).optional(),
        nightStart: timeSchema.optional(),
        morningStart: timeSchema.optional(),
        morningEnd: timeSchema.optional(),
        notificationsEnabled: z.boolean().optional(),
      })
    )
    .output(briefingPreferencesSchema)
    .mutation(({ ctx, input }) => saveBriefingPreferences(ctx.user.id, input)),
  updateContextPreferences: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        aiEnabled: z.boolean(),
        ...safeguardInput,
        estimateToken: z.string().optional(),
      })
    )
    .output(briefingPreferencesSchema)
    .mutation(async ({ ctx, input }) => {
      const current = await briefingContextSettings(ctx.user.id, input.organizationId);
      const model = input.model ?? current.model;
      const maxSpendMicrodollars = input.maxSpendMicrodollars ?? current.maxSpendMicrodollars;
      const maxDurationSeconds = input.maxDurationSeconds ?? current.maxDurationSeconds;
      if (input.aiEnabled) {
        if (!input.estimateToken)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Review the cost estimate before enabling AI',
          });
        verifyBriefingEstimate(input.estimateToken, {
          userId: ctx.user.id,
          context: current.context.id,
          model,
          maxSpendMicrodollars,
          maxDurationSeconds,
          reportId: null,
          revision: null,
          priorCost: 0,
        });
        const estimate = await estimateBriefingSummary(ctx.user, {
          organizationId: input.organizationId,
          model,
          maxSpendMicrodollars,
          maxDurationSeconds,
        });
        if (!estimate.canGenerate)
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: estimate.unavailableReason ?? 'Summary unavailable',
          });
      }
      const values = {
        kilo_user_id: ctx.user.id,
        context_key: current.context.id,
        organization_id: input.organizationId ?? null,
        ai_enabled: input.aiEnabled,
        model,
        max_spend_microdollars: maxSpendMicrodollars,
        max_duration_seconds: maxDurationSeconds,
      };
      await db
        .insert(agent_briefing_context_preferences)
        .values(values)
        .onConflictDoUpdate({
          target: [
            agent_briefing_context_preferences.kilo_user_id,
            agent_briefing_context_preferences.context_key,
          ],
          set: values,
        });
      return getBriefingPreferences(ctx.user.id);
    }),
  estimateSummary: baseProcedure
    .input(
      z.object({
        organizationId: z.uuid().optional(),
        ...safeguardInput,
        reportId: z.uuid().optional(),
      })
    )
    .query(({ ctx, input }) => estimateBriefingSummary(ctx.user, input)),
  prepareOneOff: baseProcedure
    .input(
      z.object({
        requestId: z.uuid(),
        organizationId: z.uuid().optional(),
        startAt: z.string().datetime({ offset: true }),
        endAt: z.string().datetime({ offset: true }),
        timezone: timezoneSchema,
        language: z.string().min(1).max(35),
      })
    )
    .output(z.object({ report: briefingReportSchema, estimate: briefingEstimateSchema.nullable() }))
    .mutation(async ({ ctx, input }) => {
      const row = await prepareOneOffBriefing(ctx.user.id, input);
      const report = await serializeBriefing(row);
      const estimate =
        report.scorecard.sessions === 0
          ? null
          : await estimateBriefingSummary(ctx.user, {
              organizationId: input.organizationId,
              reportId: report.id,
            });
      return { report, estimate };
    }),
  createOneOff: baseProcedure
    .input(reportInput.extend({ estimateToken: z.string().optional() }))
    .output(briefingReportSchema)
    .mutation(async ({ ctx, input }) => {
      const report = await createOneOffBriefing(ctx.user, input.reportId, input.estimateToken);
      if (report.summary.status === 'pending') after(() => runBriefingSummary(report.id));
      return report;
    }),
  list: baseProcedure
    .input(
      z
        .object({
          scope: z.enum(['all', 'personal', 'organization']).optional(),
          organizationId: z.uuid().optional(),
          cursor: z.uuid().optional(),
          limit: z.number().int().min(1).max(100).optional(),
          currentOnly: z.boolean().optional(),
        })
        .refine(
          value => value.scope !== 'organization' || value.organizationId !== undefined,
          'Organization scope requires organizationId'
        )
        .optional()
    )
    .output(z.object({ reports: z.array(briefingReportSchema), nextCursor: z.string().nullable() }))
    .query(({ ctx, input }) => listBriefings(ctx.user.id, input)),
  get: baseProcedure
    .input(reportInput)
    .output(briefingReportSchema)
    .query(async ({ ctx, input }) =>
      serializeBriefing(
        await reconcileBriefingCharge(await briefingReportRow(ctx.user.id, input.reportId))
      )
    ),
  read: baseProcedure.input(reportInput).mutation(async ({ ctx, input }) => {
    await briefingReportRow(ctx.user.id, input.reportId);
    await db
      .update(agent_briefing_reports)
      .set({ read_at: new Date().toISOString() })
      .where(
        and(
          eq(agent_briefing_reports.id, input.reportId),
          eq(agent_briefing_reports.kilo_user_id, ctx.user.id)
        )
      );
    return { success: true as const };
  }),
  dismiss: baseProcedure.input(reportInput).mutation(async ({ ctx, input }) => {
    await briefingReportRow(ctx.user.id, input.reportId);
    await db
      .update(agent_briefing_reports)
      .set({ dismissed_at: new Date().toISOString() })
      .where(
        and(
          eq(agent_briefing_reports.id, input.reportId),
          eq(agent_briefing_reports.kilo_user_id, ctx.user.id)
        )
      );
    return { success: true as const };
  }),
  generateSummary: baseProcedure
    .input(reportInput.extend({ estimateToken: z.string() }))
    .output(briefingReportSchema)
    .mutation(async ({ ctx, input }) => {
      const report = await queueBriefingSummary(
        ctx.user,
        input.reportId,
        input.estimateToken,
        false
      );
      if (report.kind === 'one_off' && report.summary.status === 'pending')
        after(() => runBriefingSummary(report.id));
      return report;
    }),
  retrySummary: baseProcedure
    .input(reportInput.extend({ estimateToken: z.string() }))
    .output(briefingReportSchema)
    .mutation(async ({ ctx, input }) => {
      const report = await queueBriefingSummary(
        ctx.user,
        input.reportId,
        input.estimateToken,
        true
      );
      if (report.kind === 'one_off' && report.summary.status === 'pending')
        after(() => runBriefingSummary(report.id));
      return report;
    }),
});
