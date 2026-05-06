import type {
  ConversationActivityEvent,
  ConversationDetail,
  ConversationListItem,
} from '@kilocode/kilo-chat';
import { ulidToTimestamp } from '@kilocode/kilo-chat';
import { kiloclawInstanceContext } from '@kilocode/event-service';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { conversationKey, conversationsKey, messagesKey } from './query-keys';
import {
  applyConversationActivityToPages,
  applyConversationCreatedToPages,
  applyConversationReadToPages,
  applyOptimisticLeaveConversation,
  applyOptimisticMarkConversationRead,
  rollbackOptimisticLeaveConversation,
  rollbackOptimisticMarkConversationRead,
  settleLeaveConversation,
  settleMarkConversationRead,
  settleCreateConversation,
  settleRenameConversation,
  registerConversationListCacheHandlers,
  type ConversationListInfiniteData,
  shouldApplyConversationRead,
} from './use-conversations';

function conversation(
  conversationId: string,
  overrides: {
    lastActivityAt?: number | null;
    lastReadAt?: number | null;
    joinedAt?: number;
  }
): ConversationListItem {
  return {
    conversationId,
    title: null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    lastReadAt: overrides.lastReadAt ?? null,
    joinedAt: overrides.joinedAt ?? 1,
  };
}

