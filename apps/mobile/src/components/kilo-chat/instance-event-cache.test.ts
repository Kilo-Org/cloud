import {
  applyConversationActivityToPages,
  applyConversationCreatedToPages,
  applyConversationReadToPages,
  applyMarkConversationReadRollbackToPages,
  type ConversationListInfiniteData,
  updateConversationPages,
} from '@kilocode/kilo-chat-hooks';
import { describe, expect, it } from 'vitest';

import { shouldApplyConversationRead } from './hooks/instance-event-cache';

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
  it('inserts conversation.created rows into patchable first-page windows', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        { conversations: [conversation('first')], hasMore: true, nextCursor: 'cursor-1' },
        { conversations: [conversation('second')], hasMore: false, nextCursor: null },
      ],
      pageParams: [null, 'cursor-1'],
    };

    const result = applyConversationCreatedToPages(
      data,
      conversation('01ARZ3NDEKTSV4RRFFQ69G5FA9', { joinedAt: 2 })
    );

    expect(result.applied).toBe(true);
    expect(result.data?.pages[0]?.conversations[0]?.conversationId).toBe(
      '01ARZ3NDEKTSV4RRFFQ69G5FA9'
    );
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

  it('ignores stale activity for a first-page conversation without invalidating', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        {
          conversations: [
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA1', { lastActivityAt: 200, joinedAt: 100 }),
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA2', { lastActivityAt: 150, joinedAt: 150 }),
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };

    const result = applyConversationActivityToPages(data, {
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      lastActivityAt: 100,
    });

    expect(result.applied).toBe(true);
    expect(result.data).toBe(data);
    expect(result.data?.pages[0]?.conversations.map(c => c.conversationId)).toEqual([
      '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      '01ARZ3NDEKTSV4RRFFQ69G5FA2',
    ]);
    expect(result.data?.pages[0]?.conversations[0]?.lastActivityAt).toBe(200);
  });

  it('ignores stale read updates and applies newer read updates', () => {
    const data: ConversationListInfiniteData = {
      pages: [
        {
          conversations: [
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA1', { lastReadAt: 200 }),
            conversation('01ARZ3NDEKTSV4RRFFQ69G5FA2', { lastReadAt: null }),
          ],
          hasMore: false,
          nextCursor: null,
        },
      ],
      pageParams: [null],
    };

    const stale = applyConversationReadToPages(data, {
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      lastReadAt: 100,
    });
    const newer = applyConversationReadToPages(stale.data, {
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      lastReadAt: 300,
    });

    expect(stale.applied).toBe(true);
    expect(stale.data).toBe(data);
    expect(stale.data?.pages[0]?.conversations[0]?.lastReadAt).toBe(200);
    expect(newer.applied).toBe(true);
    expect(newer.data?.pages[0]?.conversations[0]?.lastReadAt).toBe(300);
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
