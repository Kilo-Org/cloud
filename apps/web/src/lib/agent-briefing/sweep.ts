import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { agent_briefing_preferences, agent_briefing_reports } from '@kilocode/db/schema';
import { dispatchAgentBriefingPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { briefingSummarySchema } from '@kilocode/app-shared/agent-briefing';
import {
  briefingContexts,
  briefingContextSettings,
  emptySummary,
  refreshBriefingEvidence,
  requireBriefingContext,
} from './store';
import { briefingWindow, nextBriefingTime, type BriefingWindow } from './schedule';
import { reconcileBriefingCharge, runBriefingSummary } from './summary';

async function freezeBriefingContexts(userId: string, window: BriefingWindow, timezone: string) {
  for (const context of await briefingContexts(userId)) {
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
    };
    await db
      .insert(agent_briefing_reports)
      .values({
        kilo_user_id: userId,
        context_key: context.id,
        organization_id: context.organizationId,
        timezone,
        local_date: window.localDate,
        night_start_at: window.nightStartAt,
        cutoff_at: window.cutoffAt,
        morning_end_at: window.morningEndAt,
        next_refresh_at: window.cutoffAt,
        revision: 0,
        facts,
        evidence_hash: createHash('sha256').update(JSON.stringify(facts)).digest('hex'),
        summary: emptySummary,
      })
      .onConflictDoNothing();
  }
}

