import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import {
  CLOUD_WAKEUP_EXPIRED,
  CLOUD_WAKEUP_MIN_DELAY_MS,
  CLOUD_WAKEUP_MIN_SLEEP_MS,
  CLOUD_WAKEUP_RETRY_LIMIT_MS,
  CLOUD_WAKEUP_RETRY_MS,
  type CloudWakeup,
  type CloudWakeupCommand,
  type CloudWakeupReply,
} from '../../shared/cloud-wakeup.js';
import { createMessageId } from '../../shared/message-id.js';
import { cloudWakeups } from './sqlite-schema.js';

type Row = typeof cloudWakeups.$inferSelect;

function summary({ id, dueAt, prompt, mode, state, failure }: Row): CloudWakeup {
  return { id, dueAt, prompt, mode, state, failure };
}

export function wakeupDelayMs(delay: string): number | null {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(delay.trim());
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const multiplier = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 1;
  const milliseconds = Number(match[1]) * multiplier * 1000;
  if (milliseconds <= 0 || milliseconds > 7 * 86400_000) return null;
  return Math.max(milliseconds, CLOUD_WAKEUP_MIN_DELAY_MS);
}

export function createCloudWakeups(db: DrizzleSqliteDODatabase) {
  const pending = () =>
    db.select().from(cloudWakeups).where(eq(cloudWakeups.state, 'pending')).get();
  function settle(
    row: Row,
    state: 'cancelled' | 'failed' | 'fired',
    failure: string | null = null
  ) {
    const updated = db
      .update(cloudWakeups)
      .set({ state, failure })
      .where(and(eq(cloudWakeups.id, row.id), eq(cloudWakeups.state, 'pending')))
      .returning()
      .get();
    return updated ? summary(updated) : null;
  }
  function schedule(
    input: Extract<CloudWakeupCommand, { action: 'schedule' }>,
    now: number,
    expiresAt: number | null,
    capability: 'stay-awake' | 'snapshot'
  ): CloudWakeupReply {
    const previous = db
      .select()
      .from(cloudWakeups)
      .where(eq(cloudWakeups.callId, input.callId))
      .get();
    if (previous) return { ok: true, wakeup: summary(previous) };
    if (pending())
      return {
        ok: false,
        error: 'This chat already has a pending wakeup. Cancel it before scheduling another.',
      };
    const delay = wakeupDelayMs(input.delay);
    if (delay === null)
      return { ok: false, error: 'Use a delay such as 10s, 15m, or 2h (up to 7 days).' };
    if (expiresAt === null || expiresAt <= now) return { ok: false, error: CLOUD_WAKEUP_EXPIRED };
    const dueAt = now + delay;
    if (dueAt >= expiresAt)
      return {
        ok: false,
        error: 'Wakeup must be due before runtime authorization expires. Choose a shorter delay.',
      };
    const mode = delay < CLOUD_WAKEUP_MIN_SLEEP_MS ? 'stay-awake' : 'sleep';
    if (mode === 'sleep' && capability !== 'snapshot')
      return {
        ok: false,
        error: 'Sleep mode requires workspace snapshots. Choose a delay shorter than 10 minutes.',
      };
    const row = db
      .insert(cloudWakeups)
      .values({
        id: `wku_${crypto.randomUUID()}`,
        callId: input.callId,
        messageId: createMessageId(),
        dueAt,
        nextAttemptAt: dueAt,
        prompt: input.prompt,
        mode,
        state: 'pending',
      })
      .returning()
      .get();
    return { ok: true, wakeup: summary(row) };
  }
  function cancel(id: string): CloudWakeupReply {
    const row = db.select().from(cloudWakeups).where(eq(cloudWakeups.id, id)).get();
    if (row?.state === 'cancelled') return { ok: true, wakeup: summary(row) };
    const wakeup = row && settle(row, 'cancelled');
    return wakeup
      ? { ok: true, wakeup }
      : { ok: false, error: 'No pending wakeup with that ID in this chat.' };
  }
  async function fire(input: {
    now: number;
    expiresAt: number | null;
    isAdmitted: (messageId: string) => boolean;
    admit: (messageId: string, prompt: string) => Promise<boolean>;
  }): Promise<CloudWakeup | null> {
    const row = pending();
    if (!row || row.nextAttemptAt > input.now) return null;
    if (input.isAdmitted(row.messageId)) return settle(row, 'fired');
    if (input.expiresAt === null || input.expiresAt <= input.now)
      return settle(row, 'failed', CLOUD_WAKEUP_EXPIRED);
    try {
      if (await input.admit(row.messageId, row.prompt)) return settle(row, 'fired');
    } catch {
      if (input.isAdmitted(row.messageId)) return settle(row, 'fired');
    }
    if (input.now - row.dueAt >= CLOUD_WAKEUP_RETRY_LIMIT_MS)
      return settle(row, 'failed', 'Cloud could not queue the wakeup. Send a message to continue.');
    db.update(cloudWakeups)
      .set({ nextAttemptAt: Math.min(input.now + CLOUD_WAKEUP_RETRY_MS, input.expiresAt) })
      .where(eq(cloudWakeups.id, row.id))
      .run();
    return null;
  }
  return {
    schedule,
    cancel,
    fire,
    pendingMessageId: () => pending()?.messageId ?? null,
    isWakeupMessage: (messageId: string) =>
      db
        .select({ id: cloudWakeups.id })
        .from(cloudWakeups)
        .where(eq(cloudWakeups.messageId, messageId))
        .get() !== undefined,
    nextAt: () => pending()?.nextAttemptAt ?? null,
    latest: () => {
      const row =
        pending() ??
        db.select().from(cloudWakeups).orderBy(desc(cloudWakeups.dueAt)).limit(1).get();
      return row ? summary(row) : null;
    },
  };
}
