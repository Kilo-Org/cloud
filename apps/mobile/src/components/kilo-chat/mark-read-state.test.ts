import { describe, expect, it, vi } from 'vitest';

import { type BadgeCountRow } from '@kilocode/notifications';
import {
  createMarkReadState,
  finishMarkReadAttempt,
  shouldStartMarkReadAttempt,
  startMarkReadAttempt,
  succeedMarkReadAttempt,
} from '@kilocode/kilo-chat-hooks';
import {
  applyBadgeClearResult,
  filterClearedBadgeBucket,
  markReadConversation,
} from './hooks/mark-read-operation';
import { reconcileHydratedBadgeCount, totalBadgeCount } from '@/lib/badge-hydration';

type UpdateBadgeRows = (
  queryKey: readonly ['badges', string],
  updater: (badges: BadgeCountRow[] | undefined) => BadgeCountRow[] | undefined
) => void;

function createUpdateBadgeRowsMock() {
  return vi.fn<UpdateBadgeRows>((queryKey, updater) => {
    expect(queryKey[0]).toBe('badges');
    void updater(undefined);
  });
}

describe('mark-read attempt state', () => {
  it('retries the same visible message after a failed attempt settles', () => {
    const state = createMarkReadState();
    const marker = 'conversation-1:message-1';

    expect(shouldStartMarkReadAttempt(state, marker)).toBe(true);

    startMarkReadAttempt(state, marker);
    expect(shouldStartMarkReadAttempt(state, marker)).toBe(false);

    finishMarkReadAttempt(state, marker);
    expect(shouldStartMarkReadAttempt(state, marker)).toBe(true);
  });

  it('does not retry the same visible message after a successful attempt settles', () => {
    const state = createMarkReadState();
    const marker = 'conversation-1:message-1';

    startMarkReadAttempt(state, marker);
    succeedMarkReadAttempt(state, marker);
    finishMarkReadAttempt(state, marker);

    expect(shouldStartMarkReadAttempt(state, marker)).toBe(false);
  });
});

