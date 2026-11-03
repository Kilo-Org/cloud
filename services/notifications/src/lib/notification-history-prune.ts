/**
 * Retention prune for `user_notification_history`.
 *
 * The history query only reads the retention window, and this job deletes what
 * fell out of it. Deletion runs in bounded id batches so one statement never
 * holds a long transaction over a large row set, and the cursor-based query
 * stays valid across a prune: a cursor carries `(created_at, id)` and the query
 * compares against those columns rather than an offset, so removing rows behind
 * the cursor cannot shift a page.
 */

import { user_notification_history } from '@kilocode/db/schema';
import type { WorkerDb } from '@kilocode/db/client';
import { NOTIFICATION_HISTORY_RETENTION_MS } from '@kilocode/notifications';
import { asc, inArray, lt } from 'drizzle-orm';

/** The daily trigger that owns the prune; `wrangler.jsonc` declares it. */
export const NOTIFICATION_HISTORY_PRUNE_CRON = '41 3 * * *';

const PRUNE_BATCH_SIZE = 1000;
/**
 * Cap on batches per run. A first run against a long-ignored table could hold
 * millions of rows; the job finishes what it can and the next run continues,
 * rather than occupying the worker for an unbounded time.
 */
export const NOTIFICATION_HISTORY_PRUNE_MAX_BATCHES = 50;

export type NotificationHistoryPruneResult = { deleted: number; hasMore: boolean };

/**
 * Delete rows older than the retention window. `hasMore` reports that the batch
 * cap was hit with work left, so an operator sees an unfinished backlog.
 */
export async function pruneNotificationHistory(
  db: WorkerDb,
  now: number = Date.now()
): Promise<NotificationHistoryPruneResult> {
  const retentionMs = NOTIFICATION_HISTORY_RETENTION_MS;
  const cutoff = new Date(now - retentionMs).toISOString();

  let deleted = 0;
  for (let batch = 0; batch < NOTIFICATION_HISTORY_PRUNE_MAX_BATCHES; batch += 1) {
    // Select the batch's ids first, oldest first: each delete is then bounded
    // by an exact id list, and a backlog drains deterministically across runs.
    const expired = await db
      .select({ id: user_notification_history.id })
      .from(user_notification_history)
      .where(lt(user_notification_history.created_at, cutoff))
      .orderBy(asc(user_notification_history.created_at), asc(user_notification_history.id))
      .limit(PRUNE_BATCH_SIZE);

    if (expired.length === 0) {
      return { deleted, hasMore: false };
    }

    const removed = await db
      .delete(user_notification_history)
      .where(
        inArray(
          user_notification_history.id,
          expired.map(row => row.id)
        )
      )
      .returning({ id: user_notification_history.id });
    deleted += removed.length;

    if (expired.length < PRUNE_BATCH_SIZE) {
      return { deleted, hasMore: false };
    }
  }

  return { deleted, hasMore: true };
}
