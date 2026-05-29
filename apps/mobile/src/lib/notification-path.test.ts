import { describe, expect, it } from 'vitest';
import { pushDataSchema } from '@kilocode/notifications';

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
    ).toBe('/(app)/(tabs)/(1_kiloclaw)/chat/sandbox-1/conversation-1');
  });

  it('keeps notifications on the tab-owned KiloClaw chat route', () => {
    expect(
      notificationPathForData({
        type: 'chat.message',
        sandboxId: 'sandbox-1',
        conversationId: 'conversation-1',
        messageId: 'message-1',
      })
    ).toContain('/(app)/(tabs)/(1_kiloclaw)/chat/sandbox-1/');
  });

  it('routes ready lifecycle notifications with legacy sandbox IDs to the sandbox chat screen', () => {
    expect(
      notificationPathForData({
        type: 'instance-lifecycle',
        event: 'ready',
        sandboxId: 'abcDEF123_-',
      })
    ).toBe('/(app)/(tabs)/(1_kiloclaw)/chat/abcDEF123_-');
  });

  it('routes start_failed lifecycle notifications with ki sandbox IDs to the sandbox chat screen', () => {
    expect(
      notificationPathForData({
        type: 'instance-lifecycle',
        event: 'start_failed',
        sandboxId: 'ki_deadbeef',
      })
    ).toBe('/(app)/(tabs)/(1_kiloclaw)/chat/ki_deadbeef');
  });

  it('routes cloud agent notifications to the matching agent session', () => {
    expect(
      notificationPathForData({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
      })
    ).toBe('/(app)/agent-chat/ses_1');
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

  it('accepts valid chat, lifecycle, and cloud agent notification data', () => {
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
    expect(
      pushDataSchema.safeParse({
        type: 'cloud_agent_session',
        cliSessionId: 'ses_1',
      }).success
    ).toBe(true);
  });

  it('rejects empty cloud agent session IDs', () => {
    expect(
      pushDataSchema.safeParse({
        type: 'cloud_agent_session',
        cliSessionId: '',
      }).success
    ).toBe(false);
  });
});