export async function sweepAgentBriefings(now = new Date()) {
  const iso = now.toISOString();
  const due = await db
    .select()
    .from(agent_briefing_preferences)
    .where(lte(agent_briefing_preferences.next_run_at, iso))
    .limit(200);
  for (const preferences of due) {
    const night = new Date(preferences.next_run_at);
    const window = briefingWindow(preferences, night);
    await freezeBriefingContexts(preferences.kilo_user_id, window, preferences.timezone);
    await db
      .update(agent_briefing_preferences)
      .set({
        next_run_at: nextBriefingTime(
          preferences.night_start,
          preferences.timezone,
          now
        ).toISOString(),
      })
      .where(
        and(
          eq(agent_briefing_preferences.kilo_user_id, preferences.kilo_user_id),
          eq(agent_briefing_preferences.next_run_at, preferences.next_run_at)
        )
      );
  }
  const active = await db
    .select()
    .from(agent_briefing_reports)
    .where(
      and(
        eq(agent_briefing_reports.kind, 'scheduled'),
        lte(agent_briefing_reports.cutoff_at, iso),
        lte(agent_briefing_reports.next_refresh_at, iso)
      )
    )
    .orderBy(asc(agent_briefing_reports.next_refresh_at))
    .limit(500);
  for (const original of active) {
    const localDate = original.local_date;
    if (localDate === null) {
      throw new Error('Scheduled briefing is missing its local date');
    }
    try {
      await requireBriefingContext(original.kilo_user_id, original.organization_id);
    } catch (error) {
      if (!(error instanceof TRPCError && error.code === 'FORBIDDEN')) throw error;
      await db.delete(agent_briefing_reports).where(eq(agent_briefing_reports.id, original.id));
      continue;
    }
    if (original.context_key === 'personal')
      await freezeBriefingContexts(
        original.kilo_user_id,
        {
          localDate,
          nightStartAt: new Date(original.night_start_at).toISOString(),
          cutoffAt: new Date(original.cutoff_at).toISOString(),
          morningEndAt: new Date(original.morning_end_at).toISOString(),
        },
        original.timezone ?? (await getScheduledTimezone(original.kilo_user_id))
      );
    let row = await refreshBriefingEvidence(original);
    row = await reconcileBriefingCharge(row);
    const facts = row.facts;
    const scorecard =
      typeof facts.scorecard === 'object' &&
      facts.scorecard !== null &&
      'sessions' in facts.scorecard
        ? facts.scorecard.sessions
        : 0;
    if (typeof scorecard !== 'number' || scorecard <= 0) {
      await db
        .update(agent_briefing_reports)
        .set({
          next_refresh_at:
            new Date(original.morning_end_at) <= now
              ? null
              : new Date(now.getTime() + 60_000).toISOString(),
        })
        .where(eq(agent_briefing_reports.id, original.id));
      continue;
    }
    let summary = briefingSummarySchema.parse(row.summary);
    if (!row.published_at && summary.status === 'disabled') {
      const settings = await briefingContextSettings(row.kilo_user_id, row.organization_id);
      if (settings.aiEnabled && new Date(row.morning_end_at) > now) {
        const [updated] = await db
          .update(agent_briefing_reports)
          .set({
            summary: { ...summary, status: 'pending', model: settings.model, waitStartedAt: iso },
            updated_at: iso,
          })
          .where(
            and(
              eq(agent_briefing_reports.id, row.id),
              sql`${agent_briefing_reports.summary}->>'status' = 'disabled'`
            )
          )
          .returning();
        if (updated) row = updated;
      } else {
        const [published] = await db
          .update(agent_briefing_reports)
          .set({
            published_at: iso,
            ...(settings.aiEnabled
              ? {
                  summary: {
                    ...summary,
                    status: 'unavailable',
                    model: settings.model,
                    error: 'time_limit',
                    finishedAt: iso,
                    canRetry: false,
                  },
                }
              : {}),
          })
          .where(
            and(eq(agent_briefing_reports.id, row.id), isNull(agent_briefing_reports.published_at))
          )
          .returning();
        if (published) row = published;
      }
    }
    summary = briefingSummarySchema.parse(row.summary);
    if (
      new Date(row.morning_end_at) <= now &&
      summary.status === 'pending' &&
      row.generation_id === null &&
      row.summary.manualRequested !== true
    ) {
      const [closed] = await db
        .update(agent_briefing_reports)
        .set({
          summary: sql`${agent_briefing_reports.summary} || ${JSON.stringify({ status: 'unavailable', error: 'time_limit', finishedAt: iso, canRetry: false })}::jsonb`,
        })
        .where(
          and(
            eq(agent_briefing_reports.id, row.id),
            isNull(agent_briefing_reports.generation_id),
            sql`${agent_briefing_reports.summary}->>'status' = 'pending'`
          )
        )
        .returning();
      if (closed) row = closed;
    }
    if (
      summary.status === 'running' &&
      row.generation_deadline_at &&
      new Date(row.generation_deadline_at) < now
    ) {
      const [failed] = await db
        .update(agent_briefing_reports)
        .set({
          generation_finished_at: iso,
          summary: sql`${agent_briefing_reports.summary} || ${JSON.stringify({ status: 'failed', finishedAt: iso, error: 'time_limit', canRetry: false })}::jsonb`,
        })
        .where(
          and(
            eq(agent_briefing_reports.id, row.id),
            sql`${agent_briefing_reports.summary}->>'status' = 'running'`
          )
        )
        .returning();
      if (failed) row = await reconcileBriefingCharge(failed);
    }
    const waitStartedAt =
      typeof row.summary.waitStartedAt === 'string'
        ? Date.parse(row.summary.waitStartedAt)
        : new Date(row.cutoff_at).getTime();
    if (
      !row.published_at &&
      (new Date(row.morning_end_at) <= now ||
        now.getTime() >= waitStartedAt + 5 * 60_000 ||
        ['ready', 'outdated', 'failed', 'unavailable'].includes(String(row.summary.status)))
    ) {
      const [published] = await db
        .update(agent_briefing_reports)
        .set({ published_at: iso })
        .where(
          and(eq(agent_briefing_reports.id, row.id), isNull(agent_briefing_reports.published_at))
        )
        .returning();
      if (published) row = published;
    }
    if (
      row.published_at &&
      !row.notification_sent_at &&
      new Date(row.morning_end_at) > now &&
      (await dispatchAgentBriefingPush({
        userId: row.kilo_user_id,
        localDate,
        expiresAt: new Date(row.morning_end_at).toISOString(),
      }))
    ) {
      await db
        .update(agent_briefing_reports)
        .set({ notification_sent_at: iso })
        .where(eq(agent_briefing_reports.id, row.id));
    }
    await db
      .update(agent_briefing_reports)
      .set({
        next_refresh_at:
          new Date(original.morning_end_at) <= now
            ? null
            : new Date(now.getTime() + 60_000).toISOString(),
      })
      .where(eq(agent_briefing_reports.id, original.id));
  }
  await db
    .update(agent_briefing_reports)
    .set({
      generation_finished_at: iso,
      next_charge_check_at: iso,
      summary: sql`${agent_briefing_reports.summary} || ${JSON.stringify({ status: 'failed', finishedAt: iso, error: 'time_limit', canRetry: false })}::jsonb`,
    })
    .where(
      and(
        sql`${agent_briefing_reports.summary}->>'status' = 'running'`,
        lte(agent_briefing_reports.generation_deadline_at, iso)
      )
    );
  const unfinished = await db
    .select()
    .from(agent_briefing_reports)
    .where(
      and(
        sql`${agent_briefing_reports.generation_id} IS NOT NULL`,
        lte(agent_briefing_reports.next_charge_check_at, iso)
      )
    )
    .orderBy(asc(agent_briefing_reports.next_charge_check_at))
    .limit(100);
  for (const report of unfinished) await reconcileBriefingCharge(report);
  await db
    .delete(agent_briefing_reports)
    .where(
      or(
        and(
          eq(agent_briefing_reports.kind, 'scheduled'),
          lte(
            agent_briefing_reports.cutoff_at,
            new Date(now.getTime() - 30 * 86400_000).toISOString()
          )
        ),
        and(
          eq(agent_briefing_reports.kind, 'one_off'),
          lte(agent_briefing_reports.morning_end_at, iso)
        )
      )
    );
  return { scheduledUsers: due.length, activeReports: active.length };
}
export async function generatePendingAgentBriefings() {
  const reports = await db
    .select({ id: agent_briefing_reports.id })
    .from(agent_briefing_reports)
    .where(
      and(
        sql`${agent_briefing_reports.summary}->>'status' = 'pending'`,
        isNull(agent_briefing_reports.generation_id),
        or(
          gt(agent_briefing_reports.morning_end_at, new Date().toISOString()),
          sql`${agent_briefing_reports.summary}->>'manualRequested' = 'true'`
        )
      )
    )
    .orderBy(asc(agent_briefing_reports.updated_at))
    .limit(10);
  const results = await Promise.allSettled(reports.map(report => runBriefingSummary(report.id)));
  const rejected = results.filter(result => result.status === 'rejected').length;
  if (rejected > 0) console.error('Agent briefing summary jobs rejected', { rejected });
  return { attempted: reports.length, fulfilled: results.length - rejected, rejected };
}

async function getScheduledTimezone(userId: string) {
  const [preferences] = await db
    .select({ timezone: agent_briefing_preferences.timezone })
    .from(agent_briefing_preferences)
    .where(eq(agent_briefing_preferences.kilo_user_id, userId));
  return preferences?.timezone ?? 'UTC';
}
