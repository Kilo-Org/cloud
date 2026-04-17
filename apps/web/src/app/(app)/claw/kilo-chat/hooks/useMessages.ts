import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { KiloChatClient } from '@kilocode/kilo-chat';
import type {
  Message,
  CreateMessageRequest,
  EditMessageRequest,
  DeleteMessageRequest,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
} from '@kilocode/kilo-chat';
import { useCallback, useMemo } from 'react';
import { KILO_CHAT_URL } from '@/lib/constants';

const PAGE_SIZE = 50;

function useClient(getToken: () => Promise<string>) {
  return useMemo(() => new KiloChatClient({ baseUrl: KILO_CHAT_URL, getToken }), [getToken]);
}

export function useMessages(getToken: () => Promise<string>, conversationId: string | null) {
  const client = useClient(getToken);
  return useInfiniteQuery({
    queryKey: ['kilo-chat', 'messages', conversationId],
    queryFn: async ({ pageParam }) => {
      return client.listMessages(conversationId ?? '', { before: pageParam, limit: PAGE_SIZE });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      return lastPage[lastPage.length - 1]?.id;
    },
    enabled: !!conversationId,
    select: data => ({
      ...data,
      messages: data.pages.flatMap(p => p).reverse(),
    }),
  });
}

export type SendMessageVariables = CreateMessageRequest & { clientId: string };

export function useSendMessage(
  getToken: () => Promise<string>,
  conversationId: string | null,
  currentUserId: string
) {
  const client = useClient(getToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: SendMessageVariables) => client.sendMessage(req),
    onMutate: async (variables: SendMessageVariables) => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      const optimisticMessage: Message = {
        id: `pending-${variables.clientId}`,
        senderId: currentUserId,
        content: variables.content,
        inReplyToMessageId: variables.inReplyToMessageId ?? null,
        updatedAt: null,
        clientUpdatedAt: null,
        deleted: false,
      };
      queryClient.setQueryData(queryKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const data = old as { pages: Message[][]; pageParams: unknown[] };
        const firstPage = data.pages[0] ?? [];
        return { ...data, pages: [[optimisticMessage, ...firstPage], ...data.pages.slice(1)] };
      });
      return { previous, queryKey, clientId: variables.clientId };
    },
    onSuccess: (response, _variables, context) => {
      if (!context?.queryKey) return;
      const pendingId = `pending-${context.clientId}`;
      queryClient.setQueryData(context.queryKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const data = old as { pages: Message[][]; pageParams: unknown[] };
        return {
          ...data,
          pages: data.pages.map(page =>
            page.map(msg => (msg.id === pendingId ? { ...msg, id: response.messageId } : msg))
          ),
        };
      });
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
  });
}

export function useEditMessage(getToken: () => Promise<string>, conversationId: string | null) {
  const client = useClient(getToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, ...req }: EditMessageRequest & { messageId: string }) =>
      client.editMessage(messageId, req),
    onMutate: async variables => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const data = old as { pages: Message[][]; pageParams: unknown[] };
        return {
          ...data,
          pages: data.pages.map(page =>
            page.map(msg =>
              msg.id === variables.messageId
                ? { ...msg, content: variables.content, clientUpdatedAt: variables.timestamp }
                : msg
            )
          ),
        };
      });
      return { previous, queryKey };
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
  });
}

export function useDeleteMessage(getToken: () => Promise<string>, conversationId: string | null) {
  const client = useClient(getToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, ...req }: DeleteMessageRequest & { messageId: string }) =>
      client.deleteMessage(messageId, req),
    onMutate: async variables => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData(queryKey, (old: unknown) => {
        if (!old || typeof old !== 'object') return old;
        const data = old as { pages: Message[][]; pageParams: unknown[] };
        return {
          ...data,
          pages: data.pages.map(page =>
            page.map(msg => (msg.id === variables.messageId ? { ...msg, deleted: true } : msg))
          ),
        };
      });
      return { previous, queryKey };
    },
    onError: (_err, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(context.queryKey, context.previous);
      }
    },
  });
}

/**
 * Returns a callback that applies SSE events to the React Query message cache.
 */
export function useMessageCacheUpdater(conversationId: string | null) {
  const queryClient = useQueryClient();
  return useCallback(
    (event: { type: string; data: unknown }) => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      switch (event.type) {
        case 'message.created': {
          const e = event.data as MessageCreatedEvent;
          const newMessage: Message = {
            id: e.messageId,
            senderId: e.senderId,
            content: e.content,
            inReplyToMessageId: e.inReplyToMessageId,
            updatedAt: null,
            clientUpdatedAt: null,
            deleted: false,
          };
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            // Skip if this messageId already exists (optimistic insert already replaced)
            for (const page of data.pages) {
              if (page.some(msg => msg.id === e.messageId)) return data;
            }
            const firstPage = data.pages[0] ?? [];
            return { ...data, pages: [[newMessage, ...firstPage], ...data.pages.slice(1)] };
          });
          break;
        }
        case 'message.updated': {
          const e = event.data as MessageUpdatedEvent;
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            return {
              ...data,
              pages: data.pages.map(page =>
                page.map(msg =>
                  msg.id === e.messageId
                    ? {
                        ...msg,
                        content: e.content,
                        updatedAt: Date.now(),
                        clientUpdatedAt: e.clientUpdatedAt,
                      }
                    : msg
                )
              ),
            };
          });
          break;
        }
        case 'message.deleted': {
          const e = event.data as MessageDeletedEvent;
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            return {
              ...data,
              pages: data.pages.map(page =>
                page.map(msg => (msg.id === e.messageId ? { ...msg, deleted: true } : msg))
              ),
            };
          });
          break;
        }
      }
    },
    [conversationId, queryClient]
  );
}
