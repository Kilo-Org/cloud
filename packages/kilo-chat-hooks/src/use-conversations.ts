import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { EventServiceClient } from '@kilocode/event-service';
import { kiloclawInstanceContext } from '@kilocode/event-service';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type {
  CreateConversationRequest,
  ConversationListItem,
  ConversationListResponse,
} from '@kilocode/kilo-chat';
import { useEffect } from 'react';

import { conversationKey, conversationsKey, conversationsKeyAll, messagesKey } from './query-keys';

const CONVERSATIONS_PAGE_SIZE = 50;

type MutationErrorOptions = {
  onError?: (error: unknown) => void;
};

export function useConversations(client: KiloChatClient, sandboxId: string | null) {
  return useInfiniteQuery({
    queryKey: conversationsKey(sandboxId),
    queryFn: ({ pageParam }) =>
      client.listConversations({
        sandboxId: sandboxId ?? undefined,
        limit: CONVERSATIONS_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: lastPage => lastPage.nextCursor,
    enabled: !!sandboxId,
    select: data => ({
      ...data,
      conversations: data.pages.flatMap(p => p.conversations),
    }),
  });
}

export function useConversationDetail(client: KiloChatClient, conversationId: string | null) {
  return useQuery({
    queryKey: conversationKey(conversationId),
    queryFn: () => client.getConversation(conversationId ?? ''),
    enabled: !!conversationId,
  });
}

export function useCreateConversation(client: KiloChatClient, options?: MutationErrorOptions) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateConversationRequest) => client.createConversation(req),
    onSuccess: (response, variables) => {
      queryClient.setQueryData<ConversationListInfiniteData>(
        conversationsKey(variables.sandboxId),
        old => insertConversationOnFirstPage(old, response.conversationListItem)
      );
    },
    onError: options?.onError,
  });
}

export function useRenameConversation(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
      client.renameConversation(conversationId, { title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationsKeyAll() });
    },
  });
}

export function useLeaveConversation(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => client.leaveConversation(conversationId),
    onSuccess: (_data, conversationId) => {
      queryClient.removeQueries({ queryKey: conversationKey(conversationId) });
      queryClient.removeQueries({ queryKey: messagesKey(conversationId) });
      void queryClient.invalidateQueries({ queryKey: conversationsKeyAll() });
    },
  });
}

export type ConversationListInfiniteData = InfiniteData<ConversationListResponse, string | null>;

export function insertConversationOnFirstPage(
  data: ConversationListInfiniteData | undefined,
  item: ConversationListItem
): ConversationListInfiniteData | undefined {
  if (!data) return data;
  if (
    data.pages.some(page => page.conversations.some(c => c.conversationId === item.conversationId))
  ) {
    return data;
  }
  const firstPage = data.pages[0];
  if (!firstPage) {
    return {
      ...data,
      pages: [{ conversations: [item], hasMore: false, nextCursor: null }],
    };
  }
  return {
    ...data,
    pages: [
      {
        ...firstPage,
        conversations: [item, ...firstPage.conversations],
      },
      ...data.pages.slice(1),
    ],
  };
}

export function updateConversationPages(
  data: ConversationListInfiniteData | undefined,
  mapItem: (
    c: ConversationListResponse['conversations'][number]
  ) => ConversationListResponse['conversations'][number]
): ConversationListInfiniteData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      conversations: page.conversations.map(mapItem),
    })),
  };
}

export function filterConversationPages(
  data: ConversationListInfiniteData | undefined,
  predicate: (c: ConversationListResponse['conversations'][number]) => boolean
): ConversationListInfiniteData | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      conversations: page.conversations.filter(predicate),
    })),
  };
}

type ConversationUpdater = (conversation: ConversationListItem) => ConversationListItem;

export function moveConversationToFirstPage(
  data: ConversationListInfiniteData | undefined,
  conversationId: string,
  updateConversation: ConversationUpdater
): ConversationListInfiniteData | undefined {
  if (!data) return data;

  let movedConversation: ConversationListItem | null = null;
  const pages = data.pages.map(page => {
    const nextConversations: ConversationListItem[] = [];
    for (const conversation of page.conversations) {
      if (conversation.conversationId === conversationId) {
        movedConversation = updateConversation(conversation);
        continue;
      }
      nextConversations.push(conversation);
    }
    return { ...page, conversations: nextConversations };
  });

  const firstPage = pages[0];
  if (!movedConversation || !firstPage) return data;

  return {
    ...data,
    pages: [
      { ...firstPage, conversations: [movedConversation, ...firstPage.conversations] },
      ...pages.slice(1),
    ],
  };
}