function conversationDetail(overrides: Partial<ConversationDetail> = {}): ConversationDetail {
  return {
    id: 'conversation-a',
    title: 'Original conversation',
    createdBy: 'user-1',
    createdAt: 1710000000000,
    members: [{ id: 'user-1', kind: 'user' }],
    ...overrides,
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
      [null, null]
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
    expect(result.data?.pages.map(page => page.nextCursor)).toEqual([null, null]);
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
      [null, null]
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

  it('falls back to invalidation when incomplete loaded pages would need repartitioning', () => {
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

    expect(result.applied).toBe(false);
    expect(result.data).toBe(data);
  });

  it('updates incomplete loaded pages in place when activity does not change ordering', () => {
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
      lastActivityAt: 250,
    });

    expect(result.applied).toBe(true);
    expectCompleteLoadedOrder(result.data, [
      'conversation-a',
      'conversation-b',
      'conversation-c',
      'conversation-d',
    ]);
    expect(result.data?.pages[1]?.conversations[1]?.lastActivityAt).toBe(250);
    expect(result.data?.pages.map(page => page.nextCursor)).toEqual(['cursor-1', null]);
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

describe('conversation read helpers', () => {
  it('applies conversation.read only for the current user', () => {
    expect(shouldApplyConversationRead('reader', 'reader')).toBe(true);
    expect(shouldApplyConversationRead('reader', 'other')).toBe(false);
    expect(shouldApplyConversationRead(null, 'reader')).toBe(false);
  });

  it('ignores stale read updates and applies newer read updates', () => {
    const data = conversationsData(
      [
        [
          conversation('conversation-a', { lastReadAt: 200, joinedAt: 200 }),
          conversation('conversation-b', { lastReadAt: null, joinedAt: 100 }),
        ],
      ],
      [null]
    );

    const stale = applyConversationReadToPages(data, {
      conversationId: 'conversation-a',
      lastReadAt: 100,
    });
    const newer = applyConversationReadToPages(stale.data, {
      conversationId: 'conversation-a',
      lastReadAt: 300,
    });

    expect(stale.applied).toBe(true);
    expect(stale.data).toBe(data);
    expect(
      stale.data?.pages[0]?.conversations.find(
        current => current.conversationId === 'conversation-a'
      )?.lastReadAt
    ).toBe(200);
    expect(
      newer.data?.pages[0]?.conversations.find(
        current => current.conversationId === 'conversation-a'
      )?.lastReadAt
    ).toBe(300);
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

describe('settleRenameConversation', () => {
  it('invalidates only the target sandbox when sandbox context is provided', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');
    const otherKey = conversationsKey('sandbox-b');

    queryClient.setQueryData(
      activeKey,
      conversationsData([[conversation('conversation-a', {})]], [null])
    );
    queryClient.setQueryData(
      otherKey,
      conversationsData([[conversation('conversation-b', {})]], [null])
    );

    settleRenameConversation(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-a',
      title: 'Renamed conversation',
    });

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });

  it('updates active conversation detail title without waiting for an event', () => {
    const queryClient = new QueryClient();
    const detailKey = conversationKey('conversation-a');
    queryClient.setQueryData<ConversationDetail>(
      detailKey,
      conversationDetail({ id: 'conversation-a', title: 'Original conversation' })
    );

    settleRenameConversation(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-a',
      title: 'Renamed conversation',
    });

    expect(queryClient.getQueryData<ConversationDetail>(detailKey)?.title).toBe(
      'Renamed conversation'
    );
  });
});

describe('settleLeaveConversation', () => {
  it('invalidates only the target sandbox when sandbox context is provided', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');
    const otherKey = conversationsKey('sandbox-b');

    queryClient.setQueryData(
      activeKey,
      conversationsData([[conversation('conversation-a', {})]], [null])
    );
    queryClient.setQueryData(
      otherKey,
      conversationsData([[conversation('conversation-b', {})]], [null])
    );

    settleLeaveConversation(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-a',
    });

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});

describe('registerConversationListCacheHandlers', () => {
  type HandlerOptions = Parameters<typeof registerConversationListCacheHandlers>[0];
  type EventHandler<T> = (ctx: string, event: T) => void;

  it('invalidates a conversation message cache when instance activity arrives', () => {
    const queryClient = new QueryClient();
    const sandboxId = 'sandbox-a';
    const conversationId = '01KQK8A1111111111111111111';
    const listKey = conversationsKey(sandboxId);
    const messageKey = messagesKey(conversationId);
    let activityHandler: EventHandler<ConversationActivityEvent> | undefined;
    const off = () => {};

    const kiloChatClient: HandlerOptions['kiloChatClient'] = {
      onConversationCreated: () => off,
      onConversationRenamed: () => off,
      onConversationLeft: () => off,
      onConversationRead: () => off,
      onConversationActivity: handler => {
        activityHandler = handler;
        return off;
      },
    };
    const eventService: HandlerOptions['eventService'] = {
      onReconnect: () => off,
    };

    queryClient.setQueryData(
      listKey,
      conversationsData([[conversation(conversationId, { lastActivityAt: 100 })]], [null])
    );
    queryClient.setQueryData(messageKey, { stale: 'old-first-page' });

    registerConversationListCacheHandlers({
      currentUserId: 'user-current',
      eventService,
      kiloChatClient,
      queryClient,
      queryKey: listKey,
      sandboxId,
    });

    expect(queryClient.getQueryState(messageKey)?.isInvalidated).toBe(false);
    if (!activityHandler) throw new Error('activity handler was not registered');

    activityHandler(kiloclawInstanceContext(sandboxId), {
      conversationId,
      lastActivityAt: 200,
    });

    expect(queryClient.getQueryState(messageKey)?.isInvalidated).toBe(true);
  });

  it('leaves active conversation messages to the mounted message handler', () => {
    const queryClient = new QueryClient();
    const sandboxId = 'sandbox-a';
    const conversationId = '01KQK8A2222222222222222222';
    const listKey = conversationsKey(sandboxId);
    const messageKey = messagesKey(conversationId);
    let activityHandler: EventHandler<ConversationActivityEvent> | undefined;
    const off = () => {};

    const kiloChatClient: HandlerOptions['kiloChatClient'] = {
      onConversationCreated: () => off,
      onConversationRenamed: () => off,
      onConversationLeft: () => off,
      onConversationRead: () => off,
      onConversationActivity: handler => {
        activityHandler = handler;
        return off;
      },
    };
    const eventService: HandlerOptions['eventService'] = {
      onReconnect: () => off,
    };

    queryClient.setQueryData(
      listKey,
      conversationsData([[conversation(conversationId, { lastActivityAt: 100 })]], [null])
    );
    queryClient.setQueryData(messageKey, { current: 'active-first-page' });

    registerConversationListCacheHandlers({
      activeConversationId: conversationId,
      currentUserId: 'user-current',
      eventService,
      kiloChatClient,
      queryClient,
      queryKey: listKey,
      sandboxId,
    });

    if (!activityHandler) throw new Error('activity handler was not registered');

    activityHandler(kiloclawInstanceContext(sandboxId), {
      conversationId,
      lastActivityAt: 200,
    });

    expect(queryClient.getQueryState(messageKey)?.isInvalidated).toBe(false);
  });
});

describe('optimistic leave conversation rollback', () => {
  it('restores only the removed row while preserving newer sidebar patches', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-a');

    queryClient.setQueryData(
      activeKey,
      conversationsData(
        [
          [
            conversation('conversation-leave', { lastActivityAt: 300, joinedAt: 300 }),
            conversation('conversation-active', { lastActivityAt: 200, joinedAt: 200 }),
            conversation('conversation-quiet', { lastActivityAt: 100, joinedAt: 100 }),
          ],
        ],
        [null]
      )
    );

    const context = applyOptimisticLeaveConversation(queryClient, {
      sandboxId: 'sandbox-a',
      conversationId: 'conversation-leave',
    });
    const activityResult = applyConversationActivityToPages(queryClient.getQueryData(activeKey), {
      conversationId: 'conversation-quiet',
      lastActivityAt: 500,
    });
    queryClient.setQueryData(activeKey, activityResult.data);
    const createResult = applyConversationCreatedToPages(
      queryClient.getQueryData(activeKey),
      conversation('conversation-created', { lastActivityAt: 450, joinedAt: 450 })
    );
    queryClient.setQueryData(activeKey, createResult.data);
    queryClient.setQueryData<ConversationListInfiniteData>(activeKey, old =>
      old
        ? {
            ...old,
            pages: old.pages.map(page => ({
              ...page,
              conversations: page.conversations.map(current =>
                current.conversationId === 'conversation-active'
                  ? { ...current, title: 'Renamed while leave was pending' }
                  : current
              ),
            })),
          }
        : old
    );

    rollbackOptimisticLeaveConversation(queryClient, context);

    const conversations =
      queryClient
        .getQueryData<ConversationListInfiniteData>(activeKey)
        ?.pages.flatMap(page => page.conversations) ?? [];
    expect(conversations.map(current => current.conversationId)).toEqual([
      'conversation-quiet',
      'conversation-created',
      'conversation-leave',
      'conversation-active',
    ]);
    expect(
      conversations.find(current => current.conversationId === 'conversation-quiet')
    ).toMatchObject({ lastActivityAt: 500 });
    expect(
      conversations.find(current => current.conversationId === 'conversation-active')
    ).toMatchObject({ title: 'Renamed while leave was pending' });
    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(false);
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

    expect(firstConversationLastReadAt(queryClient.getQueryData(activeKey))).toBe(
      optimisticReadAt + 1
    );
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
