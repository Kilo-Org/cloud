/**
 * Notification history recording (see `user_notification_history`).
 *
 * The notifications DO calls `recordNotificationHistory` at the point a push is
 * accepted. A history write is bookkeeping: it must never change the dispatch
 * outcome, and it must never put row content into a log line.
 */

import { user_notification_history } from '@kilocode/db/schema';
import type { WorkerDb } from '@kilocode/db/client';
import {
  notificationHistoryEntryForPushData,
  type DispatchPushInput,
} from '@kilocode/notifications';

export type RecordNotificationHistoryResult = 'recorded' | 'skipped' | 'failed';

/**
 * Width of the dispatch-instance bucket that joins the row's uniqueness key.
 * The worker's idempotency record survives an hour (two days for briefings),
 * and producers reuse one key for distinct events — every later crossing of a
 * balance threshold reuses `low-balance:<organizationId>`. Uniqueness on the key
 * alone would therefore drop those later accepted pushes from history for the
 * whole retention window, so the row identity is the dispatch instance: the key
 * within its acceptance hour. A retry of one dispatch is absorbed; a genuine
 * later dispatch records its own row. A retry that crosses the hour boundary can
 * only happen after the earlier attempt reached the provider and then died, so
 * two rows describe two sends.
 */
const DEDUPE_BUCKET_MS = 60 * 60 * 1000;

/**
 * Write one history row for an accepted dispatch.
 *
 * Returns `skipped` for a kind that is not recorded (an OS-only surface with no
 * message list to reopen). Idempotent per dispatch: the unique
 * `(user_id, idempotency_key, dedupe_bucket)` index makes a retry a no-op.
 *
 * A failure is logged with the push type and the error's name only — no
 * payload, title, body, params, user id, or error message, any of which can
 * carry user content or key values — and is reported as `failed` so the caller
 * can keep the push outcome unchanged.
 */
export async function recordNotificationHistory(
  db: WorkerDb,
  input: DispatchPushInput,
  now: number = Date.now()
): Promise<RecordNotificationHistoryResult> {
  const entry = notificationHistoryEntryForPushData(input.push.data);
  if (entry === null) {
    return 'skipped';
  }

  try {
    await db
      .insert(user_notification_history)
      .values({
        user_id: input.userId,
        category: entry.category,
        push_type: entry.pushType,
        payload: input.push.data,
        i18n_key: input.push.i18nKey ?? null,
        i18n_params: input.push.i18nParams ?? null,
        fallback_title: input.push.title,
        fallback_body: input.push.body,
        idempotency_key: input.idempotencyKey,
        dedupe_bucket: Math.floor(now / DEDUPE_BUCKET_MS),
      })
      .onConflictDoNothing({
        target: [
          user_notification_history.user_id,
          user_notification_history.idempotency_key,
          user_notification_history.dedupe_bucket,
        ],
      });
    return 'recorded';
  } catch (error) {
    console.warn('notification_history_write_failed', {
      pushType: entry.pushType,
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return 'failed';
  }
}
