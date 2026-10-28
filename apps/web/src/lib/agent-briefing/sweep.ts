import { and, asc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_briefing_preferences,
  agent_briefing_context_preferences,
  agent_briefing_snapshots,
} from '@kilocode/db/schema';
import { dispatchAgentBriefingPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { briefingHasActivity } from '@kilocode/app-shared/agent-briefing';
import { briefingContexts, assertBriefingSourcesAccessible, emptySummary } from './store';
import { collectBriefingSnapshot } from './evidence';
import { nextBriefingTime, latestScheduledBriefingWindow } from './schedule';
import { reconcileBriefingCharge, runBriefingSummary } from './summary';

export async function sweepAgentBriefings(now = new Date()) {
  const iso = now.toISOString();
  const due = await db
    .select({ userId: agent_briefing_preferences.kilo_user_id })
    .from(agent_briefing_preferences)
    .where(lte(agent_briefing_preferences.next_run_at, iso))
    .orderBy(asc(agent_briefing_preferences.next_run_at))
    .limit(100);
  let captured = 0;
  for (const candidate of due) {
    captured += await db.transaction(async tx => {
      const [preferences] = await tx
        .select()
        .from(agent_briefing_preferences)
        .where(
          and(
            eq(agent_briefing_preferences.kilo_user_id, candidate.userId),
            lte(agent_briefing_preferences.next_run_at, iso)
          )
        )
        .for('update', { skipLocked: true });
      if (!preferences) return 0;
      const window = latestScheduledBriefingWindow(preferences, now);
      const captureThrough = new Date(
        Math.min(now.getTime(), Date.parse(window.morningEndAt))
      ).toISOString();
      const contexts = await briefingContexts(preferences.kilo_user_id);
      const enabled = await tx
        .select()
        .from(agent_briefing_context_preferences)
        .where(
          and(
            eq(agent_briefing_context_preferences.kilo_user_id, preferences.kilo_user_id),
            eq(agent_briefing_context_preferences.enabled, true)
          )
        )
        .for('share');
      let count = 0;
      for (const setting of enabled) {
        if (
          !contexts.some(
            context =>
              context.id === setting.context_key &&
              context.organizationId === setting.organization_id
          )
        )
          continue;
        const facts = await collectBriefingSnapshot(
          preferences.kilo_user_id,
          setting.organization_id,
          window.nightStartAt,
          captureThrough
        );
        const active = briefingHasActivity(facts.scorecard);
        const expired = Date.parse(window.morningEndAt) <= now.getTime();
        const pending = active && !expired;
        const inserted = await tx
          .insert(agent_briefing_snapshots)
          .values({
            kilo_user_id: preferences.kilo_user_id,
            context_key: setting.context_key,
            organization_id: setting.organization_id,
            timezone: preferences.timezone,
            language: preferences.language,
            local_date: window.localDate,
            night_start_at: window.nightStartAt,
            cutoff_at: window.cutoffAt,
            morning_end_at: window.morningEndAt,
            captured_at: iso,
            published_at: iso,
            facts,
            expires_at: new Date(now.getTime() + 30 * 86400_000).toISOString(),
            job_due_at: pending ? iso : null,
            summary: {
              ...emptySummary,
              status: pending ? 'pending' : 'unavailable',
              model: setting.model,
              ...(expired && active ? { error: 'time_limit', finishedAt: iso } : {}),
              authorization: {
                model: setting.model,
                maxSpendMicrodollars: setting.max_spend_microdollars,
                maxDurationSeconds: setting.max_duration_seconds,
              },
            },
          })
          .onConflictDoNothing()
          .returning({ id: agent_briefing_snapshots.id });
        count += inserted.length;
      }
      await tx
        .update(agent_briefing_preferences)
        .set({
          next_run_at: nextBriefingTime(
            preferences.morning_start,
            preferences.timezone,
            now
          ).toISOString(),
        })
        .where(eq(agent_briefing_preferences.kilo_user_id, preferences.kilo_user_id));
      return count;
    });
  }
  const jobs = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(
      and(
        lte(agent_briefing_snapshots.job_due_at, iso),
        or(
          and(
            sql`${agent_briefing_snapshots.summary}->>'status' = 'running'`,
            lte(agent_briefing_snapshots.generation_deadline_at, iso)
          ),
          and(
            sql`${agent_briefing_snapshots.summary}->>'status' = 'pending'`,
            isNull(agent_briefing_snapshots.generation_id),
            lte(agent_briefing_snapshots.morning_end_at, iso)
          )
        )
      )
    )
    .orderBy(asc(agent_briefing_snapshots.job_due_at))
    .limit(100);
  for (const row of jobs) {
    if (
      row.summary.status === 'running' &&
      row.generation_deadline_at &&
      Date.parse(row.generation_deadline_at) <= now.getTime()
    ) {
      await db
        .update(agent_briefing_snapshots)
        .set({
          job_due_at: null,
          generation_finished_at: iso,
          summary: sql`${agent_briefing_snapshots.summary} || ${JSON.stringify({ status: 'failed', text: null, finishedAt: iso, error: 'time_limit' })}::jsonb`,
        })
        .where(
          and(
            eq(agent_briefing_snapshots.id, row.id),
            sql`${agent_briefing_snapshots.summary}->>'status' = 'running'`,
            lte(agent_briefing_snapshots.generation_deadline_at, iso)
          )
        );
    } else if (
      row.summary.status === 'pending' &&
      Date.parse(row.morning_end_at) <= now.getTime()
    ) {
      await db
        .update(agent_briefing_snapshots)
        .set({
          job_due_at: null,
          summary: sql`${agent_briefing_snapshots.summary} || ${JSON.stringify({ status: 'unavailable', finishedAt: iso, error: 'time_limit' })}::jsonb`,
        })
        .where(
          and(
            eq(agent_briefing_snapshots.id, row.id),
            isNull(agent_briefing_snapshots.generation_id),
            sql`${agent_briefing_snapshots.summary}->>'status' = 'pending'`
          )
        );
    }
  }
  const charges = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(lte(agent_briefing_snapshots.next_charge_check_at, iso))
    .orderBy(asc(agent_briefing_snapshots.next_charge_check_at))
    .limit(100);
  for (const row of charges) await reconcileBriefingCharge(row);
  const notifications = await db
    .select()
    .from(agent_briefing_snapshots)
    .where(
      and(
        isNull(agent_briefing_snapshots.notification_sent_at),
        sql`${agent_briefing_snapshots.summary}->>'notificationSuppressed' IS DISTINCT FROM 'true'`,
        lte(agent_briefing_snapshots.cutoff_at, iso),
        sql`${agent_briefing_snapshots.morning_end_at} > ${iso}::timestamptz`,
        sql`(${agent_briefing_snapshots.facts}->'scorecard'->>'sessions')::int > 0`,
        sql`EXISTS (SELECT 1 FROM ${agent_briefing_preferences} WHERE ${agent_briefing_preferences.kilo_user_id} = ${agent_briefing_snapshots.kilo_user_id} AND ${agent_briefing_preferences.notifications_enabled})`
      )
    )
    .orderBy(asc(agent_briefing_snapshots.cutoff_at))
    .limit(100);
  for (const row of notifications) {
    try {
      await assertBriefingSourcesAccessible(row);
      const accepted = await dispatchAgentBriefingPush({
        userId: row.kilo_user_id,
        localDate: row.local_date,
        expiresAt: new Date(row.morning_end_at).toISOString(),
      });
      if (accepted) {
        await db
          .update(agent_briefing_snapshots)
          .set({ notification_sent_at: iso })
          .where(
            and(
              eq(agent_briefing_snapshots.id, row.id),
              isNull(agent_briefing_snapshots.notification_sent_at)
            )
          );
      }
    } catch (error) {
      if (error instanceof TRPCError && ['FORBIDDEN', 'NOT_FOUND'].includes(error.code)) {
        await db
          .update(agent_briefing_snapshots)
          .set({
            summary: sql`${agent_briefing_snapshots.summary} || '{"notificationSuppressed":true}'::jsonb`,
          })
          .where(eq(agent_briefing_snapshots.id, row.id));
        continue;
      }
      console.error('Agent briefing notification dispatch failed', { reportId: row.id });
    }
  }
  await db.delete(agent_briefing_snapshots).where(lte(agent_briefing_snapshots.expires_at, iso));
  return { scheduledUsers: due.length, capturedReports: captured };
}

export async function generatePendingAgentBriefings() {
  const reports = await db
    .select({ id: agent_briefing_snapshots.id })
    .from(agent_briefing_snapshots)
    .where(
      and(
        lte(agent_briefing_snapshots.job_due_at, new Date().toISOString()),
        isNull(agent_briefing_snapshots.generation_id),
        sql`${agent_briefing_snapshots.summary}->>'status' = 'pending'`
      )
    )
    .orderBy(asc(agent_briefing_snapshots.job_due_at))
    .limit(2);
  const results = await Promise.allSettled(reports.map(report => runBriefingSummary(report.id)));
  const rejected = results.filter(result => result.status === 'rejected').length;
  if (rejected) console.error('Agent briefing summary jobs rejected', { rejected });
  return { attempted: reports.length, fulfilled: results.length - rejected, rejected };
}
