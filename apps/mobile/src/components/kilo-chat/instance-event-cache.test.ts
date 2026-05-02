import {
  applyConversationActivityToPages,
  applyMarkConversationReadRollbackToPages,
  type ConversationListInfiniteData,
  updateConversationPages,
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
    lastReadAt?: number | null;
    joinedAt?: number;
  } = {}
) {
  return {
    conversationId,
    title: null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    lastReadAt: overrides.lastReadAt ?? null,
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

  it('leaves newer read state intact when a failed optimistic mark-read rolls back', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        {
          conversations: [conversation('01ARZ3NDEKTSV4RRFFQ69G5FA1')],
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };
    const optimisticReadAt = 100;
    const newerReadAt = 200;
    const optimistic = updateConversationPages(data, c =>
      c.conversationId === '01ARZ3NDEKTSV4RRFFQ69G5FA1' ? { ...c, lastReadAt: optimisticReadAt } : c
    );
    const withNewerRead = updateConversationPages(optimistic, c =>
      c.conversationId === '01ARZ3NDEKTSV4RRFFQ69G5FA1' ? { ...c, lastReadAt: newerReadAt } : c
    );

    const result = applyMarkConversationReadRollbackToPages(withNewerRead, {
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      previousLastReadAt: null,
      optimisticReadAt,
    });

    expect(result.invalidationRequired).toBe(true);
    expect(result.data?.pages[0]?.conversations[0]?.lastReadAt).toBe(newerReadAt);
  });
});
