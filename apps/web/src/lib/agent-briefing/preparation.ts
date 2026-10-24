import { createHash } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { withDeadline, RequestDeadlineError } from '@kilocode/event-service';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { agent_briefing_reports } from '@kilocode/db/schema';
import { briefingContextSchema } from '@kilocode/app-shared/agent-briefing';
import { collectBriefingEvidence } from './evidence';
import {
  briefingContexts,
  emptySummary,
  requireBriefingContext,
  type BriefingReportRow,
} from './store';

const PREPARATION_TIMEOUT_MS = 120_000;
const preparationStateSchema = z.object({
  status: z.enum(['pending', 'running', 'failed']),
  attemptId: z.uuid(),
  deadlineAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  error: z.enum(['collection_failed', 'time_limit', 'permission_unavailable']).nullable(),
});
export const oneOffBriefingDraftSchema = z.object({
  id: z.string(),
  context: briefingContextSchema,
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  timezone: z.string(),
  language: z.string(),
  createdAt: z.string().datetime(),
  status: z.enum(['pending', 'running', 'ready', 'failed']),
  error: preparationStateSchema.shape.error,
});

function preparationState(row: BriefingReportRow) {
  return row.revision > 0 ? null : preparationStateSchema.parse(row.facts.preparation);
}

function draftMetadata(
  row: BriefingReportRow,
  context: z.infer<typeof briefingContextSchema>
): z.infer<typeof oneOffBriefingDraftSchema> {
  const state = preparationState(row);
  if (!row.timezone || !row.language) throw new Error('Briefing draft metadata is missing');
  return {
    id: row.id,
    context,
    startAt: new Date(row.night_start_at).toISOString(),
    endAt: new Date(row.cutoff_at).toISOString(),
    timezone: row.timezone,
    language: row.language,
    createdAt: new Date(row.created_at).toISOString(),
    status: state?.status ?? 'ready',
    error: state?.error ?? null,
  };
}

export async function expireOneOffBriefingPreparations(now = new Date(), userId?: string) {
  await db
    .update(agent_briefing_reports)
    .set({
      updated_at: now.toISOString(),
      next_refresh_at: null,
      facts: sql`jsonb_set(${agent_briefing_reports.facts}, '{preparation}', ${agent_briefing_reports.facts}->'preparation' || '{"status":"failed","error":"time_limit"}'::jsonb)`,
    })
    .where(
      and(
        eq(agent_briefing_reports.kind, 'one_off'),
        eq(agent_briefing_reports.revision, 0),
        userId === undefined ? undefined : eq(agent_briefing_reports.kilo_user_id, userId),
        lte(agent_briefing_reports.next_refresh_at, now.toISOString()),
        sql`${agent_briefing_reports.facts}->'preparation'->>'status' IN ('pending', 'running')`,
        sql`${agent_briefing_reports.facts}->'preparation'->>'deadlineAt' <= ${now.toISOString()}`
      )
    );
}

export async function oneOffBriefingDraftRow(userId: string, reportId: string) {
  await expireOneOffBriefingPreparations(new Date(), userId);
  const [row] = await db
    .select()
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.id, reportId),
        eq(agent_briefing_reports.kilo_user_id, userId),
        eq(agent_briefing_reports.kind, 'one_off'),
        gt(agent_briefing_reports.morning_end_at, new Date().toISOString())
      )
    );
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Briefing draft not found' });
  const context = await requireBriefingContext(userId, row.organization_id);
  return { row, draft: draftMetadata(row, context) };
}

