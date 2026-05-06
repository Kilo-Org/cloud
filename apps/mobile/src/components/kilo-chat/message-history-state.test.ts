import { describe, expect, it } from 'vitest';

import {
  getMessageHistoryContentState,
  shouldMarkLatestMessageRead,
} from './message-history-state';

describe('getMessageHistoryContentState', () => {
  it('blocks the composer while the initial history is pending or errored', () => {
    expect(getMessageHistoryContentState({ isPending: true, isError: false, hasData: false })).toBe(
      'loading'
    );

    expect(getMessageHistoryContentState({ isPending: false, isError: true, hasData: false })).toBe(
      'error'
    );
  });

  it('allows the chat surface after the initial history loads', () => {
    expect(getMessageHistoryContentState({ isPending: false, isError: false, hasData: true })).toBe(
      'ready'
    );
  });
});

describe('shouldMarkLatestMessageRead', () => {
  it('skips mark-read when the latest visible message is from the current user', () => {
    expect(
      shouldMarkLatestMessageRead({
        currentUserId: 'user-1',
        latestMessageSenderId: 'user-1',
      })
    ).toBe(false);
  });

  it('marks latest messages from other members read', () => {
    expect(
      shouldMarkLatestMessageRead({
        currentUserId: 'user-1',
        latestMessageSenderId: 'bot:kiloclaw:sandbox-1',
      })
    ).toBe(true);
  });

  it('preserves existing behavior while the current user is unresolved', () => {
    expect(
      shouldMarkLatestMessageRead({
        currentUserId: null,
        latestMessageSenderId: 'user-1',
      })
    ).toBe(true);
  });
});
