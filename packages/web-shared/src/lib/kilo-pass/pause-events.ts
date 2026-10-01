import 'server-only';

import { and, eq, isNull } from 'drizzle-orm';
import { kilo_pass_pause_events } from '@kilocode/db/schema';
import type { DrizzleTransaction, db as defaultDb } from '@/lib/drizzle';
import { getPreviousIssueMonth } from '@/lib/kilo-pass/stripe-handlers-utils';
import { dayjs } from '@/lib/kilo-pass/dayjs';

type Db = typeof defaultDb;
type DbOrTx = Db | DrizzleTransaction;

/**
 * Opens a pause event for a subscription. If an open event already exists,
 * updates resumes_at (idempotent). Otherwise inserts a new row.
 */
export async function openPauseEvent(
  dbOrTx: DbOrTx,
  params: {
    kiloPassSubscriptionId: string;
    pausedAt: string;
    resumesAt: string | null;
  }
): Promise<void> {
  const { kiloPassSubscriptionId, pausedAt, resumesAt } = params;

  const existing = await dbOrTx
    .select({ id: kilo_pass_pause_events.id })
    .from(kilo_pass_pause_events)
    .where(
      and(
        eq(kilo_pass_pause_events.kilo_pass_subscription_id, kiloPassSubscriptionId),
        isNull(kilo_pass_pause_events.resumed_at)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await dbOrTx
      .update(kilo_pass_pause_events)
      .set({ resumes_at: resumesAt })
      .where(
        and(
          eq(kilo_pass_pause_events.kilo_pass_subscription_id, kiloPassSubscriptionId),
          isNull(kilo_pass_pause_events.resumed_at)
        )
      );
  } else {
    await dbOrTx.insert(kilo_pass_pause_events).values({
      kilo_pass_subscription_id: kiloPassSubscriptionId,
      paused_at: pausedAt,
      resumes_at: resumesAt,
    });
  }
}

/**
 * Closes the open pause event for a subscription by setting resumed_at.
 * No-op if no open event exists (idempotent).
 */
export async function closePauseEvent(
  dbOrTx: DbOrTx,
  params: {
    kiloPassSubscriptionId: string;
    resumedAt: string;
  }
): Promise<void> {
  const { kiloPassSubscriptionId, resumedAt } = params;

  await dbOrTx
    .update(kilo_pass_pause_events)
    .set({ resumed_at: resumedAt })
    .where(
      and(
        eq(kilo_pass_pause_events.kilo_pass_subscription_id, kiloPassSubscriptionId),
        isNull(kilo_pass_pause_events.resumed_at)
      )
    );
}

/**
 * Returns the open pause event (where resumed_at IS NULL) or null.
 */
export async function getOpenPauseEvent(
  dbOrTx: DbOrTx,
  params: {
    kiloPassSubscriptionId: string;
  }
): Promise<typeof kilo_pass_pause_events.$inferSelect | null> {
  const rows = await dbOrTx
    .select()
    .from(kilo_pass_pause_events)
    .where(
      and(
        eq(kilo_pass_pause_events.kilo_pass_subscription_id, params.kiloPassSubscriptionId),
        isNull(kilo_pass_pause_events.resumed_at)
      )
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Returns a Set<string> of issue-month strings (YYYY-MM-01) that overlap with
 * any pause event for the subscription.
 *
 * A month overlaps a pause if:
 *   paused_at < next_month_start AND (resumed_at IS NULL OR resumed_at >= month_start)
 *
 * Walks backwards from fromIssueMonth for maxMonthsBack months.
 */
export async function getPausedMonthSet(
  dbOrTx: DbOrTx,
  params: {
    kiloPassSubscriptionId: string;
    fromIssueMonth: string;
    maxMonthsBack: number;
  }
): Promise<Set<string>> {
  const { kiloPassSubscriptionId, fromIssueMonth, maxMonthsBack } = params;

  // Fetch all pause events for the subscription
  const pauseEvents = await dbOrTx
    .select({
      paused_at: kilo_pass_pause_events.paused_at,
      resumed_at: kilo_pass_pause_events.resumed_at,
    })
    .from(kilo_pass_pause_events)
    .where(eq(kilo_pass_pause_events.kilo_pass_subscription_id, kiloPassSubscriptionId));

  if (pauseEvents.length === 0) {
    return new Set<string>();
  }

  const pausedMonths = new Set<string>();

  // Walk backwards from fromIssueMonth for maxMonthsBack months
  let currentMonth = fromIssueMonth;
  for (let i = 0; i < maxMonthsBack; i++) {
    const monthStart = dayjs(`${currentMonth}T00:00:00.000Z`).utc();
    const nextMonthStart = monthStart.add(1, 'month');

    for (const event of pauseEvents) {
      const pausedAtMs = dayjs(event.paused_at).valueOf();
      const resumedAtMs = event.resumed_at ? dayjs(event.resumed_at).valueOf() : null;

      // paused_at < next_month_start AND (resumed_at IS NULL OR resumed_at >= month_start)
      const pauseBeforeNextMonth = pausedAtMs < nextMonthStart.valueOf();
      const resumeAfterMonthStart = resumedAtMs === null || resumedAtMs >= monthStart.valueOf();

      if (pauseBeforeNextMonth && resumeAfterMonthStart) {
        pausedMonths.add(currentMonth);
        break;
      }
    }

    currentMonth = getPreviousIssueMonth(currentMonth);
  }

  return pausedMonths;
}
