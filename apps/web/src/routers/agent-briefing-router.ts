import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { baseProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_context_preferences,
  agent_briefing_preferences,
  agent_briefing_snapshots,
  cli_sessions_v2,
} from '@kilocode/db/schema';
import {
  briefingPreferencesSchema,
  briefingReportSchema,
  DEFAULT_BRIEFING_SCHEDULE,
} from '@kilocode/app-shared/agent-briefing';
import {
  briefingContextSettings,
  getBriefingReport,
  getBriefingPreferences,
  listBriefings,
  saveBriefingPreferences,
} from '@/lib/agent-briefing/store';
import { estimateBriefingSummary, verifyBriefingEstimate } from '@/lib/agent-briefing/summary';
import { nextBriefingTime } from '@/lib/agent-briefing/schedule';

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
        enabled: z.boolean(),
        timezone: timezoneSchema.optional(),
        language: z.string().min(1).max(35).optional(),
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
      if (input.enabled) {
        if (!input.estimateToken)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Review the cost estimate before enabling scheduled summaries',
          });
        verifyBriefingEstimate(input.estimateToken, {
          userId: ctx.user.id,
          context: current.context.id,
          model,
          maxSpendMicrodollars,
          maxDurationSeconds,
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
      await db.transaction(async tx => {
        if (input.enabled) {
          const timezone = input.timezone ?? 'UTC';
          await tx
            .insert(agent_briefing_preferences)
            .values({
              kilo_user_id: ctx.user.id,
              timezone,
              language: input.language ?? 'en',
              next_run_at: nextBriefingTime(
                DEFAULT_BRIEFING_SCHEDULE.morningStart,
                timezone,
                new Date()
              ).toISOString(),
            })
            .onConflictDoNothing();
        }
        const values = {
          kilo_user_id: ctx.user.id,
          context_key: current.context.id,
          organization_id: input.organizationId ?? null,
          enabled: input.enabled,
          model,
          max_spend_microdollars: maxSpendMicrodollars,
          max_duration_seconds: maxDurationSeconds,
        };
        await tx
          .insert(agent_briefing_context_preferences)
          .values(values)
          .onConflictDoUpdate({
            target: [
              agent_briefing_context_preferences.kilo_user_id,
              agent_briefing_context_preferences.context_key,
            ],
            set: values,
          });
        if (!input.enabled) {
          await tx
            .update(cli_sessions_v2)
            .set({ briefing_excerpt: null })
            .where(
              and(
                eq(cli_sessions_v2.kilo_user_id, ctx.user.id),
                input.organizationId
                  ? eq(cli_sessions_v2.organization_id, input.organizationId)
                  : isNull(cli_sessions_v2.organization_id)
              )
            );
        }
      });
      return getBriefingPreferences(ctx.user.id);
    }),
  estimateSummary: baseProcedure
    .input(z.object({ organizationId: z.uuid().optional(), ...safeguardInput }))
    .query(({ ctx, input }) => estimateBriefingSummary(ctx.user, input)),
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
    .query(({ ctx, input }) => getBriefingReport(ctx.user.id, input.reportId)),
  read: baseProcedure.input(reportInput).mutation(async ({ ctx, input }) => {
    await getBriefingReport(ctx.user.id, input.reportId);
    await db
      .update(agent_briefing_snapshots)
      .set({ read_at: new Date().toISOString() })
      .where(
        and(
          eq(agent_briefing_snapshots.id, input.reportId),
          eq(agent_briefing_snapshots.kilo_user_id, ctx.user.id)
        )
      );
    return { success: true as const };
  }),
  dismiss: baseProcedure.input(reportInput).mutation(async ({ ctx, input }) => {
    await getBriefingReport(ctx.user.id, input.reportId);
    await db
      .update(agent_briefing_snapshots)
      .set({ dismissed_at: new Date().toISOString() })
      .where(
        and(
          eq(agent_briefing_snapshots.id, input.reportId),
          eq(agent_briefing_snapshots.kilo_user_id, ctx.user.id)
        )
      );
    return { success: true as const };
  }),
});
