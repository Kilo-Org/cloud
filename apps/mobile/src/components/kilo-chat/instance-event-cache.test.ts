import {
  type ConversationListInfiniteData,
  isConversationOnFirstPage,
  moveConversationToFirstPage,
  shouldApplyConversationRead,
} from '@kilocode/kilo-chat-hooks';
import { describe, expect, it } from 'vitest';

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

  it('moves a first-page conversation with activity to the top row', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        {
          conversations: [conversation('first'), conversation('second')],
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };

    const result = moveConversationToFirstPage(data, 'second', item => ({
      ...item,
      lastActivityAt: 123,
    }));

    expect(result?.pages[0]?.conversations.map(item => item.conversationId)).toEqual([
      'second',
      'first',
    ]);
    expect(result?.pages[0]?.conversations[0]?.lastActivityAt).toBe(123);
  });
});
