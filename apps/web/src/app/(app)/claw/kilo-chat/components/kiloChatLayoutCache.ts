import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type {
  ConversationActivityEvent,
  ConversationCreatedEvent,
  ConversationLeftEvent,
  ConversationReadEvent,
  ConversationRenamedEvent,
} from '@kilocode/kilo-chat';
import {
  applyConversationActivityToPages,
  applyConversationReadToPages,
  filterConversationPages,
  type ConversationListInfiniteData,
  updateConversationPages,
} from '../hooks/useConversations';
import { shouldApplyConversationRead } from './conversation-read-events';

type KiloChatConversationEventClient = {
  onConversationCreated: (
    handler: (ctx: string, event: ConversationCreatedEvent) => void
  ) => () => void;
  onConversationRenamed: (
    handler: (ctx: string, event: ConversationRenamedEvent) => void
  ) => () => void;
  onConversationLeft: (handler: (ctx: string, event: ConversationLeftEvent) => void) => () => void;
  onConversationRead: (handler: (ctx: string, event: ConversationReadEvent) => void) => () => void;
  onConversationActivity: (
    handler: (ctx: string, event: ConversationActivityEvent) => void
  ) => () => void;
};

type ReconnectEventService = {
  onReconnect: (handler: () => void) => () => void;
};

type RegisterKiloChatLayoutEventCacheHandlersOptions = {
  currentUserId: string | null;
  eventService: ReconnectEventService;
  kiloChatClient: KiloChatConversationEventClient;
  queryClient: QueryClient;
  queryKey: QueryKey;
};

export function registerKiloChatLayoutEventCacheHandlers({
  currentUserId,
  eventService,
  kiloChatClient,
  queryClient,
  queryKey,
}: RegisterKiloChatLayoutEventCacheHandlersOptions): () => void {
  function isOnFirstPage(conversationId: string): boolean {
    const data = queryClient.getQueryData<ConversationListInfiniteData>(queryKey);
    return data?.pages[0]?.conversations.some(c => c.conversationId === conversationId) ?? false;
  }

  const offs = [
    kiloChatClient.onConversationCreated((_ctx, event) => {
      if (isOnFirstPage(event.conversationId)) return;
      void queryClient.invalidateQueries({ queryKey });
    }),
    kiloChatClient.onConversationRenamed((_ctx, event) => {
      queryClient.setQueryData<ConversationListInfiniteData>(queryKey, old =>
        updateConversationPages(old, conversation =>
          conversation.conversationId === event.conversationId
            ? { ...conversation, title: event.title }
            : conversation
        )
      );
      void queryClient.invalidateQueries({
        queryKey: ['kilo-chat', 'conversation', event.conversationId],
      });
    }),
    kiloChatClient.onConversationLeft((_ctx, event) => {
      queryClient.setQueryData<ConversationListInfiniteData>(queryKey, old =>
        filterConversationPages(
          old,
          conversation => conversation.conversationId !== event.conversationId
        )
      );
    }),
    kiloChatClient.onConversationRead((_ctx, event) => {
      if (!shouldApplyConversationRead(currentUserId, event.memberId)) return;
      queryClient.setQueryData<ConversationListInfiniteData>(
        queryKey,
        old => applyConversationReadToPages(old, event).data
      );
    }),
    kiloChatClient.onConversationActivity((_ctx, event) => {
      const result = applyConversationActivityToPages(
        queryClient.getQueryData<ConversationListInfiniteData>(queryKey),
        event
      );
      if (!result.applied) {
        void queryClient.invalidateQueries({ queryKey });
        return;
      }
      queryClient.setQueryData<ConversationListInfiniteData>(queryKey, result.data);
    }),
    eventService.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey });
    }),
  ];

  return () => offs.forEach(off => off());
}