export async function listOneOffBriefingDrafts(
  userId: string,
  input: { cursor?: string; limit: number }
) {
  await expireOneOffBriefingPreparations(new Date(), userId);
  const contexts = await briefingContexts(userId);
  const rows = await db
    .select()
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.kilo_user_id, userId),
        eq(agent_briefing_reports.kind, 'one_off'),
        isNull(agent_briefing_reports.published_at),
        inArray(
          agent_briefing_reports.context_key,
          contexts.map(context => context.id)
        ),
        gt(agent_briefing_reports.morning_end_at, new Date().toISOString()),
        input.cursor
          ? sql`(${agent_briefing_reports.created_at}, ${agent_briefing_reports.id}) < (SELECT created_at, id FROM agent_briefing_reports WHERE id = ${input.cursor} AND kilo_user_id = ${userId})`
          : undefined
      )
    )
    .orderBy(desc(agent_briefing_reports.created_at), desc(agent_briefing_reports.id))
    .limit(input.limit + 1);
  return {
    drafts: rows.slice(0, input.limit).flatMap(row => {
      const context = contexts.find(value => value.organizationId === row.organization_id);
      return context ? [draftMetadata(row, context)] : [];
    }),
    nextCursor: rows.length > input.limit ? (rows[input.limit - 1]?.id ?? null) : null,
  };
}

export async function startOneOffBriefingPreparation(
  userId: string,
  input: {
    requestId: string;
    organizationId?: string;
    startAt: string;
    endAt: string;
    timezone: string;
    language: string;
  }
) {
  const start = Date.parse(input.startAt);
  const end = Date.parse(input.endAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    end > Date.now() ||
    end - start > 31 * 86400_000
  )
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Choose a past period of at most 31 days',
    });
  try {
    new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid timezone' });
  }
  const context = await requireBriefingContext(userId, input.organizationId);
  const createdAt = new Date().toISOString();
  const state = {
    status: 'pending',
    attemptId: crypto.randomUUID(),
    deadlineAt: new Date(Date.now() + PREPARATION_TIMEOUT_MS).toISOString(),
    startedAt: null,
    error: null,
  } satisfies z.infer<typeof preparationStateSchema>;
  const facts = {
    scorecard: { sessions: 0, pullRequests: 0, blockers: 0, spendMicrodollars: 0 },
    sessions: [],
    sources: [],
    coverage: {
      activity: 'partial',
      spend: 'unavailable',
      blockers: 'partial',
      pullRequests: 'partial',
    },
    preparation: state,
  };
  await db
    .insert(agent_briefing_reports)
    .values({
      id: input.requestId,
      kilo_user_id: userId,
      context_key: context.id,
      organization_id: context.organizationId,
      kind: 'one_off',
      created_at: createdAt,
      timezone: input.timezone,
      language: input.language,
      evidence_recorded_before: createdAt,
      local_date: null,
      night_start_at: new Date(start).toISOString(),
      cutoff_at: new Date(end).toISOString(),
      morning_end_at: new Date(Date.parse(createdAt) + 30 * 86400_000).toISOString(),
      next_refresh_at: createdAt,
      revision: 0,
      facts,
      evidence_hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
      summary: emptySummary,
    })
    .onConflictDoNothing({ target: agent_briefing_reports.id });
  const [row] = await db
    .select()
    .from(agent_briefing_reports)
    .where(eq(agent_briefing_reports.id, input.requestId));
  if (!row) throw new Error('Briefing preparation unavailable');
  if (
    row.kilo_user_id !== userId ||
    row.kind !== 'one_off' ||
    row.organization_id !== context.organizationId ||
    Date.parse(row.night_start_at) !== start ||
    Date.parse(row.cutoff_at) !== end ||
    row.timezone !== input.timezone ||
    row.language !== input.language
  )
    throw new TRPCError({ code: 'CONFLICT', message: 'Request ID has already been used' });
  if (Date.parse(row.morning_end_at) <= Date.now())
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Briefing draft expired' });
  const previous = preparationState(row);
  if (previous?.status === 'failed') {
    await db
      .update(agent_briefing_reports)
      .set({
        facts: sql`jsonb_set(${agent_briefing_reports.facts}, '{preparation}', ${JSON.stringify(state)}::jsonb)`,
        updated_at: createdAt,
        next_refresh_at: createdAt,
      })
      .where(
        and(
          eq(agent_briefing_reports.id, row.id),
          sql`${agent_briefing_reports.facts}->'preparation' = ${JSON.stringify(previous)}::jsonb`
        )
      );
  }
  return (await oneOffBriefingDraftRow(userId, row.id)).draft;
}

