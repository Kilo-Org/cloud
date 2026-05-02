import { QueryClient } from '@tanstack/react-query';
import type {
  ConversationActivityEvent,
  ConversationCreatedEvent,
  ConversationLeftEvent,
  ConversationListItem,
  ConversationReadEvent,
  ConversationRenamedEvent,
} from '@kilocode/kilo-chat';
import {
  conversationsKey,
  registerConversationListCacheHandlers,
  type ConversationListInfiniteData,
} from '@kilocode/kilo-chat-hooks';
import { kiloclawInstanceContext } from '@kilocode/event-service';

type ConversationActivityHandler = (ctx: string, event: ConversationActivityEvent) => void;
type ConversationCreatedHandler = (ctx: string, event: ConversationCreatedEvent) => void;
type ConversationRenamedHandler = (ctx: string, event: ConversationRenamedEvent) => void;
type ConversationLeftHandler = (ctx: string, event: ConversationLeftEvent) => void;
type ConversationReadHandler = (ctx: string, event: ConversationReadEvent) => void;

type FakeKiloChatClient = {
  onConversationCreated: (handler: ConversationCreatedHandler) => () => void;
  onConversationRenamed: (handler: ConversationRenamedHandler) => () => void;
  onConversationLeft: (handler: ConversationLeftHandler) => () => void;
  onConversationRead: (handler: ConversationReadHandler) => () => void;
  onConversationActivity: (handler: ConversationActivityHandler) => () => void;
};

function conversation(
  conversationId: string,
  overrides: Partial<ConversationListItem> = {}
): ConversationListItem {
  return {
    conversationId,
    title: null,
    lastActivityAt: overrides.lastActivityAt ?? null,
    lastReadAt: overrides.lastReadAt ?? null,
    joinedAt: overrides.joinedAt ?? 1,
  };
}

function conversationsData(conversations: ConversationListItem[]): ConversationListInfiniteData {
  return {
    pages: [{ conversations, hasMore: false, nextCursor: null }],
    pageParams: [null],
  };
}

function createFakeKiloChatClient(): FakeKiloChatClient & {
  emitActivity: (event: ConversationActivityEvent) => void;
} {
  let activityHandler: ConversationActivityHandler | null = null;
  const ignoredSubscribe = () => () => {};

  return {
    onConversationCreated: ignoredSubscribe,
    onConversationRenamed: ignoredSubscribe,
    onConversationLeft: ignoredSubscribe,
    onConversationRead: ignoredSubscribe,
    onConversationActivity: handler => {
      activityHandler = handler;
      return () => {
        activityHandler = null;
      };
    },
    emitActivity: event => {
      activityHandler?.(kiloclawInstanceContext('sandbox-active'), event);
    },
  };
}

function createFakeEventService() {
  let reconnectHandler: (() => void) | null = null;

  return {
    onReconnect: (handler: () => void) => {
      reconnectHandler = handler;
      return () => {
        reconnectHandler = null;
      };
    },
    emitReconnect: () => {
      reconnectHandler?.();
    },
  };
}

describe('KiloChatLayout cache subscriptions', () => {
  it('scopes activity updates and reconnect invalidation to the active sandbox conversation query', () => {
    const queryClient = new QueryClient();
    const activeKey = conversationsKey('sandbox-active');
    const otherKey = conversationsKey('sandbox-other');
    const kiloChatClient = createFakeKiloChatClient();
    const eventService = createFakeEventService();

    queryClient.setQueryData(
      activeKey,
      conversationsData([
        conversation('active-newer', { lastActivityAt: 200, joinedAt: 200 }),
        conversation('active-target', { lastActivityAt: 100, joinedAt: 100 }),
      ])
    );
    queryClient.setQueryData(
      otherKey,
      conversationsData([
        conversation('other-newer', { lastActivityAt: 300, joinedAt: 300 }),
        conversation('other-target', { lastActivityAt: 100, joinedAt: 100 }),
      ])
    );

    registerConversationListCacheHandlers({
      currentUserId: 'member-1',
      eventService,
      kiloChatClient,
      queryClient,
      queryKey: activeKey,
      sandboxId: 'sandbox-active',
    });

    kiloChatClient.emitActivity({
      conversationId: 'active-target',
      lastActivityAt: 400,
    });

    expect(
      queryClient
        .getQueryData<ConversationListInfiniteData>(activeKey)
        ?.pages.flatMap(page => page.conversations.map(c => c.conversationId))
    ).toEqual(['active-target', 'active-newer']);
    expect(
      queryClient
        .getQueryData<ConversationListInfiniteData>(otherKey)
        ?.pages.flatMap(page => page.conversations.map(c => c.conversationId))
    ).toEqual(['other-newer', 'other-target']);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);

    eventService.emitReconnect();

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});
