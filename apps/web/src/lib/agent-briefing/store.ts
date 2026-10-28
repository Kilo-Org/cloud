import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import type { z } from 'zod';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_preferences,
  agent_briefing_context_preferences,
  agent_briefing_snapshots,
  cli_sessions_v2,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import {
  briefingReportSchema,
  type briefingSummarySchema,
  DEFAULT_BRIEFING_SCHEDULE,
  DEFAULT_BRIEFING_MAX_DURATION_SECONDS,
  DEFAULT_BRIEFING_MAX_SPEND_MICRODOLLARS,
  type BriefingContext,
  type BriefingPreferences,
  type BriefingReport,
} from '@kilocode/app-shared/agent-briefing';
import { briefingFactsSchema } from './evidence';
import { nextBriefingTime, validateBriefingSchedule } from './schedule';
const DEFAULT_BRIEFING_MODEL = '~deepseek/deepseek-flash-latest';
export type BriefingReportRow = typeof agent_briefing_snapshots.$inferSelect;
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
  language = 'en'
): Promise<BriefingPreferences> {
  const [row] = await db
    .select()
    .from(agent_briefing_preferences)
    .where(eq(agent_briefing_preferences.kilo_user_id, userId));
  const contexts = await briefingContexts(userId);
  const settings = await db
    .select()
    .from(agent_briefing_context_preferences)
    .where(eq(agent_briefing_context_preferences.kilo_user_id, userId));
  return {
    timezone: row?.timezone ?? timezone,
    nightStart: row?.night_start ?? DEFAULT_BRIEFING_SCHEDULE.nightStart,
    morningStart: row?.morning_start ?? DEFAULT_BRIEFING_SCHEDULE.morningStart,
    morningEnd: row?.morning_end ?? DEFAULT_BRIEFING_SCHEDULE.morningEnd,
    language: row?.language ?? language,
    notificationsEnabled: row?.notifications_enabled ?? false,
    defaultModel: DEFAULT_BRIEFING_MODEL,
    contexts: contexts.map(context => {
      const setting = settings.find(value => value.context_key === context.id);
      return {
        context,
        enabled: setting?.enabled ?? false,
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
  await db.transaction(async tx => {
    await tx
      .insert(agent_briefing_preferences)
      .values({
        kilo_user_id: userId,
        timezone: input.timezone ?? 'UTC',
        next_run_at: nextBriefingTime(
          input.morningStart ?? DEFAULT_BRIEFING_SCHEDULE.morningStart,
          input.timezone ?? 'UTC',
          new Date()
        ).toISOString(),
      })
      .onConflictDoNothing();
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
      morningStart !== current.morning_start ||
      nightStart !== current.night_start ||
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
          ? { next_run_at: nextBriefingTime(morningStart, timezone, new Date()).toISOString() }
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
type BriefingFacts = z.infer<typeof briefingFactsSchema>;
type SourceSession = Pick<
  typeof cli_sessions_v2.$inferSelect,
  'session_id' | 'organization_id' | 'briefing_excerpt_scope_changed_at'
>;

function briefingSourceIds(facts: BriefingFacts): string[] {
  return [
    ...new Set([
      ...facts.sessions.map(session => session.sessionId),
      ...facts.sources.map(source => source.sessionId),
      ...facts.sessions.flatMap(session => session.sources.map(source => source.sessionId)),
    ]),
  ];
}

async function sourceSessionsById(
  userId: string,
  ids: string[]
): Promise<Map<string, SourceSession>> {
  if (!ids.length) return new Map();
  const sessions = await db
    .select({
      session_id: cli_sessions_v2.session_id,
      organization_id: cli_sessions_v2.organization_id,
      briefing_excerpt_scope_changed_at: cli_sessions_v2.briefing_excerpt_scope_changed_at,
    })
    .from(cli_sessions_v2)
    .where(and(eq(cli_sessions_v2.kilo_user_id, userId), inArray(cli_sessions_v2.session_id, ids)));
  return new Map(sessions.map(session => [session.session_id, session]));
}

function sourcesRemainAccessible(
  row: BriefingReportRow,
  ids: string[],
  sessions: Map<string, SourceSession>
): boolean {
  const capturedAt = Date.parse(row.captured_at);
  return ids.every(id => {
    const session = sessions.get(id);
    return (
      session !== undefined &&
      session.organization_id === row.organization_id &&
      (session.briefing_excerpt_scope_changed_at === null ||
        Date.parse(session.briefing_excerpt_scope_changed_at) <= capturedAt)
    );
  });
}

export async function assertBriefingSourcesAccessible(row: BriefingReportRow) {
  const context = await requireBriefingContext(row.kilo_user_id, row.organization_id);
  if (context.id !== row.context_key)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Briefing context is no longer accessible' });
  const facts = briefingFactsSchema.parse(row.facts);
  const ids = briefingSourceIds(facts);
  const sessions = await sourceSessionsById(row.kilo_user_id, ids);
  if (!sourcesRemainAccessible(row, ids, sessions))
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Briefing sources are no longer accessible',
    });
  return { context, facts };
}

export async function getBriefingReport(userId: string, reportId: string): Promise<BriefingReport> {
  const [row] = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(
      and(
        eq(agent_briefing_snapshots.id, reportId),
        eq(agent_briefing_snapshots.kilo_user_id, userId),
        gt(agent_briefing_snapshots.expires_at, new Date().toISOString()),
        isNotNull(agent_briefing_snapshots.published_at)
      )
    );
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Briefing not found' });
  const { context, facts } = await assertBriefingSourcesAccessible(row);
  return serializeBriefing(row, context, facts);
}

function serializeBriefing(
  row: BriefingReportRow,
  context: BriefingContext,
  facts: BriefingFacts
): BriefingReport {
  const iso = (value: string) => new Date(value).toISOString();
  return briefingReportSchema.parse({
    id: row.id,
    createdAt: iso(row.created_at),
    capturedAt: iso(row.captured_at),
    timezone: row.timezone,
    context,
    localDate: row.local_date,
    nightStartAt: iso(row.night_start_at),
    cutoffAt: iso(row.cutoff_at),
    morningEndAt: iso(row.morning_end_at),
    publishedAt: row.published_at ? iso(row.published_at) : null,
    updatedAt: iso(row.updated_at),
    readAt: row.read_at ? iso(row.read_at) : null,
    dismissedAt: row.dismissed_at ? iso(row.dismissed_at) : null,
    ...facts,
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
  const contexts = new Map((await briefingContexts(userId)).map(context => [context.id, context]));
  if (input.organizationId && !contexts.has(input.organizationId))
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Briefing context is no longer accessible' });
  const now = new Date().toISOString();
  const limit = Math.max(1, Math.min(30, Math.trunc(input.limit ?? 20)));
  const rows = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(
      and(
        eq(agent_briefing_snapshots.kilo_user_id, userId),
        inArray(agent_briefing_snapshots.context_key, [...contexts.keys()]),
        input.scope === 'personal'
          ? isNull(agent_briefing_snapshots.organization_id)
          : input.organizationId
            ? eq(agent_briefing_snapshots.organization_id, input.organizationId)
            : undefined,
        isNotNull(agent_briefing_snapshots.published_at),
        gt(agent_briefing_snapshots.expires_at, now),
        input.currentOnly
          ? and(
              gt(agent_briefing_snapshots.morning_end_at, now),
              isNull(agent_briefing_snapshots.dismissed_at),
              sql`(${agent_briefing_snapshots.facts}->'scorecard'->>'sessions')::int > 0`
            )
          : undefined,
        input.cursor
          ? sql`(${agent_briefing_snapshots.cutoff_at}, ${agent_briefing_snapshots.id}) < (SELECT cutoff_at, id FROM agent_briefing_snapshots WHERE id = ${input.cursor} AND kilo_user_id = ${userId})`
          : undefined
      )
    )
    .orderBy(desc(agent_briefing_snapshots.cutoff_at), desc(agent_briefing_snapshots.id))
    .limit(limit + 1);
  const candidates = rows.slice(0, limit).map(row => {
    const facts = briefingFactsSchema.parse(row.facts);
    return { row, facts, ids: briefingSourceIds(facts) };
  });
  const ids = [...new Set(candidates.flatMap(candidate => candidate.ids))];
  const sessions = await sourceSessionsById(userId, ids);
  const reports: BriefingReport[] = [];
  for (const candidate of candidates) {
    const context = contexts.get(candidate.row.context_key);
    if (
      !context ||
      context.organizationId !== candidate.row.organization_id ||
      !sourcesRemainAccessible(candidate.row, candidate.ids, sessions)
    )
      continue;
    reports.push(serializeBriefing(candidate.row, context, candidate.facts));
  }
  return { reports, nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null };
}
