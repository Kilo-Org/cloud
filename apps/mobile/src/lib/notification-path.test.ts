import { describe, expect, it } from 'vitest';
import { pushDataSchema } from '@kilocode/notifications';

import { CHAT_STACK_ROUTE_NAME } from './app-stack-routes';
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

  it('keeps the registered stack route on the sandbox-id chat segment', () => {
    expect(CHAT_STACK_ROUTE_NAME).toBe('chat/[sandbox-id]');
    expect(
      notificationPathForData({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })
    ).toContain('/chat/sandbox-1/');
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

describe('pushDataSchema', () => {
  it('rejects empty chat notification IDs', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: '',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      }).success
    ).toBe(false);
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: '',
        messageId: 'message-1',
      }).success
    ).toBe(false);
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: '',
      }).success
    ).toBe(false);
  });

  it('accepts valid chat and lifecycle notification data', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      }).success
    ).toBe(true);
    expect(
      pushDataSchema.safeParse({
        type: 'instance-lifecycle',
        event: 'ready',
        sandboxId: 'sandbox-1',
      }).success
    ).toBe(true);
  });
});
