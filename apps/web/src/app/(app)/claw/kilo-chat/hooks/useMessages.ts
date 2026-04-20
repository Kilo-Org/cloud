import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type {
  Message,
  ReactionSummary,
  CreateMessageRequest,
  EditMessageRequest,
  DeleteMessageRequest,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
} from '@kilocode/kilo-chat';
import { useCallback } from 'react';

const PAGE_SIZE = 50;

export function useMessages(client: KiloChatClient, conversationId: string | null) {
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
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string
) {
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
        deliveryFailed: false,
        reactions: [],
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

export function useEditMessage(client: KiloChatClient, conversationId: string | null) {
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

export function useDeleteMessage(client: KiloChatClient, conversationId: string | null) {
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

export function useAddReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.addReaction(messageId, conversationId ?? '', emoji),
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
            page.map(msg => {
              if (msg.id !== variables.messageId) return msg;
              const existing = msg.reactions.find(r => r.emoji === variables.emoji);
              if (existing) {
                if (existing.memberIds.includes(currentUserId)) return msg;
                return {
                  ...msg,
                  reactions: msg.reactions.map(r =>
                    r.emoji === variables.emoji
                      ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, currentUserId] }
                      : r
                  ),
                };
              }
              return {
                ...msg,
                reactions: [
                  ...msg.reactions,
                  { emoji: variables.emoji, count: 1, memberIds: [currentUserId] },
                ],
              };
            })
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

export function useRemoveReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.removeReaction(messageId, conversationId ?? '', emoji),
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
            page.map(msg => {
              if (msg.id !== variables.messageId) return msg;
              const updated = msg.reactions
                .map((r: ReactionSummary) => {
                  if (r.emoji !== variables.emoji) return r;
                  const memberIds = r.memberIds.filter(id => id !== currentUserId);
                  return { ...r, count: memberIds.length, memberIds };
                })
                .filter((r: ReactionSummary) => r.count > 0);
              return { ...msg, reactions: updated };
            })
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
 * Returns a callback that applies real-time events to the React Query message cache.
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
            deliveryFailed: false,
            reactions: [],
          };
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            // Skip if this messageId already exists
            for (const page of data.pages) {
              if (page.some(msg => msg.id === e.messageId)) return data;
            }
            // Replace pending optimistic message from same sender if present
            for (const page of data.pages) {
              const pendingIdx = page.findIndex(
                msg => msg.id.startsWith('pending-') && msg.senderId === e.senderId
              );
              if (pendingIdx >= 0) {
                return {
                  ...data,
                  pages: data.pages.map(p =>
                    p === page ? page.map((msg, i) => (i === pendingIdx ? newMessage : msg)) : p
                  ),
                };
              }
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
        case 'message.delivery_failed': {
          const e = event.data as MessageDeliveryFailedEvent;
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            return {
              ...data,
              pages: data.pages.map(page =>
                page.map(msg => (msg.id === e.messageId ? { ...msg, deliveryFailed: true } : msg))
              ),
            };
          });
          break;
        }
        case 'reaction.added': {
          const e = event.data as ReactionAddedEvent;
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            return {
              ...data,
              pages: data.pages.map(page =>
                page.map(msg => {
                  if (msg.id !== e.messageId) return msg;
                  const existing = msg.reactions.find(r => r.emoji === e.emoji);
                  if (existing) {
                    if (existing.memberIds.includes(e.memberId)) return msg;
                    return {
                      ...msg,
                      reactions: msg.reactions.map(r =>
                        r.emoji === e.emoji
                          ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, e.memberId] }
                          : r
                      ),
                    };
                  }
                  return {
                    ...msg,
                    reactions: [
                      ...msg.reactions,
                      { emoji: e.emoji, count: 1, memberIds: [e.memberId] },
                    ],
                  };
                })
              ),
            };
          });
          break;
        }
        case 'reaction.removed': {
          const e = event.data as ReactionRemovedEvent;
          queryClient.setQueryData(queryKey, (old: unknown) => {
            if (!old || typeof old !== 'object') return old;
            const data = old as { pages: Message[][]; pageParams: unknown[] };
            return {
              ...data,
              pages: data.pages.map(page =>
                page.map(msg => {
                  if (msg.id !== e.messageId) return msg;
                  const updated = msg.reactions
                    .map(r => {
                      if (r.emoji !== e.emoji) return r;
                      const memberIds = r.memberIds.filter(id => id !== e.memberId);
                      return { ...r, count: memberIds.length, memberIds };
                    })
                    .filter(r => r.count > 0);
                  return { ...msg, reactions: updated };
                })
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
