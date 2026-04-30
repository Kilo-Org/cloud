import { describe, expect, it } from 'vitest';

import { markConversationAndBadgeRead } from './mark-read-actions';

describe('markConversationAndBadgeRead', () => {
  it('marks the kilo-chat conversation and notification badge read', async () => {
    const calls: string[] = [];

    await markConversationAndBadgeRead({
      conversationId: 'conversation-1',
      badgeBucket: 'bucket-1',
      markConversationRead: async conversationId => {
        calls.push(`conversation:${conversationId}`);
        await Promise.resolve();
      },
      markBadgeRead: async badgeBucket => {
        calls.push(`badge:${badgeBucket}`);
        await Promise.resolve();
        return { badgeCount: 3 };
      },
    });

    expect(calls).toEqual(['conversation:conversation-1', 'badge:bucket-1']);
  });
});
