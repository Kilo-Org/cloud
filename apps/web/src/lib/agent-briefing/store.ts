import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_preferences,
  agent_briefing_context_preferences,
  agent_briefing_reports,
  cli_sessions_v2,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import {
  briefingReportSchema,
  briefingSummarySchema,
  DEFAULT_BRIEFING_SCHEDULE,
  DEFAULT_BRIEFING_MAX_DURATION_SECONDS,
  DEFAULT_BRIEFING_MAX_SPEND_MICRODOLLARS,
  type BriefingContext,
  type BriefingReport,
  type BriefingPreferences,
} from '@kilocode/app-shared/agent-briefing';
import { collectBriefingEvidence } from './evidence';
import { nextBriefingTime, validateBriefingSchedule } from './schedule';
const DEFAULT_BRIEFING_MODEL = '~deepseek/deepseek-flash-latest';

export type BriefingReportRow = typeof agent_briefing_reports.$inferSelect;
const factsSchema = briefingReportSchema.pick({
  scorecard: true,
  sessions: true,
  sources: true,
  coverage: true,
});
export const emptySummary = {
  status: 'disabled',
  text: null,
  model: null,
  costMicrodollars: 0,
  chargeStatus: 'settled',
  estimatedCostMicrodollars: null,
  startedAt: null,
  finishedAt: null,
  error: null,
  canRetry: false,
} satisfies z.infer<typeof briefingSummarySchema>;
export async function briefingContexts(userId: string): Promise<BriefingContext[]> {
  const rows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      and(
        eq(organization_memberships.organization_id, organizations.id),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .where(
      and(
        isNull(organizations.deleted_at),
        sql`${organization_memberships.role} <> 'billing_manager'`
      )
    );
  return [
    { id: 'personal', organizationId: null, name: 'Personal' },
    ...rows.map(row => ({ id: row.id, organizationId: row.id, name: row.name })),
  ];
}
export async function requireBriefingContext(
  userId: string,
  organizationId?: string | null
): Promise<BriefingContext> {
  const context = (await briefingContexts(userId)).find(
    value => value.organizationId === (organizationId ?? null)
  );
  if (!context)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Briefing context is no longer accessible' });
  return context;
}
export async function getBriefingPreferences(
  userId: string,
  timezone = 'UTC',
  language?: string
): Promise<BriefingPreferences> {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid timezone' });
  }
  await db
    .insert(agent_briefing_preferences)
    .values({
      kilo_user_id: userId,
      timezone,
      language: language ?? 'en',
      next_run_at: nextBriefingTime(
        DEFAULT_BRIEFING_SCHEDULE.nightStart,
        timezone,
        new Date()
      ).toISOString(),
    })
    .onConflictDoNothing();
  if (language !== undefined)
    await db
      .update(agent_briefing_preferences)
      .set({ language })
      .where(eq(agent_briefing_preferences.kilo_user_id, userId));
  const [row] = await db
    .select()
    .from(agent_briefing_preferences)
    .where(eq(agent_briefing_preferences.kilo_user_id, userId));
  if (!row) throw new Error('Briefing preferences unavailable');
  const contexts = await briefingContexts(userId);
  const settings = await db
    .select()
    .from(agent_briefing_context_preferences)
    .where(eq(agent_briefing_context_preferences.kilo_user_id, userId));
  return {
    timezone: row.timezone,
    nightStart: row.night_start,
    morningStart: row.morning_start,
    morningEnd: row.morning_end,
    language: row.language,
    notificationsEnabled: row.notifications_enabled,
    defaultModel: DEFAULT_BRIEFING_MODEL,
    contexts: contexts.map(context => {
      const setting = settings.find(value => value.context_key === context.id);
      return {
        context,
        aiEnabled: setting?.ai_enabled ?? false,
        model: setting?.model ?? DEFAULT_BRIEFING_MODEL,
        maxDurationSeconds: setting?.max_duration_seconds ?? DEFAULT_BRIEFING_MAX_DURATION_SECONDS,
        maxSpendMicrodollars:
          setting?.max_spend_microdollars ?? DEFAULT_BRIEFING_MAX_SPEND_MICRODOLLARS,
      };
    }),
  };
}
export async function saveBriefingPreferences(
  userId: string,
  input: Partial<
    Pick<
      BriefingPreferences,
      | 'timezone'
      | 'nightStart'
      | 'morningStart'
      | 'morningEnd'
      | 'language'
      | 'notificationsEnabled'
    >
  >
) {
  await getBriefingPreferences(userId);
  await db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(agent_briefing_preferences)
      .where(eq(agent_briefing_preferences.kilo_user_id, userId))
      .for('update');
    if (!current) throw new Error('Briefing preferences unavailable');
    const timezone = input.timezone ?? current.timezone;
    const nightStart = input.nightStart ?? current.night_start;
    const morningStart = input.morningStart ?? current.morning_start;
    const morningEnd = input.morningEnd ?? current.morning_end;
    try {
      validateBriefingSchedule({
        timezone,
        night_start: nightStart,
        morning_start: morningStart,
        morning_end: morningEnd,
      });
    } catch (error) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: error instanceof Error ? error.message : 'Invalid schedule',
      });
    }
    const scheduleChanged =
      timezone !== current.timezone ||
      nightStart !== current.night_start ||
      morningStart !== current.morning_start ||
      morningEnd !== current.morning_end;
    await tx
      .update(agent_briefing_preferences)
      .set({
        timezone,
        night_start: nightStart,
        morning_start: morningStart,
        morning_end: morningEnd,
        language: input.language ?? current.language,
        notifications_enabled: input.notificationsEnabled ?? current.notifications_enabled,
        updated_at: new Date().toISOString(),
        ...(scheduleChanged
          ? { next_run_at: nextBriefingTime(nightStart, timezone, new Date()).toISOString() }
          : {}),
      })
      .where(eq(agent_briefing_preferences.kilo_user_id, userId));
  });
  return getBriefingPreferences(userId);
}
export async function briefingContextSettings(userId: string, organizationId?: string | null) {
  const preferences = await getBriefingPreferences(userId);
  const setting = preferences.contexts.find(
    value => value.context.organizationId === (organizationId ?? null)
  );
  if (!setting)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Briefing context is no longer accessible' });
  return setting;
}
export async function briefingReportRow(
  userId: string,
  reportId: string
): Promise<BriefingReportRow> {
  const [row] = await db
    .select()
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.id, reportId),
        eq(agent_briefing_reports.kilo_user_id, userId),
        gte(agent_briefing_reports.cutoff_at, new Date(Date.now() - 30 * 86400_000).toISOString())
      )
    );
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Briefing not found' });
  await requireBriefingContext(userId, row.organization_id);
  const facts = factsSchema.parse(row.facts);
  const sourceSessionIds = [
    ...new Set([
      ...facts.sources.map(source => source.sessionId),
      ...facts.sessions.map(session => session.sessionId),
    ]),
  ];
  if (sourceSessionIds.length) {
    const sessions = await db
      .select({ id: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, userId),
          row.organization_id
            ? eq(cli_sessions_v2.organization_id, row.organization_id)
            : isNull(cli_sessions_v2.organization_id),
          inArray(cli_sessions_v2.session_id, sourceSessionIds)
        )
      );
    if (sessions.length !== sourceSessionIds.length) {
      const refreshed = await refreshBriefingEvidence(row);
      if (factsSchema.parse(refreshed.facts).scorecard.sessions === 0) {
        await db.delete(agent_briefing_reports).where(eq(agent_briefing_reports.id, row.id));
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Briefing sources were removed' });
      }
      const [sanitized] = await db
        .update(agent_briefing_reports)
        .set({
          summary: sql`${agent_briefing_reports.summary} || '{"status":"outdated","text":null,"canRetry":false}'::jsonb`,
        })
        .where(eq(agent_briefing_reports.id, row.id))
        .returning();
      if (!sanitized) throw new TRPCError({ code: 'NOT_FOUND', message: 'Briefing not found' });
      return sanitized;
    }
  }
  return row;
}
export async function serializeBriefing(row: BriefingReportRow): Promise<BriefingReport> {
  const context = await requireBriefingContext(row.kilo_user_id, row.organization_id);
  const iso = (value: string) => new Date(value).toISOString();
  return briefingReportSchema.parse({
    id: row.id,
    context,
    localDate: row.local_date,
    nightStartAt: iso(row.night_start_at),
    cutoffAt: iso(row.cutoff_at),
    morningEndAt: iso(row.morning_end_at),
    publishedAt: row.published_at ? iso(row.published_at) : null,
    updatedAt: iso(row.updated_at),
    revision: row.revision,
    revised: row.revision > 1,
    readAt: row.read_at ? iso(row.read_at) : null,
    dismissedAt: row.dismissed_at ? iso(row.dismissed_at) : null,
    ...factsSchema.parse(row.facts),
    summary: row.summary,
    expiresAt: iso(row.morning_end_at),
  });
}
export async function listBriefings(
  userId: string,
  input: {
    scope?: 'all' | 'personal' | 'organization';
    organizationId?: string;
    cursor?: string;
    limit?: number;
    currentOnly?: boolean;
  } = {}
) {
  const contexts = await briefingContexts(userId);
  if (input.organizationId) await requireBriefingContext(userId, input.organizationId);
  const now = new Date().toISOString();
  const limit = input.limit ?? 30;
  const scopeFilter =
    input.scope === 'personal'
      ? isNull(agent_briefing_reports.organization_id)
      : input.organizationId
        ? eq(agent_briefing_reports.organization_id, input.organizationId)
        : undefined;
  const rows = await db
    .select()
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.kilo_user_id, userId),
        inArray(
          agent_briefing_reports.context_key,
          contexts.map(context => context.id)
        ),
        scopeFilter,
        isNotNull(agent_briefing_reports.published_at),
        gte(agent_briefing_reports.cutoff_at, new Date(Date.now() - 30 * 86400_000).toISOString()),
        input.currentOnly ? gt(agent_briefing_reports.morning_end_at, now) : undefined,
        input.cursor
          ? sql`(${agent_briefing_reports.cutoff_at}, ${agent_briefing_reports.id}) < (SELECT cutoff_at, id FROM agent_briefing_reports WHERE id = ${input.cursor} AND kilo_user_id = ${userId})`
          : undefined
      )
    )
    .orderBy(desc(agent_briefing_reports.cutoff_at), desc(agent_briefing_reports.id))
    .limit(limit + 1);
  const reports: BriefingReport[] = [];
  for (const row of rows.slice(0, limit)) {
    try {
      reports.push(await serializeBriefing(await briefingReportRow(userId, row.id)));
    } catch (error) {
      if (!(error instanceof TRPCError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)))
        throw error;
    }
  }
  return { reports, nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null };
}
export async function refreshBriefingEvidence(row: BriefingReportRow): Promise<BriefingReportRow> {
  const facts = await collectBriefingEvidence(
    row.kilo_user_id,
    row.organization_id,
    new Date(row.night_start_at).toISOString(),
    new Date(row.cutoff_at).toISOString(),
    new Date(row.morning_end_at).toISOString()
  );
  const hash = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
  return db.transaction(async tx => {
    const [current] = await tx
      .select()
      .from(agent_briefing_reports)
      .where(eq(agent_briefing_reports.id, row.id))
      .for('update');
    if (!current || hash === current.evidence_hash) return current ?? row;
    const summary = briefingSummarySchema.parse(current.summary);
    const previousFacts = factsSchema.parse(current.facts);
    const sourcesById = new Map(facts.sources.map(source => [source.id, source]));
    const sessionIds = new Set(facts.sessions.map(session => session.sessionId));
    const removedSource =
      previousFacts.sessions.some(session => !sessionIds.has(session.sessionId)) ||
      previousFacts.sources.some(source => {
        const next = sourcesById.get(source.id);
        return (
          next === undefined || (source.excerpt !== undefined && source.excerpt !== next.excerpt)
        );
      });
    const [updated] = await tx
      .update(agent_briefing_reports)
      .set({
        facts,
        evidence_hash: hash,
        revision: current.revision + 1,
        updated_at: new Date().toISOString(),
        summary: {
          ...current.summary,
          ...summary,
          ...(removedSource
            ? { status: 'outdated', text: null, canRetry: false }
            : summary.text !== null
              ? { status: 'outdated' }
              : {}),
        },
      })
      .where(eq(agent_briefing_reports.id, row.id))
      .returning();
    return updated ?? current;
  });
}
