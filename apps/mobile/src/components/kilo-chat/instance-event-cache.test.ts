import { type ConversationListInfiniteData } from '@kilocode/kilo-chat-hooks';
import { describe, expect, it } from 'vitest';

import {
  isConversationOnFirstPage,
  shouldApplyConversationRead,
} from './hooks/instance-event-cache';

function conversation(conversationId: string) {
  return {
    conversationId,
    title: null,
    lastActivityAt: null,
    lastReadAt: null,
    joinedAt: 1,
  };
}

describe('instance event cache helpers', () => {
  it('only treats conversations in the first loaded page as locally patchable for created/activity', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        { conversations: [conversation('first')], hasMore: true, nextCursor: 'cursor-1' },
        { conversations: [conversation('second')], hasMore: false, nextCursor: null },
      ],
      pageParams: [null, 'cursor-1'],
    };

    expect(isConversationOnFirstPage(data, 'first')).toBe(true);
    expect(isConversationOnFirstPage(data, 'second')).toBe(false);
    expect(isConversationOnFirstPage(undefined, 'first')).toBe(false);
  });

  it('applies conversation.read only for the current user', () => {
    expect(shouldApplyConversationRead('reader', 'reader')).toBe(true);
    expect(shouldApplyConversationRead('reader', 'other')).toBe(false);
    expect(shouldApplyConversationRead(null, 'reader')).toBe(false);
  });
});
