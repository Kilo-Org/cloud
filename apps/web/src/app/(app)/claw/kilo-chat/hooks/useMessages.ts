import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type {
  Message,
  ReactionSummary,
  CreateMessageRequest,
  EditMessageRequest,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  ActionsBlock,
} from '@kilocode/kilo-chat';
import { useCallback } from 'react';

const PAGE_SIZE = 50;

function applyReactionAdded(
  reactions: ReactionSummary[],
  emoji: string,
  memberId: string
): ReactionSummary[] {
  const existing = reactions.find(r => r.emoji === emoji);
  if (existing) {
    if (existing.memberIds.includes(memberId)) return reactions;
    return reactions.map(r =>
      r.emoji === emoji ? { ...r, count: r.count + 1, memberIds: [...r.memberIds, memberId] } : r
    );
  }
  return [...reactions, { emoji, count: 1, memberIds: [memberId] }];
}

function applyReactionRemoved(
  reactions: ReactionSummary[],
  emoji: string,
  memberId: string
): ReactionSummary[] {
  return reactions
    .map(r => {
      if (r.emoji !== emoji) return r;
      const memberIds = r.memberIds.filter(id => id !== memberId);
      return { ...r, count: memberIds.length, memberIds };
    })
    .filter(r => r.count > 0);
}

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
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        const firstPage = old.pages[0] ?? [];
        return { ...old, pages: [[optimisticMessage, ...firstPage], ...old.pages.slice(1)] };
      });
      return { previous, queryKey, clientId: variables.clientId };
    },
    onSuccess: (response, _variables, context) => {
      if (!context?.queryKey) return;
      const pendingId = `pending-${context.clientId}`;
      queryClient.setQueryData<InfiniteData<Message[]>>(context.queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
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
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
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
    mutationFn: ({ messageId, conversationId }: { messageId: string; conversationId: string }) =>
      client.deleteMessage(messageId, { conversationId }),
    onMutate: async variables => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
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
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg =>
              msg.id !== variables.messageId
                ? msg
                : {
                    ...msg,
                    reactions: applyReactionAdded(msg.reactions, variables.emoji, currentUserId),
                  }
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
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg =>
              msg.id !== variables.messageId
                ? msg
                : {
                    ...msg,
                    reactions: applyReactionRemoved(msg.reactions, variables.emoji, currentUserId),
                  }
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

export function useExecuteAction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      messageId,
      groupId,
      value,
    }: {
      messageId: string;
      groupId: string;
      value: string;
    }) => client.executeAction(conversationId ?? '', messageId, { groupId, value }),
    onMutate: async variables => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData(queryKey);
      // Optimistically mark the action as resolved
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg => {
              if (msg.id !== variables.messageId) return msg;
              return {
                ...msg,
                content: msg.content.map(block => {
                  if (block.type !== 'actions') return block;
                  const actionsBlock = block as ActionsBlock;
                  if (actionsBlock.groupId !== variables.groupId) return block;
                  return {
                    ...actionsBlock,
                    resolved: {
                      value: variables.value,
                      resolvedBy: currentUserId,
                      resolvedAt: Date.now(),
                    },
                  };
                }),
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
          queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
            if (!old) return old;
            // Skip if this messageId already exists
            for (const page of old.pages) {
              if (page.some(msg => msg.id === e.messageId)) return old;
            }
            // Replace the matching pending optimistic message if clientId correlates
            if (e.clientId) {
              const pendingId = `pending-${e.clientId}`;
              for (const page of old.pages) {
                if (page.some(msg => msg.id === pendingId)) {
                  return {
                    ...old,
                    pages: old.pages.map(p =>
                      p.map(msg => (msg.id === pendingId ? newMessage : msg))
                    ),
                  };
                }
              }
            }
            const firstPage = old.pages[0] ?? [];
            return { ...old, pages: [[newMessage, ...firstPage], ...old.pages.slice(1)] };
          });
          break;
        }
        case 'message.updated': {
          const e = event.data as MessageUpdatedEvent;
          queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map(page =>
                page.map(msg =>
                  msg.id === e.messageId
                    ? {
                        ...msg,
                        content: e.content,
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
          queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map(page =>
                page.map(msg => (msg.id === e.messageId ? { ...msg, deleted: true } : msg))
              ),
            };
          });
          break;
        }
        case 'message.delivery_failed': {
          const e = event.data as MessageDeliveryFailedEvent;
          queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map(page =>
                page.map(msg => (msg.id === e.messageId ? { ...msg, deliveryFailed: true } : msg))
              ),
            };
          });
          break;
        }
        case 'reaction.added': {
          const e = event.data as ReactionAddedEvent;
          queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map(page =>
                page.map(msg =>
                  msg.id !== e.messageId
                    ? msg
                    : { ...msg, reactions: applyReactionAdded(msg.reactions, e.emoji, e.memberId) }
                )
              ),
            };
          });
          break;
        }
        case 'reaction.removed': {
          const e = event.data as ReactionRemovedEvent;
          queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
            if (!old) return old;
            return {
              ...old,
              pages: old.pages.map(page =>
                page.map(msg =>
                  msg.id !== e.messageId
                    ? msg
                    : {
                        ...msg,
                        reactions: applyReactionRemoved(msg.reactions, e.emoji, e.memberId),
                      }
                )
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