describe('markReadConversation', () => {
  it('uses the Kilo Chat response without calling the raw Notifications badge endpoint', async () => {
    const state = createMarkReadState();
    const marker = 'conversation-1:message-1';
    let membershipReadCount = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    try {
      startMarkReadAttempt(state, marker);
      const result = await markReadConversation({
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        lastSeenMessageId: 'message-1',
        markConversationRead: async () => {
          await Promise.resolve();
          membershipReadCount += 1;
          return { ok: true, applied: true, lastReadAt: 1, badgeClear: null };
        },
      });
      succeedMarkReadAttempt(state, marker);
      finishMarkReadAttempt(state, marker);

      expect(result).toEqual({ ok: true, applied: true, lastReadAt: 1, badgeClear: null });
      expect(membershipReadCount).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(shouldStartMarkReadAttempt(state, marker)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('leaves badge rows untouched when the Kilo Chat response did not clear the bucket', () => {
    const badgeRows = [
      { badgeBucket: 'bucket-1', badgeCount: 2 },
      { badgeBucket: 'bucket-2', badgeCount: 1 },
    ];

    expect(filterClearedBadgeBucket(badgeRows, null)).toBe(badgeRows);
  });

  it('removes only the returned cleared badge row', () => {
    expect(
      filterClearedBadgeBucket(
        [
          { badgeBucket: 'bucket-1', badgeCount: 2 },
          { badgeBucket: 'bucket-2', badgeCount: 1 },
        ],
        { badgeBucket: 'bucket-2', badgeCount: 1 }
      )
    ).toEqual([{ badgeBucket: 'bucket-1', badgeCount: 2 }]);
  });

  it('does not update badge cache or OS badge count when badgeClear is null', () => {
    const updateBadgeRows = createUpdateBadgeRowsMock();
    const setBadgeCount = vi.fn<(badgeCount: number) => Promise<boolean>>(async () => {
      const result = await Promise.resolve(true);
      return result;
    });

    const applied = applyBadgeClearResult({
      badgeClear: null,
      startBadgeFreshnessEpoch: 0,
      currentBadgeFreshnessEpoch: 0,
      userId: 'user-1',
      updateBadgeRows,
      setBadgeCount,
    });

    expect(applied).toBe(false);
    expect(updateBadgeRows).not.toHaveBeenCalled();
    expect(setBadgeCount).not.toHaveBeenCalled();
  });

  it('updates badge cache and OS badge count when badgeClear includes a count with unchanged freshness', () => {
    const updateBadgeRows = createUpdateBadgeRowsMock();
    const setBadgeCount = vi.fn<(badgeCount: number) => Promise<boolean>>(async () => {
      const result = await Promise.resolve(true);
      return result;
    });

    const applied = applyBadgeClearResult({
      badgeClear: { badgeBucket: 'server-bucket', badgeCount: 3 },
      startBadgeFreshnessEpoch: 4,
      currentBadgeFreshnessEpoch: 4,
      userId: 'user-1',
      updateBadgeRows,
      setBadgeCount,
    });

    expect(applied).toBe(true);
    expect(updateBadgeRows).toHaveBeenCalledOnce();
    expect(updateBadgeRows).toHaveBeenCalledWith(['badges', 'user-1'], expect.any(Function));
    expect(setBadgeCount).toHaveBeenCalledWith(3);
  });

  it('keeps badge cache updates but skips stale OS badge counts when freshness advanced', () => {
    const updateBadgeRows = createUpdateBadgeRowsMock();
    const setBadgeCount = vi.fn<(badgeCount: number) => Promise<boolean>>(async () => {
      const result = await Promise.resolve(true);
      return result;
    });

    const applied = applyBadgeClearResult({
      badgeClear: { badgeBucket: 'server-bucket', badgeCount: 0 },
      startBadgeFreshnessEpoch: 8,
      currentBadgeFreshnessEpoch: 9,
      userId: 'user-1',
      updateBadgeRows,
      setBadgeCount,
    });

    expect(applied).toBe(false);
    expect(updateBadgeRows).toHaveBeenCalledOnce();
    expect(updateBadgeRows).toHaveBeenCalledWith(['badges', 'user-1'], expect.any(Function));
    expect(setBadgeCount).not.toHaveBeenCalled();
  });
});

describe('badge hydration reconciliation', () => {
  it('totals all hydrated badge buckets for the native OS badge', () => {
    expect(
      totalBadgeCount([
        { badgeBucket: 'kiloclaw:sandbox-1', badgeCount: 2 },
        { badgeBucket: 'kiloclaw:sandbox-1:conversation-1', badgeCount: 3 },
      ])
    ).toBe(5);
  });

  it('updates the native OS badge when hydration is still fresh', () => {
    const setBadgeCount = vi.fn<(badgeCount: number) => Promise<boolean>>(async () => {
      const result = await Promise.resolve(true);
      return result;
    });

    const applied = reconcileHydratedBadgeCount({
      badgeRows: [
        { badgeBucket: 'kiloclaw:sandbox-1', badgeCount: 2 },
        { badgeBucket: 'kiloclaw:sandbox-1:conversation-1', badgeCount: 3 },
      ],
      startBadgeFreshnessEpoch: 10,
      currentBadgeFreshnessEpoch: 10,
      setBadgeCount,
    });

    expect(applied).toBe(true);
    expect(setBadgeCount).toHaveBeenCalledWith(5);
  });

  it('does not overwrite a newer native OS badge update from stale hydration', () => {
    const setBadgeCount = vi.fn<(badgeCount: number) => Promise<boolean>>(async () => {
      const result = await Promise.resolve(true);
      return result;
    });

    const applied = reconcileHydratedBadgeCount({
      badgeRows: [{ badgeBucket: 'kiloclaw:sandbox-1', badgeCount: 4 }],
      startBadgeFreshnessEpoch: 10,
      currentBadgeFreshnessEpoch: 11,
      setBadgeCount,
    });

    expect(applied).toBe(false);
    expect(setBadgeCount).not.toHaveBeenCalled();
  });
});
