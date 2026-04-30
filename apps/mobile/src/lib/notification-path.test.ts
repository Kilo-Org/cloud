import { describe, expect, it } from 'vitest';

import { notificationPathForData } from './notification-path';

describe('notificationPathForData', () => {
  it('routes chat message notifications to the conversation screen', () => {
    expect(
      notificationPathForData({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })
    ).toBe('/(app)/chat/sandbox-1/conversation-1');
  });

  it('routes ready lifecycle notifications with legacy sandbox IDs to the sandbox chat screen', () => {
    expect(
      notificationPathForData({
        type: 'instance-lifecycle',
        event: 'ready',
        sandboxId: 'abcDEF123_-',
      })
    ).toBe('/(app)/chat/abcDEF123_-');
  });

  it('routes start_failed lifecycle notifications with ki sandbox IDs to the sandbox chat screen', () => {
    expect(
      notificationPathForData({
        type: 'instance-lifecycle',
        event: 'start_failed',
        sandboxId: 'ki_deadbeef',
      })
    ).toBe('/(app)/chat/ki_deadbeef');
  });
});
