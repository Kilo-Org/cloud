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

  it('routes lifecycle notifications to the sandbox chat screen', () => {
    expect(
      notificationPathForData({
        type: 'instance-lifecycle',
        event: 'ready',
        instanceId: 'instance-1',
        sandboxId: 'sandbox-1',
      })
    ).toBe('/(app)/chat/sandbox-1');
  });
});
