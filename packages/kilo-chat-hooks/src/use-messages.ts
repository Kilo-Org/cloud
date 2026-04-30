import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type {
  Message,
  ReactionSummary,
  CreateMessageRequest,
  EditMessageRequest,
  ExecApprovalDecision,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  MessageDeletedEvent,
  MessageDeliveryFailedEvent,
  ActionDeliveryFailedEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  MessageListResponse,
} from '@kilocode/kilo-chat';
import { useEffect } from 'react';
import { kiloclawConversationContext } from '@kilocode/event-service';

import { messagesKey } from './query-keys';

export const PAGE_SIZE = 50;
export type MessagesInfiniteData = InfiniteData<MessageListResponse, string | undefined>;

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
  queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
    if (!old) return old;
    return updateMessageInPages(old, snapshot.id, () => snapshot);
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
  queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map(page => ({
        ...page,
        messages: page.messages.filter(msg => msg.id !== messageId),
      })),
    };
  });
}

export function findMessageInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  messageId: string
): Message | undefined {
  const data = queryClient.getQueryData<MessagesInfiniteData>(queryKey);
  if (!data) return undefined;
  for (const page of data.pages) {
    const match = page.messages.find(msg => msg.id === messageId);
    if (match) return match;
  }
  return undefined;
}

export function updateMessageInPages<TPageParam>(
  old: InfiniteData<MessageListResponse, TPageParam>,
  messageId: string,
  updater: (message: Message) => Message
): InfiniteData<MessageListResponse, TPageParam> {
  for (let pageIndex = 0; pageIndex < old.pages.length; pageIndex++) {
    const page = old.pages[pageIndex];
    if (!page) continue;
    const messageIndex = page.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) continue;

    const pages = old.pages.slice();
    const updatedMessages = page.messages.slice();
    const message = updatedMessages[messageIndex];
    if (!message) return old;
    updatedMessages[messageIndex] = updater(message);
    pages[pageIndex] = { ...page, messages: updatedMessages };
    return { ...old, pages };
  }
  return old;
}

export function useMessages(client: KiloChatClient, conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: messagesKey(conversationId),
    queryFn: async ({ pageParam }) => {
      return client.listMessages(conversationId ?? '', { before: pageParam, limit: PAGE_SIZE });
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.nextCursor ?? undefined,
    enabled: !!conversationId,
    select: data => ({
      ...data,
      messages: data.pages.flatMap(p => p.messages).reverse(),
    }),
  });
}

export type SendMessageVariables = CreateMessageRequest & { clientId: string };

type MutationErrorOptions = {
  onError?: (error: unknown) => void;
};

export function hasLoadedCurrentUserId(currentUserId: string | null): currentUserId is string {
  return currentUserId !== null && currentUserId !== '';
}

export function messageFromCreatedEvent(e: MessageCreatedEvent): Message {
  return e.message;
}

export function applyMessageCreatedEventToPages<TPageParam>(
  old: InfiniteData<MessageListResponse, TPageParam>,
  e: MessageCreatedEvent
): InfiniteData<MessageListResponse, TPageParam> {
  const newMessage = messageFromCreatedEvent(e);

  if (e.clientId) {
    const pendingId = `pending-${e.clientId}`;
    const replacedPending = updateMessageInPages(old, pendingId, () => newMessage);
    if (replacedPending !== old) return replacedPending;
  }

  for (const page of old.pages) {
    if (page.messages.some(msg => msg.id === e.messageId)) return old;
  }

  const firstPage = old.pages[0] ?? { messages: [], hasMore: false, nextCursor: null };
  return {
    ...old,
    pages: [{ ...firstPage, messages: [newMessage, ...firstPage.messages] }, ...old.pages.slice(1)],
  };
}

export function createOptimisticMessage(
  variables: SendMessageVariables,
  currentUserId: string | null
): Message | null {
  if (!hasLoadedCurrentUserId(currentUserId)) return null;

  return {
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
}

export function useSendMessage(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null,
  options?: MutationErrorOptions
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: SendMessageVariables) => client.sendMessage(req),
    onMutate: async (variables: SendMessageVariables) => {
      const optimisticMessage = createOptimisticMessage(variables, currentUserId);
      if (!conversationId || !optimisticMessage) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const pendingId = `pending-${variables.clientId}`;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        const firstPage = old.pages[0] ?? { messages: [], hasMore: false, nextCursor: null };
        return {
          ...old,
          pages: [
            { ...firstPage, messages: [optimisticMessage, ...firstPage.messages] },
            ...old.pages.slice(1),
          ],
        };
      });
      return { queryKey, pendingId };
    },
    onSuccess: (response, _variables, context) => {
      if (!context) return;
      const { queryKey, pendingId } = context;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, pendingId, () => response.message);
      });
    },
    onError: (err, _variables, context) => {
      if (!context) return;
      removeMessageFromCache(queryClient, context.queryKey, context.pendingId);
      options?.onError?.(err);
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
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          content: variables.content,
          clientUpdatedAt: variables.timestamp,
        }));
      });
      return { queryKey, snapshot };
    },
    onError: (_err, _variables, context) => {
      if (!context?.snapshot) return;
      restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
    },
    onSuccess: (response, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData<MessagesInfiniteData>(context.queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, response.message.id, () => response.message);
      });
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
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({ ...msg, deleted: true }));
      });
      return { queryKey, snapshot };
    },
    onError: (_err, _variables, context) => {
      if (!context?.snapshot) return;
      restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
    },
    onSuccess: (response, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData<MessagesInfiniteData>(context.queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, response.message.id, () => response.message);
      });
    },
  });
}

