import type { ConversationListItem } from '@kilocode/kilo-chat';
import { describe, expect, it } from 'vitest';

import {
  applyConversationActivityToPages,
  type ConversationListInfiniteData,
} from './use-conversations';

function conversation(
  conversationId: string,
  overrides: {
    lastActivityAt?: number | null;
    joinedAt?: number;
  }
): ConversationListItem {
  return {
    conversationId,
    title: null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    lastReadAt: null,
    joinedAt: overrides.joinedAt ?? 1,
  };
}

function conversationsData(
  pages: ConversationListItem[][],
  nextCursors: Array<string | null>
): ConversationListInfiniteData {
  return {
    pages: pages.map((conversations, index) => ({
      conversations,
      hasMore: nextCursors[index] !== null,
      nextCursor: nextCursors[index] ?? null,
    })),
    pageParams: [null, ...nextCursors.slice(0, -1)],
  };
}

function flattenedIds(data: ConversationListInfiniteData | undefined): string[] {
  return data?.pages.flatMap(page => page.conversations.map(c => c.conversationId)) ?? [];
}

function expectCompleteLoadedOrder(
  data: ConversationListInfiniteData | undefined,
  expectedIds: string[]
) {
  const ids = flattenedIds(data);
  expect(ids).toEqual(expectedIds);
  expect(new Set(ids).size).toBe(expectedIds.length);
  expect([...ids].sort()).toEqual([...expectedIds].sort());
}

describe('applyConversationActivityToPages', () => {
  it('moves a page-2 row ahead of page 1 with complete loaded-row repartitioning', () => {
    const data = conversationsData(
      [
        [
          conversation('conversation-a', { lastActivityAt: 300, joinedAt: 300 }),
          conversation('conversation-b', { lastActivityAt: 250, joinedAt: 250 }),
        ],
        [
          conversation('conversation-c', { lastActivityAt: 200, joinedAt: 200 }),
          conversation('conversation-d', { lastActivityAt: 150, joinedAt: 150 }),
        ],
      ],
      ['cursor-1', null]
    );

    const result = applyConversationActivityToPages(data, {
      conversationId: 'conversation-d',
      lastActivityAt: 400,
    });

    expect(result.applied).toBe(true);
    expectCompleteLoadedOrder(result.data, [
      'conversation-d',
      'conversation-a',
      'conversation-b',
      'conversation-c',
    ]);
    expect(result.data?.pages.map(page => page.conversations.length)).toEqual([2, 2]);
    expect(result.data?.pages.map(page => page.nextCursor)).toEqual(['cursor-1', null]);
  });

  it('moves a page-2 row only within later loaded rows when page 1 still sorts ahead', () => {
    const data = conversationsData(
      [
        [
          conversation('conversation-a', { lastActivityAt: 500, joinedAt: 500 }),
          conversation('conversation-b', { lastActivityAt: 450, joinedAt: 450 }),
        ],
        [
          conversation('conversation-c', { lastActivityAt: 300, joinedAt: 300 }),
          conversation('conversation-d', { lastActivityAt: 200, joinedAt: 200 }),
          conversation('conversation-e', { lastActivityAt: 100, joinedAt: 100 }),
        ],
      ],
      ['cursor-1', null]
    );

    const result = applyConversationActivityToPages(data, {
      conversationId: 'conversation-e',
      lastActivityAt: 250,
    });

    expect(result.applied).toBe(true);
    expectCompleteLoadedOrder(result.data, [
      'conversation-a',
      'conversation-b',
      'conversation-c',
      'conversation-e',
      'conversation-d',
    ]);
    expect(result.data?.pages.map(page => page.conversations.length)).toEqual([2, 3]);
  });

  it('treats stale page-2 activity as applied without changing loaded rows', () => {
    const data = conversationsData(
      [
        [
          conversation('conversation-a', { lastActivityAt: 500, joinedAt: 500 }),
          conversation('conversation-b', { lastActivityAt: 450, joinedAt: 450 }),
        ],
        [
          conversation('conversation-c', { lastActivityAt: 300, joinedAt: 300 }),
          conversation('conversation-d', { lastActivityAt: 200, joinedAt: 200 }),
        ],
      ],
      ['cursor-1', null]
    );

    const result = applyConversationActivityToPages(data, {
      conversationId: 'conversation-d',
      lastActivityAt: 150,
    });

    expect(result.applied).toBe(true);
    expect(result.data).toBe(data);
    expectCompleteLoadedOrder(result.data, [
      'conversation-a',
      'conversation-b',
      'conversation-c',
      'conversation-d',
    ]);
  });
});
