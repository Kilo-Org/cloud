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
 * Write one history row for an accepted dispatch.
 *
 * Returns `skipped` for a kind that is not recorded (an OS-only surface with no
 * message list to reopen). Idempotent: the unique `(user_id, idempotency_key)`
 * index makes a replay a no-op, so a retried dispatch can never add a row.
 *
 * A failure is logged with the push type and the error's name only — no
 * payload, title, body, params, user id, or error message, any of which can
 * carry user content or key values — and is reported as `failed` so the caller
 * can keep the push outcome unchanged.
 */
export async function recordNotificationHistory(
  db: WorkerDb,
  input: DispatchPushInput
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
      })
      .onConflictDoNothing({
        target: [user_notification_history.user_id, user_notification_history.idempotency_key],
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
