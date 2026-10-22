import { describe, expect, it, vi } from 'vitest';
import { getTableName } from 'drizzle-orm';

import {
  NOTIFICATION_HISTORY_PRUNE_MAX_BATCHES,
  pruneNotificationHistory,
} from '../lib/notification-history-prune';
import { recordNotificationHistory } from '../lib/notification-history';
import type { WorkerDb } from '@kilocode/db/client';
import type { DispatchPushInput } from '@kilocode/notifications';

/**
 * Prune fake: it answers the two statements the job issues — the id page and
 * the delete of those ids. The predicate itself is `created_at < cutoff`, which
 * the E2E run exercises against PostgreSQL; here the point is the bounded
 * batching and the stop conditions.
 */
function fakePruneDb(pages: string[][]) {
  let page = 0;
  const deleted: string[][] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              const ids = pages[page] ?? [];
              page += 1;
              return ids.map(id => ({ id }));
            },
          }),
        }),
      }),
    }),
    delete: () => ({
      where: (predicate: unknown) => ({
        returning: async () => {
          // The predicate is an `inArray` over the ids handed to the delete.
          expect(predicate).toBeDefined();
          const ids = pages[deleted.length] ?? [];
          deleted.push(ids);
          return ids.map(id => ({ id }));
        },
      }),
    }),
  };
  return { db: db as unknown as WorkerDb, deleted };
}

const page = (count: number, prefix: string) =>
  Array.from({ length: count }, (_unused, index) => `${prefix}-${index}`);

describe('pruneNotificationHistory', () => {
  it('stops as soon as a batch comes back short', async () => {
    const { db, deleted } = fakePruneDb([page(1000, 'a'), page(5, 'b')]);

    const result = await pruneNotificationHistory(db, Date.UTC(2026, 0, 1));

    expect(result).toEqual({ deleted: 1005, hasMore: false });
    expect(deleted).toHaveLength(2);
  });

  it('reports unfinished work when the batch cap is reached', async () => {
    const fullPages = Array.from(
      { length: NOTIFICATION_HISTORY_PRUNE_MAX_BATCHES },
      (_unused, index) => page(1000, `b${index}`)
    );
    const { db, deleted } = fakePruneDb(fullPages);

    const result = await pruneNotificationHistory(db, Date.UTC(2026, 0, 1));

    expect(result).toEqual({
      deleted: NOTIFICATION_HISTORY_PRUNE_MAX_BATCHES * 1000,
      hasMore: true,
    });
    expect(deleted).toHaveLength(NOTIFICATION_HISTORY_PRUNE_MAX_BATCHES);
  });

  it('does nothing when no row is past the retention window', async () => {
    const { db, deleted } = fakePruneDb([[]]);

    const result = await pruneNotificationHistory(db, Date.UTC(2026, 0, 1));

    expect(result).toEqual({ deleted: 0, hasMore: false });
    expect(deleted).toHaveLength(0);
  });
});

function fakeHistoryDb(options: { throwOnInsert?: Error } = {}) {
  const inserts: { table: string; row: Record<string, unknown>; onConflict?: unknown }[] = [];
  const db = {
    insert: (table: Parameters<typeof getTableName>[0]) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: async (conflict: unknown) => {
          if (options.throwOnInsert) throw options.throwOnInsert;
          inserts.push({ table: getTableName(table), row, onConflict: conflict });
        },
      }),
    }),
  };
  return { db: db as unknown as WorkerDb, inserts };
}

const dispatchInput = (over: Partial<DispatchPushInput> = {}): DispatchPushInput => ({
  userId: 'user-1',
  presenceContext: null,
  idempotencyKey: 'history-key',
  badge: null,
  push: {
    title: 'Fallback',
    body: 'Fallback body',
    data: { type: 'low_balance', organizationId: 'org-1' },
    i18nKey: 'balance.low',
    i18nParams: { threshold: '5' },
  },
  ...over,
});

describe('recordNotificationHistory', () => {
  it('writes the row with the category and the content the push carried', async () => {
    const { db, inserts } = fakeHistoryDb();
    const now = Date.UTC(2026, 0, 2, 3, 30);

    const result = await recordNotificationHistory(db, dispatchInput(), now);

    expect(result).toBe('recorded');
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe('user_notification_history');
    expect(inserts[0]?.row).toEqual({
      user_id: 'user-1',
      category: 'balanceAlerts',
      push_type: 'low_balance',
      payload: { type: 'low_balance', organizationId: 'org-1' },
      i18n_key: 'balance.low',
      i18n_params: { threshold: '5' },
      fallback_title: 'Fallback',
      fallback_body: 'Fallback body',
      idempotency_key: 'history-key',
      dedupe_bucket: Math.floor(now / 3_600_000),
    });
    // The conflict target is the dispatch instance, so a retry cannot add a row.
    expect(inserts[0]?.onConflict).toBeDefined();
  });

  it('gives a later dispatch of the same key its own row identity', async () => {
    const { db, inserts } = fakeHistoryDb();
    const withinTheHour = Date.UTC(2026, 0, 2, 3, 5);
    const laterCrossing = Date.UTC(2026, 0, 2, 5, 5);

    await recordNotificationHistory(db, dispatchInput(), withinTheHour);
    await recordNotificationHistory(db, dispatchInput(), laterCrossing);

    // Same dispatch key, different acceptance hour: the unique index treats the
    // two as distinct dispatch instances, so the later crossing is not dropped.
    expect(inserts.map(insert => insert.row.dedupe_bucket)).toEqual([
      Math.floor(withinTheHour / 3_600_000),
      Math.floor(laterCrossing / 3_600_000),
    ]);
  });

  it('skips a kind with no message list without touching the database', async () => {
    const { db, inserts } = fakeHistoryDb();

    const result = await recordNotificationHistory(
      db,
      dispatchInput({
        push: {
          title: 'T',
          body: 'B',
          data: { type: 'instance-lifecycle', event: 'started', sandboxId: 'sb' },
        },
      })
    );

    expect(result).toBe('skipped');
    expect(inserts).toHaveLength(0);
  });

  it('reports a failed write without logging row content', async () => {
    const { db } = fakeHistoryDb({
      throwOnInsert: new Error('insert failed: Private conversation private_key'),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await recordNotificationHistory(db, dispatchInput());

    expect(result).toBe('failed');
    expect(warn).toHaveBeenCalledTimes(1);
    const [message, context] = warn.mock.calls[0] ?? [];
    expect(message).toBe('notification_history_write_failed');
    expect(context).toEqual({ pushType: 'low_balance', errorName: 'Error' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Private conversation');
    warn.mockRestore();
  });
});
