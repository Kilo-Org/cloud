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

  it('does not update the badge cache when badgeClear is null', () => {
    const updateBadgeRows = createUpdateBadgeRowsMock();

    applyBadgeClearResult({
      badgeClear: null,
      userId: 'user-1',
      updateBadgeRows,
    });

    expect(updateBadgeRows).not.toHaveBeenCalled();
  });

  it('updates the badge cache when badgeClear contains a cleared row', () => {
    const updateBadgeRows = createUpdateBadgeRowsMock();

    applyBadgeClearResult({
      badgeClear: { badgeBucket: 'server-bucket', badgeCount: 3 },
      userId: 'user-1',
      updateBadgeRows,
    });

    expect(updateBadgeRows).toHaveBeenCalledOnce();
    expect(updateBadgeRows).toHaveBeenCalledWith(['badges', 'user-1'], expect.any(Function));
  });
});