export function isConversationOnFirstPage(
  data: ConversationListInfiniteData | undefined,
  conversationId: string
): boolean {
  return (
    data?.pages[0]?.conversations.some(
      conversation => conversation.conversationId === conversationId
    ) ?? false
  );
}

export function shouldApplyConversationRead(
  currentUserId: string | null,
  memberId: string
): boolean {
  return currentUserId !== null && currentUserId === memberId;
}

type ConversationListEventUpdaterOptions = {
  onBotStatus?: () => void;
};

export function useConversationListEventUpdater(
  client: KiloChatClient,
  eventService: EventServiceClient,
  sandboxId: string | null | undefined,
  currentUserId: string | null,
  options?: ConversationListEventUpdaterOptions
): void {
  const queryClient = useQueryClient();
  const onBotStatus = options?.onBotStatus;

  useEffect(() => {
    if (!sandboxId) return;

    const context = kiloclawInstanceContext(sandboxId);
    const queryKey = conversationsKey(sandboxId);
    eventService.subscribe([context]);

    const offs = [
      client.onConversationCreated((ctx, e) => {
        if (ctx !== context) return;
        if (e.sandboxId !== sandboxId) return;
        queryClient.setQueryData<ConversationListInfiniteData>(queryKey, old =>
          insertConversationOnFirstPage(old, e.conversationListItem)
        );
      }),
      client.onConversationRenamed((ctx, e) => {
        if (ctx !== context) return;
        queryClient.setQueryData<ConversationListInfiniteData>(queryKey, old =>
          updateConversationPages(old, conversation =>
            conversation.conversationId === e.conversationId
              ? { ...conversation, title: e.title }
              : conversation
          )
        );
        void queryClient.invalidateQueries({ queryKey: conversationKey(e.conversationId) });
      }),
      client.onConversationLeft((ctx, e) => {
        if (ctx !== context) return;
        queryClient.setQueryData<ConversationListInfiniteData>(queryKey, old =>
          filterConversationPages(
            old,
            conversation => conversation.conversationId !== e.conversationId
          )
        );
      }),
      client.onConversationRead((ctx, e) => {
        if (ctx !== context) return;
        if (!shouldApplyConversationRead(currentUserId, e.memberId)) return;
        queryClient.setQueryData<ConversationListInfiniteData>(queryKey, old =>
          updateConversationPages(old, conversation =>
            conversation.conversationId === e.conversationId
              ? { ...conversation, lastReadAt: e.lastReadAt }
              : conversation
          )
        );
      }),
      client.onConversationActivity((ctx, e) => {
        if (ctx !== context) return;
        const data = queryClient.getQueryData<ConversationListInfiniteData>(queryKey);
        if (!isConversationOnFirstPage(data, e.conversationId)) {
          void queryClient.invalidateQueries({ queryKey });
          return;
        }
        queryClient.setQueryData<ConversationListInfiniteData>(queryKey, old =>
          moveConversationToFirstPage(old, e.conversationId, conversation => ({
            ...conversation,
            lastActivityAt: e.lastActivityAt,
          }))
        );
      }),
      client.onBotStatus((ctx, e) => {
        if (ctx !== context) return;
        if (e.sandboxId !== sandboxId) return;
        onBotStatus?.();
      }),
    ];

    const offReconnect = eventService.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey });
    });

    return () => {
      offReconnect();
      for (const off of offs) off();
      eventService.unsubscribe([context]);
    };
  }, [client, currentUserId, eventService, onBotStatus, queryClient, sandboxId]);
}

export function useMarkConversationRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => client.markConversationRead(conversationId),
    onMutate: conversationId => {
      // Optimistically set lastReadAt = now in all cached conversation lists
      const now = Date.now();
      const queryKey = conversationsKeyAll();
      const previous = queryClient.getQueriesData<ConversationListInfiniteData>({ queryKey });
      queryClient.setQueriesData<ConversationListInfiniteData>({ queryKey }, old =>
        updateConversationPages(old, c =>
          c.conversationId === conversationId ? { ...c, lastReadAt: now } : c
        )
      );
      return { previous };
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
    },
    onSuccess: (response, conversationId) => {
      queryClient.setQueriesData<ConversationListInfiniteData>(
        { queryKey: conversationsKeyAll() },
        old =>
          updateConversationPages(old, c =>
            c.conversationId === conversationId ? { ...c, lastReadAt: response.lastReadAt } : c
          )
      );
    },
  });
}