export async function runOneOffBriefingPreparation(reportId: string): Promise<void> {
  const [candidate] = await db
    .select()
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.id, reportId),
        eq(agent_briefing_reports.kind, 'one_off'),
        eq(agent_briefing_reports.revision, 0)
      )
    );
  if (!candidate) return;
  const pending = preparationState(candidate);
  if (pending?.status !== 'pending') return;
  const running = {
    ...pending,
    status: 'running',
    startedAt: new Date().toISOString(),
  } satisfies z.infer<typeof preparationStateSchema>;
  const [claimed] = await db
    .update(agent_briefing_reports)
    .set({
      facts: sql`jsonb_set(${agent_briefing_reports.facts}, '{preparation}', ${JSON.stringify(running)}::jsonb)`,
      updated_at: running.startedAt,
      next_refresh_at: running.deadlineAt,
    })
    .where(
      and(
        eq(agent_briefing_reports.id, reportId),
        eq(agent_briefing_reports.revision, 0),
        sql`${agent_briefing_reports.facts}->'preparation' = ${JSON.stringify(pending)}::jsonb`
      )
    )
    .returning();
  if (!claimed) return;
  const claim = and(
    eq(agent_briefing_reports.id, reportId),
    eq(agent_briefing_reports.revision, 0),
    sql`${agent_briefing_reports.facts}->'preparation' = ${JSON.stringify(running)}::jsonb`
  );
  try {
    const remainingMs = Date.parse(running.deadlineAt) - Date.now();
    if (remainingMs <= 0) throw new RequestDeadlineError(PREPARATION_TIMEOUT_MS);
    const facts = await withDeadline(remainingMs, async () => {
      await requireBriefingContext(claimed.kilo_user_id, claimed.organization_id);
      const collected = await collectBriefingEvidence(
        claimed.kilo_user_id,
        claimed.organization_id,
        new Date(claimed.night_start_at).toISOString(),
        new Date(claimed.cutoff_at).toISOString(),
        new Date(claimed.evidence_recorded_before ?? claimed.created_at).toISOString(),
        true
      );
      await requireBriefingContext(claimed.kilo_user_id, claimed.organization_id);
      return collected;
    });
    if (Date.now() >= Date.parse(running.deadlineAt))
      throw new RequestDeadlineError(PREPARATION_TIMEOUT_MS);
    await db
      .update(agent_briefing_reports)
      .set({
        facts,
        evidence_hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
        revision: 1,
        updated_at: new Date().toISOString(),
        next_refresh_at: null,
      })
      .where(claim);
  } catch (error) {
    const failure =
      error instanceof RequestDeadlineError
        ? 'time_limit'
        : error instanceof TRPCError && error.code === 'FORBIDDEN'
          ? 'permission_unavailable'
          : 'collection_failed';
    await db
      .update(agent_briefing_reports)
      .set({
        facts: sql`jsonb_set(${agent_briefing_reports.facts}, '{preparation}', ${JSON.stringify({ ...running, status: 'failed', error: failure })}::jsonb)`,
        updated_at: new Date().toISOString(),
        next_refresh_at: null,
      })
      .where(claim);
    console.error('Agent briefing preparation failed', { reportId, failure });
  }
}

export async function generatePendingOneOffBriefingPreparations() {
  await expireOneOffBriefingPreparations();
  const rows = await db
    .select({ id: agent_briefing_reports.id })
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.kind, 'one_off'),
        eq(agent_briefing_reports.revision, 0),
        lte(agent_briefing_reports.next_refresh_at, new Date().toISOString()),
        sql`${agent_briefing_reports.facts}->'preparation'->>'status' = 'pending'`
      )
    )
    .orderBy(agent_briefing_reports.next_refresh_at)
    .limit(5);
  const results = await Promise.allSettled(rows.map(row => runOneOffBriefingPreparation(row.id)));
  return {
    attempted: results.length,
    rejected: results.filter(result => result.status === 'rejected').length,
  };
}