export function useAddReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null,
  options?: MutationErrorOptions
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.addReaction(messageId, { conversationId: conversationId ?? '', emoji }),
    onMutate: async variables => {
      if (!conversationId || !hasLoadedCurrentUserId(currentUserId)) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          reactions: applyReactionAdded(msg.reactions, variables.emoji, currentUserId),
        }));
      });
      return { queryKey, snapshot };
    },
    onError: (err, _variables, context) => {
      if (context?.snapshot) {
        restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
      }
      options?.onError?.(err);
    },
    onSuccess: (response, variables, context) => {
      if (!context) return;
      queryClient.setQueryData<MessagesInfiniteData>(context.queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          reactions: response.reactions,
        }));
      });
    },
  });
}

export function useRemoveReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null,
  options?: MutationErrorOptions
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.removeReaction(messageId, { conversationId: conversationId ?? '', emoji }),
    onMutate: async variables => {
      if (!conversationId || !hasLoadedCurrentUserId(currentUserId)) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          reactions: applyReactionRemoved(msg.reactions, variables.emoji, currentUserId),
        }));
      });
      return { queryKey, snapshot };
    },
    onError: (err, _variables, context) => {
      if (context?.snapshot) {
        restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
      }
      options?.onError?.(err);
    },
    onSuccess: (response, variables, context) => {
      if (!context) return;
      queryClient.setQueryData<MessagesInfiniteData>(context.queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          reactions: response.reactions,
        }));
      });
    },
  });
}

export function useExecuteAction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null,
  options?: MutationErrorOptions
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
      if (!conversationId || !hasLoadedCurrentUserId(currentUserId)) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      // Optimistically mark the action as resolved
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
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
        }));
      });
      return { queryKey, snapshot };
    },
    onError: (err, _variables, context) => {
      if (context?.snapshot) {
        restoreMessageInCache(queryClient, context.queryKey, context.snapshot);
      }
      options?.onError?.(err);
    },
  });
}

/**
 * Subscribes to real-time kilo-chat events on the shared client and applies
 * them to the React Query message cache for the active conversation.
 *
 * Each subscription receives the fully validated typed payload from the
 * client (Zod-checked inside `KiloChatClient.on`), so no casts are needed.
 *
 * Event Service delivers every subscribed context to every handler, so we
 * also validate `ctx` against the expected conversation context before
 * mutating the cache. This protects against stale subscriptions, context
 * leaks, or server-side routing drift.
 */
export function useMessageCacheUpdater(
  client: KiloChatClient,
  sandboxId: string | null,
  conversationId: string | null,
  // Called with the event context and sender id when a human sender's
  // message lands. Bots stream tokens through message.created events and
  // end their own typing state via explicit typing.stopped, so we must not
  // clear on bot messages or the indicator disappears mid-stream.
  onHumanMessageCreated?: (ctx: string, senderId: string) => void,
  // Fires when the server reports an action.delivery_failed for a message in
  // this conversation, after the optimistic resolved-state has been rolled
  // back. The shared package is platform-agnostic, so the user-visible
  // message lives at the call site (web: sonner toast; mobile: native toast).
  onActionFailed?: () => void
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!conversationId || !sandboxId) return;
    const queryKey = messagesKey(conversationId);
    const expectedContext = kiloclawConversationContext(sandboxId, conversationId);

    const onCreated = (ctx: string, e: MessageCreatedEvent) => {
      if (ctx !== expectedContext) return;
      if (!e.senderId.startsWith('bot:')) {
        onHumanMessageCreated?.(ctx, e.senderId);
      }
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return applyMessageCreatedEventToPages(old, e);
      });
    };

    const onUpdated = (ctx: string, e: MessageUpdatedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({
          ...msg,
          content: e.content,
          clientUpdatedAt: e.clientUpdatedAt,
        }));
      });
    };

    const onDeleted = (ctx: string, e: MessageDeletedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({ ...msg, deleted: true }));
      });
    };

    const onDeliveryFailed = (ctx: string, e: MessageDeliveryFailedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({ ...msg, deliveryFailed: true }));
      });
    };

    const onActionDeliveryFailed = (ctx: string, e: ActionDeliveryFailedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({
          ...msg,
          content: msg.content.map(block => {
            if (block.type !== 'actions') return block;
            if (block.groupId !== e.groupId) return block;
            return { ...block, resolved: undefined };
          }),
        }));
      });
      onActionFailed?.();
    };

    const onReactionAdded = (ctx: string, e: ReactionAddedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({
          ...msg,
          reactions: applyReactionAdded(msg.reactions, e.emoji, e.memberId),
        }));
      });
    };

    const onReactionRemoved = (ctx: string, e: ReactionRemovedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessagesInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({
          ...msg,
          reactions: applyReactionRemoved(msg.reactions, e.emoji, e.memberId),
        }));
      });
    };

    const offs = [
      client.onMessageCreated(onCreated),
      client.onMessageUpdated(onUpdated),
      client.onMessageDeleted(onDeleted),
      client.onMessageDeliveryFailed(onDeliveryFailed),
      client.onActionDeliveryFailed(onActionDeliveryFailed),
      client.onReactionAdded(onReactionAdded),
      client.onReactionRemoved(onReactionRemoved),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, sandboxId, conversationId, queryClient, onHumanMessageCreated, onActionFailed]);
}
