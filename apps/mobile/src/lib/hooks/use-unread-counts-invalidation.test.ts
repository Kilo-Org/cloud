import { describe, expect, it } from 'vitest';

import { unreadCountsInvalidationKeyForNotification } from './unread-counts-invalidation-cache';

describe('unreadCountsInvalidationKeyForNotification', () => {
  it('invalidates badges for the current user on chat message notifications', () => {
    expect(
      unreadCountsInvalidationKeyForNotification('user-1', {
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })
    ).toEqual(['badges', 'user-1']);
  });

  it('does not invalidate badges before the current user is known', () => {
    expect(
      unreadCountsInvalidationKeyForNotification(null, {
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })
    ).toBeNull();
  });
});
