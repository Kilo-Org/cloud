import {
  applyConversationActivityToPages,
  type ConversationListInfiniteData,
} from '@kilocode/kilo-chat-hooks';
import { describe, expect, it } from 'vitest';

import {
  isConversationOnFirstPage,
  shouldApplyConversationRead,
} from './hooks/instance-event-cache';

function conversation(
  conversationId: string,
  overrides: {
    lastActivityAt?: number | null;
    joinedAt?: number;
  } = {}
) {
  return {
    conversationId,
    title: null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    lastReadAt: null,
    joinedAt: overrides.joinedAt ?? 1,
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

  it('moves a first-page conversation ahead after newer activity', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        {
          conversations: [
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA1', { lastActivityAt: 100, joinedAt: 100 }),
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA2', { lastActivityAt: 90, joinedAt: 90 }),
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };

    const result = applyConversationActivityToPages(data, {
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      lastActivityAt: 200,
    });

    expect(result.applied).toBe(true);
    expect(result.data?.pages[0]?.conversations.map(c => c.conversationId)).toEqual([
      '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      '01ARZ3NDEKTSV4RRFFQ69G5FA1',
    ]);
    expect(result.data?.pages[0]?.conversations[0]?.lastActivityAt).toBe(200);
  });

  it('sorts equal activity timestamps by conversation id descending', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        {
          conversations: [
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA1', { lastActivityAt: 100, joinedAt: 100 }),
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA2', { lastActivityAt: 90, joinedAt: 90 }),
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };

    const result = applyConversationActivityToPages(data, {
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      lastActivityAt: 100,
    });

    expect(result.applied).toBe(true);
    expect(result.data?.pages[0]?.conversations.map(c => c.conversationId)).toEqual([
      '01ARZ3NDEKTSV4RRFFQ69G5FA2',
      '01ARZ3NDEKTSV4RRFFQ69G5FA1',
    ]);
  });
});
