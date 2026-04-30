import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type {
  Message,
  ReactionSummary,
  CreateMessageRequest,
  EditMessageRequest,
  ExecApprovalDecision,
} from '@kilocode/kilo-chat';

export const PAGE_SIZE = 50;

export function applyReactionAdded(
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

export function applyReactionRemoved(
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

/**
 * Splice a snapshotted message back into the current cache state. If the
 * message no longer exists in any page (e.g. a concurrent delete event), the
 * cache is left unchanged so we do not resurrect it.
 */
export function restoreMessageInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  snapshot: Message
): void {
  queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
    if (!old) return old;
    let replaced = false;
    const pages = old.pages.map(page =>
      page.map(msg => {
        if (msg.id !== snapshot.id) return msg;
        replaced = true;
        return snapshot;
      })
    );
    if (!replaced) return old;
    return { ...old, pages };
  });
}

/**
 * Remove a message by id from the current cache state. Used to roll back the
 * optimistic insert performed by `useSendMessage` without touching any other
 * concurrently-optimistic messages.
 */
export function removeMessageFromCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  messageId: string
): void {
  queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map(page => page.filter(msg => msg.id !== messageId)),
    };
  });
}

export function findMessageInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  messageId: string
): Message | undefined {
  const data = queryClient.getQueryData<InfiniteData<Message[]>>(queryKey);
  if (!data) return undefined;
  for (const page of data.pages) {
    const match = page.find(msg => msg.id === messageId);
    if (match) return match;
  }
  return undefined;
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
      const pendingId = `pending-${variables.clientId}`;
      const optimisticMessage: Message = {
        id: pendingId,
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
      return { queryKey, pendingId };
    },
    onSuccess: (response, _variables, context) => {
      if (!context) return;
      const { queryKey, pendingId } = context;
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
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
      if (!context) return;
      removeMessageFromCache(queryClient, context.queryKey, context.pendingId);
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
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
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
      return { queryKey, snapshot };
    },
    onError: (_err, _variables, context) => {
      if (!context?.snapshot) return;
      restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
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
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      queryClient.setQueryData<InfiniteData<Message[]>>(queryKey, old => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map(page =>
            page.map(msg => (msg.id === variables.messageId ? { ...msg, deleted: true } : msg))
          ),
        };
      });
      return { queryKey, snapshot };
    },
    onError: (_err, _variables, context) => {
      if (!context?.snapshot) return;
      restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
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
      client.addReaction(messageId, { conversationId: conversationId ?? '', emoji }),
    onMutate: async variables => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
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
      return { queryKey, snapshot };
    },
    onError: (_err, _variables, context) => {
      if (!context?.snapshot) return;
      restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
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
      client.removeReaction(messageId, { conversationId: conversationId ?? '', emoji }),
    onMutate: async variables => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
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
      return { queryKey, snapshot };
    },
    onError: (_err, _variables, context) => {
      if (!context?.snapshot) return;
      restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
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
      value: ExecApprovalDecision;
    }) => client.executeAction(conversationId ?? '', messageId, { groupId, value }),
    onMutate: async variables => {
      if (!conversationId) return;
      const queryKey = ['kilo-chat', 'messages', conversationId];
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
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
                  if (block.groupId !== variables.groupId) return block;
                  return {
                    ...block,
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
      return { queryKey, snapshot };
    },
    onError: (_err, _variables, context) => {
      if (!context?.snapshot) return;
      restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
    },
  });
}
