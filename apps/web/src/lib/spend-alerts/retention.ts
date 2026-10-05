import 'server-only';

import { sql } from 'drizzle-orm';

import { sentryLogger } from '@/lib/utils.server';
import type { db as defaultDb } from '@/lib/drizzle';

/**
 * Retention for the `spend_alert_hourly` rollup.
 *
 * The longest window a rule can use is 720 h (30 days), so a bucket older than
 * the retention window can never change a decision: the window sums only read
 * buckets at or after `now - window`, and the anomaly baseline reads the
 * trailing 14 days. Keeping older buckets therefore costs storage and scan time
 * without changing any alert. Pruning is bounded per statement so one daily run
 * cannot hold a long lock on the table.
 */

type Db = typeof defaultDb;

/** Longest rule window is 720 h (30 days), so older buckets cannot matter. */
export const SPEND_ALERT_HOURLY_RETENTION_DAYS = 30;

/** Rows per delete statement. Small enough that one statement's lock is short. */
export const SPEND_ALERT_HOURLY_PRUNE_BATCH_SIZE = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes `spend_alert_hourly` buckets older than the retention window in
 * bounded batches, logging each batch's row count. Returns the total deleted.
 *
 * The loop is deliberate: a single unbounded `DELETE` on a table this size can
 * hold locks and generate WAL for the whole old range at once. Deleting
 * `SPEND_ALERT_HOURLY_PRUNE_BATCH_SIZE` rows per statement keeps each
 * statement's work bounded, and the run stops as soon as a batch is short.
 */
export async function pruneSpendAlertHourly(
  database: Db,
  options: { now: Date; retentionDays?: number }
): Promise<{ deleted: number }> {
  const retentionDays = options.retentionDays ?? SPEND_ALERT_HOURLY_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error('Spend alert hourly retention days must be a positive number.');
  }

  const cutoff = new Date(options.now.getTime() - retentionDays * DAY_MS).toISOString();
  const logBatch = sentryLogger('cron', 'info');

  let deleted = 0;
  for (;;) {
    // `ctid IN (SELECT ... LIMIT)` bounds the statement to one batch while the
    // `hour_start < cutoff` predicate stays index-eligible via
    // IDX_spend_alert_hourly_hour_start.
    const result = await database.execute(sql`
      DELETE FROM spend_alert_hourly
      WHERE ctid IN (
        SELECT ctid
        FROM spend_alert_hourly
        WHERE hour_start < ${cutoff}
        LIMIT ${SPEND_ALERT_HOURLY_PRUNE_BATCH_SIZE}
      )
    `);

    const batchDeleted = result.rowCount ?? 0;
    if (batchDeleted === 0) break;

    deleted += batchDeleted;
    logBatch('Spend alert hourly retention batch deleted', {
      batchDeleted,
      deleted,
      cutoff,
    });

    if (batchDeleted < SPEND_ALERT_HOURLY_PRUNE_BATCH_SIZE) break;
  }

  return { deleted };
}
