import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type {
  MessageListResponse,
  Message,
  MessageRow,
  ContentBlock,
  CreateMessageRequest,
  CreateMessageResponse,
  EditMessageRequest,
  EditMessageResponse,
  DeleteMessageRequest,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
} from '../types';
import { useKiloChatClient } from './useKiloChatClient';
import { useCallback } from 'react';

const PAGE_SIZE = 50;

function parseMessageRow(row: MessageRow): Message {
  return {
    ...row,
    content: JSON.parse(row.content) as ContentBlock[],
  };
}

export function useMessages(getToken: () => Promise<string>, conversationId: string | null) {
  const client = useKiloChatClient(getToken);

  return useInfiniteQuery({
    queryKey: ['kilo-chat', 'messages', conversationId],
    queryFn: async ({ pageParam }) => {
      const res = await client.fetch<MessageListResponse>(
        `/v1/conversations/${conversationId}/messages`,
        {
          query: {
            ...(pageParam ? { before: pageParam } : {}),
            limit: String(PAGE_SIZE),
          },
        }
      );
      return res.messages.map(parseMessageRow);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => {
      if (lastPage.length < PAGE_SIZE) return undefined;
      return lastPage[lastPage.length - 1]?.id;
    },
    enabled: !!conversationId,
    select: data => ({
      ...data,
      // Flatten pages and reverse so oldest first
      messages: data.pages.flatMap(p => p).reverse(),
    }),
  });
}

export function useSendMessage(getToken: () => Promise<string>) {
  const client = useKiloChatClient(getToken);

  return useMutation({
    mutationFn: (req: CreateMessageRequest) =>
      client.fetch<CreateMessageResponse>('/v1/messages', {
        method: 'POST',
        body: req,
      }),
    // Don't invalidate — SSE will push the new message into cache
  });
}

export function useEditMessage(getToken: () => Promise<string>) {
  const client = useKiloChatClient(getToken);

  return useMutation({
    mutationFn: ({ messageId, ...req }: EditMessageRequest & { messageId: string }) =>
      client.fetch<EditMessageResponse>(`/v1/messages/${messageId}`, {
        method: 'PATCH',
        body: req,
      }),
  });
}

export function useDeleteMessage(getToken: () => Promise<string>) {
  const client = useKiloChatClient(getToken);

  return useMutation({
    mutationFn: ({ messageId, ...req }: DeleteMessageRequest & { messageId: string }) =>
      client.fetch<void>(`/v1/messages/${messageId}`, {
        method: 'DELETE',
        body: req,
      }),
  });
}

/**
 * Returns a callback that applies SSE events to the React Query message cache.
 */
export function useMessageCacheUpdater(conversationId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = ['kilo-chat', 'messages', conversationId];

  return useCallback(
    (event: { type: string; data: unknown }) => {
      if (!conversationId) return;

      switch (event.type) {
        case 'message.created': {
          const e = event.data as MessageCreatedEvent;
          const newMessage: Message = {
            id: e.messageId,
            senderId: e.senderId,
            content: e.content,
            inReplyToMessageId: e.inReplyToMessageId,
            version: e.version,
            updatedAt: null,
            deleted: false,
          };
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            const firstPage = data.pages[0] ?? [];
            return {
              ...data,
              pages: [[newMessage, ...firstPage], ...data.pages.slice(1)],
            };
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
                  msg.id === e.messageId ? { ...msg, content: e.content, version: e.version } : msg
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
    [conversationId, queryClient, queryKey]
  );
}
