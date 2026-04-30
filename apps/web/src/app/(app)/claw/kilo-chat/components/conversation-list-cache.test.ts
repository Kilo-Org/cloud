import type { ConversationListItem } from '@kilocode/kilo-chat';
import { conversationsKey } from '@kilocode/kilo-chat-hooks';
import type { ConversationListInfiniteData } from '../hooks/useConversations';
import {
  conversationListQueryKeyForInstanceEvent,
  moveConversationToFirstPage,
} from './conversation-list-cache';

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

describe('conversationListQueryKeyForInstanceEvent', () => {
  it('ignores events from a different kilo-chat instance context', () => {
    expect(
      conversationListQueryKeyForInstanceEvent('/kiloclaw/org-sandbox', 'personal-sandbox')
    ).toBeNull();
    expect(
      conversationListQueryKeyForInstanceEvent('/kiloclaw/personal-sandbox', 'org-sandbox')
    ).toBeNull();
  });

  it('uses the exact sandbox conversation key for matching instance events', () => {
    expect(
      conversationListQueryKeyForInstanceEvent('/kiloclaw/personal-sandbox', 'personal-sandbox')
    ).toEqual(conversationsKey('personal-sandbox'));
  });
});
