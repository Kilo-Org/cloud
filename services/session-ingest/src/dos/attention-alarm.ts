/**
 * Shared alarm scheduling for the attention outbox and session metrics lifecycle.
 *
 * The DO uses one alarm for both concerns so the outbox can preempt the
 * metrics drain and vice versa. The helpers here are intentionally pure
 * except for `computeNextAlarmTime`, which is a thin wrapper that reads the
 * current DB state and delegates to the testable `minPendingAlarmTime` rule.
 */

import { inArray } from 'drizzle-orm';
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';

import { ingestMeta } from '../db/sqlite-schema';
import { earliestScheduledAttemptAt } from '../attention-outbox-store';

/**
 * Pure: pick the earliest pending alarm time from the metrics alarm and the
 * outbox schedule. Ignores metrics when they have already emitted, and
 * ignores non-numeric or non-positive alarm times.
 */
export function minPendingAlarmTime(
  metricsAlarmAt: number | string | null | undefined,
  metricsEmitted: boolean | string | null | undefined,
  outboxAt: number | null
): number | null {
  const candidates: number[] = [];

  if (outboxAt !== null && Number.isFinite(outboxAt)) {
    candidates.push(outboxAt);
  }

  if (metricsEmitted !== true && metricsEmitted !== 'true') {
    const parsed = typeof metricsAlarmAt === 'number' ? metricsAlarmAt : Number(metricsAlarmAt);
    if (Number.isFinite(parsed) && parsed > 0) {
      candidates.push(parsed);
    }
  }

  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

/**
 * Read the current session state and return the earliest alarm time that
 * still has work pending. Returns null when both metrics and outbox are idle.
 */
export function computeNextAlarmTime(db: DrizzleSqliteDODatabase): number | null {
  const metaRows = db
    .select()
    .from(ingestMeta)
    .where(inArray(ingestMeta.key, ['metricsAlarmAt', 'metricsEmitted']))
    .all();
  const meta = Object.fromEntries(metaRows.map(r => [r.key, r.value]));
  const outboxAt = earliestScheduledAttemptAt(db);

  return minPendingAlarmTime(
    meta['metricsAlarmAt'] !== undefined ? Number(meta['metricsAlarmAt']) : null,
    meta['metricsEmitted'],
    outboxAt
  );
}
