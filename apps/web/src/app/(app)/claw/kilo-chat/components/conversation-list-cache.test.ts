import type { ConversationListItem } from '@kilocode/kilo-chat';
import type { ConversationListInfiniteData } from '../hooks/useConversations';
import { moveConversationToFirstPage } from './conversation-list-cache';

function conversation(
  conversationId: string,
  overrides: Partial<ConversationListItem> = {}
): ConversationListItem {
  return {
    conversationId,
    title: conversationId,
    joinedAt: 1,
    lastActivityAt: 1,
    lastReadAt: null,
    ...overrides,
  };
}

function listData(conversations: ConversationListItem[]): ConversationListInfiniteData {
  return {
    pageParams: [null],
    pages: [{ conversations, hasMore: false, nextCursor: null }],
  };
}

describe('moveConversationToFirstPage', () => {
  it('moves an updated first-page conversation to the first rendered row', () => {
    const first = conversation('first', { lastActivityAt: 100 });
    const second = conversation('second', { lastActivityAt: 50 });
    const data = listData([first, second]);

    const updated = moveConversationToFirstPage(data, 'second', item => ({
      ...item,
      lastActivityAt: 200,
    }));

    expect(updated?.pages[0]?.conversations.map(c => c.conversationId)).toEqual([
      'second',
      'first',
    ]);
    expect(updated?.pages[0]?.conversations[0]?.lastActivityAt).toBe(200);
  });
});
