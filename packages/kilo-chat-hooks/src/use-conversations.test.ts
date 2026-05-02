import type { ConversationListItem } from '@kilocode/kilo-chat';
import { ulidToTimestamp } from '@kilocode/kilo-chat';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { conversationsKey } from './query-keys';
import {
  applyConversationActivityToPages,
  applyConversationCreatedToPages,
  applyOptimisticMarkConversationRead,
  rollbackOptimisticMarkConversationRead,
  settleMarkConversationRead,
  settleCreateConversation,
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

function firstConversationLastReadAt(
  data: ConversationListInfiniteData | undefined
): number | null | undefined {
  return data?.pages[0]?.conversations[0]?.lastReadAt;
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

describe('applyConversationCreatedToPages', () => {
  it('inserts a created conversation into the first loaded page in sorted order', () => {
    const data = conversationsData(
      [[conversation('conversation-a', { lastActivityAt: 100, joinedAt: 100 })]],
      [null]
    );
    const created = conversation('conversation-b', { lastActivityAt: null, joinedAt: 200 });

    const result = applyConversationCreatedToPages(data, created);

    expect(result.applied).toBe(true);
    expect(result.data?.pages[0]?.conversations.map(c => c.conversationId)).toEqual([
      'conversation-b',
      'conversation-a',
    ]);
  });

  it('falls back to invalidation when the created row belongs beyond the loaded window', () => {
    const data = conversationsData(
      [[conversation('conversation-a', { lastActivityAt: 300, joinedAt: 300 })]],
      ['cursor-1']
    );
    const created = conversation('conversation-b', { lastActivityAt: null, joinedAt: 100 });

    const result = applyConversationCreatedToPages(data, created);

    expect(result.applied).toBe(false);
    expect(result.data).toBe(data);
  });
});

describe('settleCreateConversation', () => {
  it('invalidates only the target sandbox when create fallback cannot patch it', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');
    const otherKey = conversationsKey('sandbox-b');

    queryClient.setQueryData(
      activeKey,
      conversationsData(
        [[conversation('conversation-a', { lastActivityAt: 300, joinedAt: 300 })]],
        ['cursor-1']
      )
    );
    queryClient.setQueryData(
      otherKey,
      conversationsData(
        [[conversation('conversation-b', { lastActivityAt: 300, joinedAt: 300 })]],
        [null]
      )
    );

    settleCreateConversation(
      queryClient,
      { sandboxId: 'sandbox-a' },
      {
        conversationId: 'conversation-created',
        conversation: conversation('conversation-created', { lastActivityAt: null, joinedAt: 100 }),
      }
    );

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});

describe('applyOptimisticMarkConversationRead', () => {
  it('patches only the active sandbox conversation query when sandbox context is provided', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');
    const otherKey = conversationsKey('sandbox-b');
    const messageId = '01K8ZB8B3H9BRWZ6KCN39AX09G';
    const optimisticReadAt = ulidToTimestamp(messageId);

    queryClient.setQueryData(
      activeKey,
      conversationsData([[conversation('conversation-1', {})]], [null])
    );
    queryClient.setQueryData(
      otherKey,
      conversationsData([[conversation('conversation-1', {})]], [null])
    );

    applyOptimisticMarkConversationRead(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-1',
      lastSeenMessageId: messageId,
    });

    expect(firstConversationLastReadAt(queryClient.getQueryData(activeKey))).toBe(optimisticReadAt);
    expect(firstConversationLastReadAt(queryClient.getQueryData(otherKey))).toBeNull();
  });

  it('invalidates only the active sandbox conversation query when rollback sees newer local state', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');
    const otherKey = conversationsKey('sandbox-b');
    const messageId = '01K8ZB8B3H9BRWZ6KCN39AX09G';
    const optimisticReadAt = ulidToTimestamp(messageId);

    queryClient.setQueryData(
      activeKey,
      conversationsData([[conversation('conversation-1', {})]], [null])
    );
    queryClient.setQueryData(
      otherKey,
      conversationsData([[conversation('conversation-1', {})]], [null])
    );

    const context = applyOptimisticMarkConversationRead(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-1',
      lastSeenMessageId: messageId,
    });
    queryClient.setQueryData(
      activeKey,
      conversationsData(
        [[{ ...conversation('conversation-1', {}), lastReadAt: optimisticReadAt + 1 }]],
        [null]
      )
    );

    rollbackOptimisticMarkConversationRead(queryClient, context);

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it('does not optimistically move a newer read marker backwards', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');
    const messageId = '01K8ZB8B3H9BRWZ6KCN39AX09G';
    const optimisticReadAt = ulidToTimestamp(messageId);

    queryClient.setQueryData(
      activeKey,
      conversationsData(
        [[{ ...conversation('conversation-1', {}), lastReadAt: optimisticReadAt + 1 }]],
        [null]
      )
    );

    applyOptimisticMarkConversationRead(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-1',
      lastSeenMessageId: messageId,
    });

    expect(firstConversationLastReadAt(queryClient.getQueryData(activeKey))).toBe(
      optimisticReadAt + 1
    );
  });

  it('settles optimistic read state from the server response', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');
    const messageId = '01K8ZB8B3H9BRWZ6KCN39AX09G';
    const serverReadAt = ulidToTimestamp(messageId);

    queryClient.setQueryData(
      activeKey,
      conversationsData([[conversation('conversation-1', {})]], [null])
    );
    const context = applyOptimisticMarkConversationRead(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-1',
      lastSeenMessageId: messageId,
    });

    settleMarkConversationRead(queryClient, context, {
      ok: true,
      applied: true,
      lastReadAt: serverReadAt,
      badgeClear: null,
    });

    expect(firstConversationLastReadAt(queryClient.getQueryData(activeKey))).toBe(serverReadAt);
    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(false);
  });
});
