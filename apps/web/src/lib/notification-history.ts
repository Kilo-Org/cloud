/**
 * Read side of `user_notification_history`: a newest-first, keyset-paginated
 * page of one account's recorded pushes inside the retention window.
 *
 * The cursor encodes the last row's `(created_at, id)` and the list orders by
 * `created_at` desc with `id` desc as the tie-breaker, so a page resumes exactly
 * after its last row. `created_at` is a PostgreSQL timestamptz returned as text
 * with microsecond precision; the cursor carries that raw value verbatim
 * because normalizing through `new Date(...).toISOString()` truncates
 * microseconds and silently skips rows that share a millisecond. Deleting rows
 * (the scheduled prune) cannot invalidate a cursor: the comparison is against
 * the columns, not an offset, and a row that no longer exists is never returned.
 */

import { user_notification_history } from '@kilocode/db/schema';
import type { NotificationHistoryCategory } from '@kilocode/notifications';
import {
  NOTIFICATION_HISTORY_DEFAULT_PAGE_SIZE,
  NOTIFICATION_HISTORY_RETENTION_MS,
} from '@kilocode/notifications';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gte, lt, or } from 'drizzle-orm';

export const NOTIFICATION_HISTORY_MAX_PAGE_SIZE = 100;

export type NotificationHistoryItem = {
  id: string;
  /** Notification-settings key; null only for kinds without one (briefings). */
  category: NotificationHistoryCategory | null;
  /** The push `data.type` that produced the row. */
  pushType: string;
  /** The push `data` object, so a row can reopen the destination a tap opens. */
  payload: Record<string, unknown>;
  /** Catalog key and its params; the client renders copy from these. */
  i18nKey: string | null;
  i18nParams: Record<string, string> | null;
  /** Copy for a row whose catalog key no longer resolves. */
  title: string;
  body: string;
  createdAt: string;
};

export type NotificationHistoryPage = {
  items: NotificationHistoryItem[];
  nextCursor: string | null;
};

const CURSOR_SEPARATOR = '|';
const ROW_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(row: { created_at: string; id: string }): string {
  return `${row.created_at}${CURSOR_SEPARATOR}${row.id}`;
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  const separatorIndex = cursor.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex <= 0) return null;
  const createdAt = cursor.slice(0, separatorIndex);
  const id = cursor.slice(separatorIndex + 1);
  if (!ROW_ID_PATTERN.test(id)) return null;
  if (Number.isNaN(new Date(createdAt).getTime())) return null;
  return { createdAt, id };
}

export async function listNotificationHistory(input: {
  userId: string;
  category?: string;
  cursor?: string;
  limit?: number;
  now?: number;
}): Promise<NotificationHistoryPage> {
  const limit = Math.min(
    Math.max(1, input.limit ?? NOTIFICATION_HISTORY_DEFAULT_PAGE_SIZE),
    NOTIFICATION_HISTORY_MAX_PAGE_SIZE
  );
  const windowStart = new Date(
    (input.now ?? Date.now()) - NOTIFICATION_HISTORY_RETENTION_MS
  ).toISOString();

  const conditions = [
    eq(user_notification_history.user_id, input.userId),
    gte(user_notification_history.created_at, windowStart),
  ];
  if (input.category !== undefined) {
    conditions.push(eq(user_notification_history.category, input.category));
  }
  if (input.cursor !== undefined) {
    const cursor = decodeCursor(input.cursor);
    if (!cursor) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid notification history cursor.' });
    }
    const cursorPredicate = or(
      lt(user_notification_history.created_at, cursor.createdAt),
      and(
        eq(user_notification_history.created_at, cursor.createdAt),
        lt(user_notification_history.id, cursor.id)
      )
    );
    if (cursorPredicate) conditions.push(cursorPredicate);
  }

  const rows = await db
    .select({
      id: user_notification_history.id,
      category: user_notification_history.category,
      push_type: user_notification_history.push_type,
      payload: user_notification_history.payload,
      i18n_key: user_notification_history.i18n_key,
      i18n_params: user_notification_history.i18n_params,
      fallback_title: user_notification_history.fallback_title,
      fallback_body: user_notification_history.fallback_body,
      created_at: user_notification_history.created_at,
    })
    .from(user_notification_history)
    .where(and(...conditions))
    .orderBy(desc(user_notification_history.created_at), desc(user_notification_history.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);

  return {
    items: page.map(row => ({
      id: row.id,
      category: row.category as NotificationHistoryCategory | null,
      pushType: row.push_type,
      payload: row.payload,
      i18nKey: row.i18n_key,
      i18nParams: row.i18n_params,
      title: row.fallback_title,
      body: row.fallback_body,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  };
}
