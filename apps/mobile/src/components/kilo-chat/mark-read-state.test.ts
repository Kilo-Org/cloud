import { describe, expect, it } from 'vitest';

import {
  createMarkReadState,
  finishMarkReadAttempt,
  shouldStartMarkReadAttempt,
  startMarkReadAttempt,
  succeedMarkReadAttempt,
} from '@kilocode/kilo-chat-hooks';
import { markReadConversationAndBadge } from './hooks/mark-read-operation';

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

describe('markReadConversationAndBadge', () => {
  it('does not reject or prevent read-marker success when badge clearing fails', async () => {
    const state = createMarkReadState();
    const marker = 'conversation-1:message-1';
    let membershipReadCount = 0;
    let badgeReadCount = 0;

    startMarkReadAttempt(state, marker);
    const result = await markReadConversationAndBadge({
      conversationId: 'conversation-1',
      lastSeenMessageId: 'message-1',
      badgeBucket: 'bucket-1',
      notificationsUrl: 'https://notifications.example',
      markConversationRead: async () => {
        await Promise.resolve();
        membershipReadCount += 1;
      },
      getToken: async () => {
        await Promise.resolve();
        return 'token-1';
      },
      fetchBadgeRead: async () => {
        await Promise.resolve();
        badgeReadCount += 1;
        return new Response('{}', { status: 500 });
      },
    });
    succeedMarkReadAttempt(state, marker);
    finishMarkReadAttempt(state, marker);

    expect(result).toBeNull();
    expect(membershipReadCount).toBe(1);
    expect(badgeReadCount).toBe(1);
    expect(shouldStartMarkReadAttempt(state, marker)).toBe(false);
  });
});
