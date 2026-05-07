import { useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { KiloChatApiError, type KiloChatClient } from '@kilocode/kilo-chat';
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
  RemoveReactionResponse,
  MessageListResponse,
  CreateMessageResponse,
  ExecuteActionResponse,
} from '@kilocode/kilo-chat';
import { useEffect } from 'react';
import { kiloclawConversationContext } from '@kilocode/event-service';

import { messagesKey } from './query-keys';

export const PAGE_SIZE = 50;

export type MessagePage = MessageListResponse;
export type MessageInfiniteData<TPageParam = string | undefined> = InfiniteData<
  MessagePage,
  TPageParam
>;

export function createEmptyMessageInfiniteData(): MessageInfiniteData {
  return {
    pages: [{ messages: [], hasMore: false, nextCursor: null }],
    pageParams: [undefined],
  };
}

export function messagesFromListPage(page: MessageListResponse): MessagePage {
  return page;
}

export function getNextMessagesPageParam(lastPage: MessagePage): string | undefined {
  return lastPage.hasMore ? (lastPage.nextCursor ?? undefined) : undefined;
}

function withPageMessages(page: MessagePage, messages: Message[]): MessagePage {
  return {
    ...page,
    messages,
  };
}

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

export type ReactionOperationTracker = Map<string, string>;

export function createReactionOperationTracker(): ReactionOperationTracker {
  return new Map();
}

const reactionOperationTrackersByConversation = new Map<string, ReactionOperationTracker>();

export function getReactionOperationTracker(conversationId: string): ReactionOperationTracker {
  const existing = reactionOperationTrackersByConversation.get(conversationId);
  if (existing) return existing;
  const tracker = createReactionOperationTracker();
  reactionOperationTrackersByConversation.set(conversationId, tracker);
  return tracker;
}

type ReactionOperation = Pick<
  ReactionAddedEvent | ReactionRemovedEvent,
  'messageId' | 'emoji' | 'memberId' | 'operationId'
>;

function reactionOperationKey(
  conversationId: string,
  event: Pick<ReactionOperation, 'messageId' | 'emoji' | 'memberId'>
): string {
  return JSON.stringify([conversationId, event.messageId, event.emoji, event.memberId]);
}

function recordFreshReactionOperation(
  latestOperations: ReactionOperationTracker,
  conversationId: string,
  event: ReactionOperation
): boolean {
  const key = reactionOperationKey(conversationId, event);
  const latestOperationId = latestOperations.get(key);
  if (latestOperationId && event.operationId < latestOperationId) {
    return false;
  }
  latestOperations.set(key, event.operationId);
  return true;
}

export function applyReactionAddedEventToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  conversationId: string,
  latestOperations: ReactionOperationTracker,
  event: ReactionAddedEvent
): MessageInfiniteData<TPageParam> {
  if (!recordFreshReactionOperation(latestOperations, conversationId, event)) return old;
  return updateMessageInPages(old, event.messageId, msg => ({
    ...msg,
    reactions: applyReactionAdded(msg.reactions, event.emoji, event.memberId),
  }));
}

export function applyReactionRemovedEventToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  conversationId: string,
  latestOperations: ReactionOperationTracker,
  event: ReactionRemovedEvent
): MessageInfiniteData<TPageParam> {
  if (!recordFreshReactionOperation(latestOperations, conversationId, event)) return old;
  return updateMessageInPages(old, event.messageId, msg => ({
    ...msg,
    reactions: applyReactionRemoved(msg.reactions, event.emoji, event.memberId),
  }));
}

export function applyReactionAddedMutationToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  conversationId: string,
  latestOperations: ReactionOperationTracker,
  operation: ReactionOperation
): MessageInfiniteData<TPageParam> {
  if (!recordFreshReactionOperation(latestOperations, conversationId, operation)) return old;
  return updateMessageInPages(old, operation.messageId, msg => ({
    ...msg,
    reactions: applyReactionAdded(msg.reactions, operation.emoji, operation.memberId),
  }));
}

export function applyReactionRemovedMutationToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  conversationId: string,
  latestOperations: ReactionOperationTracker,
  operation: ReactionOperation
): MessageInfiniteData<TPageParam> {
  if (!recordFreshReactionOperation(latestOperations, conversationId, operation)) return old;
  return updateMessageInPages(old, operation.messageId, msg => ({
    ...msg,
    reactions: applyReactionRemoved(msg.reactions, operation.emoji, operation.memberId),
  }));
}

export function applyReactionRemovedResponseToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  conversationId: string,
  latestOperations: ReactionOperationTracker,
  operation: Pick<ReactionOperation, 'messageId' | 'emoji' | 'memberId'> & {
    response: RemoveReactionResponse;
  }
): MessageInfiniteData<TPageParam> {
  if (operation.response.id === null) return old;
  return applyReactionRemovedMutationToPages(old, conversationId, latestOperations, {
    messageId: operation.messageId,
    emoji: operation.emoji,
    memberId: operation.memberId,
    operationId: operation.response.id,
  });
}

export function latestMarkReadMessageId(messages: readonly Pick<Message, 'id'>[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && !message.id.startsWith('pending-')) {
      return message.id;
    }
  }
  return null;
}

type RestoreMessageGuard = (current: Message) => boolean;
type ActionsBlock = Extract<Message['content'][number], { type: 'actions' }>;
type ActionResolution = NonNullable<ActionsBlock['resolved']>;

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function messagesEqual(left: Message, right: Message): boolean {
  return jsonValuesEqual(left, right);
}

/**
 * Splice a snapshotted message back into the current cache state. Callers with
 * optimistic mutations can pass a guard so newer live events are not replaced
 * by stale snapshots.
 */
export function restoreMessageInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  snapshot: Message,
  shouldRestore?: RestoreMessageGuard
): boolean {
  let restored = false;
  queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
    if (!old) return old;
    for (let pageIndex = 0; pageIndex < old.pages.length; pageIndex++) {
      const page = old.pages[pageIndex];
      if (!page) continue;
      const messageIndex = page.messages.findIndex(msg => msg.id === snapshot.id);
      if (messageIndex === -1) continue;

      const current = page.messages[messageIndex];
      if (!current) return old;
      if (shouldRestore && !shouldRestore(current)) return old;

      const pages = old.pages.slice();
      const updatedMessages = page.messages.slice();
      updatedMessages[messageIndex] = snapshot;
      pages[pageIndex] = withPageMessages(page, updatedMessages);
      restored = true;
      return { ...old, pages };
    }
    return old;
  });
  return restored;
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
  queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
    if (!old) return old;
    return {
      ...old,
      pages: old.pages.map(page =>
        withPageMessages(
          page,
          page.messages.filter(msg => msg.id !== messageId)
        )
      ),
    };
  });
}

export function findMessageInCache(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  messageId: string
): Message | undefined {
  const data = queryClient.getQueryData<MessageInfiniteData>(queryKey);
  if (!data) return undefined;
  for (const page of data.pages) {
    const match = page.messages.find(msg => msg.id === messageId);
    if (match) return match;
  }
  return undefined;
}

export function updateMessageInPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  messageId: string,
  updater: (message: Message) => Message
): MessageInfiniteData<TPageParam> {
  for (let pageIndex = 0; pageIndex < old.pages.length; pageIndex++) {
    const page = old.pages[pageIndex];
    if (!page) continue;
    const messageIndex = page.messages.findIndex(msg => msg.id === messageId);
    if (messageIndex === -1) continue;

    const pages = old.pages.slice();
    const updatedMessages = page.messages.slice();
    const message = updatedMessages[messageIndex];
    if (!message) return old;
    const updatedMessage = updater(message);
    if (updatedMessage === message) return old;
    updatedMessages[messageIndex] = updatedMessage;
    pages[pageIndex] = withPageMessages(page, updatedMessages);
    return { ...old, pages };
  }
  return old;
}

function restoreOptimisticMessage(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[],
  snapshot: Message | undefined,
  optimisticMessage: Message | undefined
): boolean {
  if (!snapshot || !optimisticMessage) return false;
  return restoreMessageInCache(queryClient, queryKey, snapshot, current =>
    messagesEqual(current, optimisticMessage)
  );
}

function invalidateMessages(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: readonly unknown[]
): void {
  void queryClient.invalidateQueries({ queryKey });
}

export function rollbackEditMessageError(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  snapshot: Message | undefined,
  optimisticMessage: Message | undefined,
  err: unknown
): void {
  const restored = restoreOptimisticMessage(queryClient, queryKey, snapshot, optimisticMessage);
  if (!restored || (err instanceof KiloChatApiError && err.status === 409)) {
    invalidateMessages(queryClient, queryKey);
  }
}

function actionResolutionMatches(
  current: ActionResolution | undefined,
  expected: ActionResolution
): boolean {
  return (
    current?.value === expected.value &&
    current.resolvedBy === expected.resolvedBy &&
    current.resolvedAt === expected.resolvedAt
  );
}

function findActionResolution(message: Message, groupId: string): ActionResolution | undefined {
  for (const block of message.content) {
    if (block.type !== 'actions') continue;
    if (block.groupId !== groupId) continue;
    return block.resolved;
  }
  return undefined;
}

function applyActionResolution(
  message: Message,
  groupId: string,
  resolution: ActionResolution
): Message {
  return {
    ...message,
    content: message.content.map(block => {
      if (block.type !== 'actions') return block;
      if (block.groupId !== groupId) return block;
      return { ...block, resolved: resolution };
    }),
  };
}

function mergeCreatedContentIntoCachedRow(created: Message, cached: Message): Message['content'] {
  if (cached.clientUpdatedAt !== null) return cached.content;

  return created.content.map(block => {
    if (block.type !== 'actions') return block;
    if (block.resolved) return block;

    const cachedResolution = findActionResolution(cached, block.groupId);
    if (!cachedResolution) return block;

    return { ...block, resolved: cachedResolution };
  });
}

function errorCode(error: unknown): string | null {
  if (!(error instanceof KiloChatApiError)) return null;
  const body = error.body;
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  return typeof body.error === 'string' ? body.error : null;
}

function orderNewestLoadedPageByServerId(page: MessagePage): MessagePage {
  const serverMessages = page.messages.filter(message => !message.id.startsWith('pending-'));
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; spread keeps the filtered array immutable.
  const orderedServerMessages = [...serverMessages].sort((left, right) =>
    right.id.localeCompare(left.id)
  );
  let orderedServerMessageIndex = 0;

  return withPageMessages(
    page,
    page.messages.map(message => {
      if (message.id.startsWith('pending-')) return message;
      const orderedMessage = orderedServerMessages[orderedServerMessageIndex];
      orderedServerMessageIndex += 1;
      return orderedMessage ?? message;
    })
  );
}

export function replaceMessageAndOrderNewestPage<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  messageId: string,
  updater: (message: Message) => Message
): MessageInfiniteData<TPageParam> {
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
    const replacementPage =
      pageIndex === 0
        ? orderNewestLoadedPageByServerId(withPageMessages(page, updatedMessages))
        : withPageMessages(page, updatedMessages);
    pages[pageIndex] = replacementPage;
    return { ...old, pages };
  }
  return old;
}

export function useMessages(client: KiloChatClient, conversationId: string | null) {
  return useInfiniteQuery({
    queryKey: messagesKey(conversationId),
    queryFn: async ({ pageParam }) => {
      const page = await client.listMessagesPage(conversationId ?? '', {
        before: pageParam,
        limit: PAGE_SIZE,
      });
      return messagesFromListPage(page);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: getNextMessagesPageParam,
    enabled: !!conversationId,
    select: data => ({
      ...data,
      messages: data.pages.flatMap(page => page.messages).reverse(),
    }),
  });
}

export type SendMessageVariables = CreateMessageRequest & { clientId: string };

type MutationErrorOptions = {
  onError?: (error: unknown) => void;
};

type SendMessageMutationContext = {
  queryKey: QueryKey;
  pendingId: string;
  seededColdCache: boolean;
};

export function messageFromCreatedEvent(e: MessageCreatedEvent): Message {
  return {
    id: e.messageId,
    senderId: e.senderId,
    content: e.content,
    inReplyToMessageId: e.inReplyToMessageId,
    replyTo: e.replyTo,
    updatedAt: null,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
  };
}

function mergeCreatedMessageIntoCachedRow(created: Message, cached: Message): Message {
  return {
    ...created,
    content: mergeCreatedContentIntoCachedRow(created, cached),
    updatedAt: cached.updatedAt ?? created.updatedAt,
    clientUpdatedAt: cached.clientUpdatedAt ?? created.clientUpdatedAt,
    deleted: cached.deleted || created.deleted,
    deliveryFailed: cached.deliveryFailed || created.deliveryFailed,
    reactions: cached.reactions.length > 0 ? cached.reactions : created.reactions,
  };
}

export function applyMessageCreatedEventToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  e: MessageCreatedEvent
): MessageInfiniteData<TPageParam> {
  const newMessage = messageFromCreatedEvent(e);

  if (e.clientId) {
    const pendingId = `pending-${e.clientId}`;
    const replacedPending = replaceMessageAndOrderNewestPage(old, pendingId, () => newMessage);
    if (replacedPending !== old) return replacedPending;
  }

  const replacedExisting = replaceMessageAndOrderNewestPage(old, e.messageId, cached =>
    mergeCreatedMessageIntoCachedRow(newMessage, cached)
  );
  if (replacedExisting !== old) return replacedExisting;

  for (const page of old.pages) {
    if (page.messages.some(msg => msg.id === e.messageId)) return old;
  }

  const firstPage = old.pages[0];
  if (!firstPage) return old;
  const orderedFirstPage = orderNewestLoadedPageByServerId(
    withPageMessages(firstPage, [newMessage, ...firstPage.messages])
  );
  return {
    ...old,
    pages: [orderedFirstPage, ...old.pages.slice(1)],
  };
}

export function applyCreateMessageResponseToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  pendingId: string,
  response: CreateMessageResponse
): MessageInfiniteData<TPageParam> {
  const replacedPending = replaceMessageAndOrderNewestPage(old, pendingId, () => response.message);
  if (replacedPending !== old) return replacedPending;

  const replacedExisting = replaceMessageAndOrderNewestPage(
    old,
    response.messageId,
    () => response.message
  );
  if (replacedExisting !== old) return replacedExisting;

  const firstPage = old.pages[0];
  if (!firstPage) return old;
  const orderedFirstPage = orderNewestLoadedPageByServerId(
    withPageMessages(firstPage, [response.message, ...firstPage.messages])
  );
  return {
    ...old,
    pages: [orderedFirstPage, ...old.pages.slice(1)],
  };
}

export function applyMessageUpdatedEventToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  e: MessageUpdatedEvent
): MessageInfiniteData<TPageParam> {
  return updateMessageInPages(old, e.messageId, msg => {
    if (
      e.clientUpdatedAt !== null &&
      msg.clientUpdatedAt !== null &&
      e.clientUpdatedAt < msg.clientUpdatedAt
    ) {
      return msg;
    }

    return {
      ...msg,
      content: e.content,
      clientUpdatedAt: e.clientUpdatedAt ?? msg.clientUpdatedAt,
    };
  });
}

export function applyExecuteActionResponseToPages<TPageParam>(
  old: MessageInfiniteData<TPageParam>,
  response: ExecuteActionResponse
): MessageInfiniteData<TPageParam> {
  return updateMessageInPages(old, response.messageId, msg => ({
    ...msg,
    content: response.content,
  }));
}

export function applyOptimisticMessageToPages(
  old: MessageInfiniteData | undefined,
  optimisticMessage: Message
): MessageInfiniteData {
  const data = old && old.pages.length > 0 ? old : createEmptyMessageInfiniteData();
  const firstPage = data.pages[0];
  if (!firstPage) return data;
  return {
    ...data,
    pages: [
      withPageMessages(firstPage, [optimisticMessage, ...firstPage.messages]),
      ...data.pages.slice(1),
    ],
  };
}

export function applyOptimisticSendMessageToCache(
  queryClient: QueryClient,
  queryKey: QueryKey,
  pendingId: string,
  optimisticMessage: Message
): SendMessageMutationContext {
  const seededColdCache = queryClient.getQueryData<MessageInfiniteData>(queryKey) === undefined;
  queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
    return applyOptimisticMessageToPages(old, optimisticMessage);
  });
  return { queryKey, pendingId, seededColdCache };
}

function invalidateColdSeededMessages(
  queryClient: QueryClient,
  context: SendMessageMutationContext
): void {
  if (context.seededColdCache) {
    void queryClient.invalidateQueries({ queryKey: context.queryKey });
  }
}

export function settleSendMessageSuccess(
  queryClient: QueryClient,
  response: CreateMessageResponse,
  context: SendMessageMutationContext
): void {
  queryClient.setQueryData<MessageInfiniteData>(context.queryKey, old => {
    return applyCreateMessageResponseToPages(
      old ?? createEmptyMessageInfiniteData(),
      context.pendingId,
      response
    );
  });
  invalidateColdSeededMessages(queryClient, context);
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
      if (!conversationId || currentUserId === null) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const pendingId = `pending-${variables.clientId}`;
      const optimisticMessage: Message = {
        id: pendingId,
        senderId: currentUserId,
        content: variables.content,
        inReplyToMessageId: variables.inReplyToMessageId ?? null,
        replyTo: null,
        updatedAt: null,
        clientUpdatedAt: null,
        deleted: false,
        deliveryFailed: false,
        reactions: [],
      };
      return applyOptimisticSendMessageToCache(queryClient, queryKey, pendingId, optimisticMessage);
    },
    onSuccess: (response, _variables, context) => {
      if (!context) return;
      settleSendMessageSuccess(queryClient, response, context);
    },
    onError: (err, _variables, context) => {
      if (!context) return;
      removeMessageFromCache(queryClient, context.queryKey, context.pendingId);
      invalidateColdSeededMessages(queryClient, context);
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
      const optimisticMessage = snapshot
        ? { ...snapshot, content: variables.content, clientUpdatedAt: variables.timestamp }
        : undefined;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          content: variables.content,
          clientUpdatedAt: variables.timestamp,
        }));
      });
      return { queryKey, snapshot, optimisticMessage };
    },
    onError: (err, _variables, context) => {
      if (!context) return;
      rollbackEditMessageError(
        queryClient,
        context.queryKey,
        context.snapshot,
        context.optimisticMessage,
        err
      );
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
      const optimisticMessage = snapshot ? { ...snapshot, deleted: true } : undefined;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({ ...msg, deleted: true }));
      });
      return { queryKey, snapshot, optimisticMessage };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;
      const restored = restoreOptimisticMessage(
        queryClient,
        context.queryKey,
        context.snapshot,
        context.optimisticMessage
      );
      if (!restored) invalidateMessages(queryClient, context.queryKey);
    },
  });
}

export function useAddReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.addReaction(messageId, { conversationId: conversationId ?? '', emoji }),
    onMutate: async variables => {
      if (!conversationId || currentUserId === null) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      const optimisticMessage = snapshot
        ? {
            ...snapshot,
            reactions: applyReactionAdded(snapshot.reactions, variables.emoji, currentUserId),
          }
        : undefined;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          reactions: applyReactionAdded(msg.reactions, variables.emoji, currentUserId),
        }));
      });
      return { queryKey, snapshot, optimisticMessage };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;
      const restored = restoreOptimisticMessage(
        queryClient,
        context.queryKey,
        context.snapshot,
        context.optimisticMessage
      );
      if (!restored) invalidateMessages(queryClient, context.queryKey);
    },
    onSuccess: (result, variables) => {
      if (!conversationId || currentUserId === null) return;
      const queryKey = messagesKey(conversationId);
      const reactionOperations = getReactionOperationTracker(conversationId);
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return applyReactionAddedMutationToPages(old, conversationId, reactionOperations, {
          messageId: variables.messageId,
          emoji: variables.emoji,
          memberId: currentUserId,
          operationId: result.id,
        });
      });
    },
  });
}

export function useRemoveReaction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { messageId: string; emoji: string }) =>
      client.removeReaction(messageId, { conversationId: conversationId ?? '', emoji }),
    onMutate: async variables => {
      if (!conversationId || currentUserId === null) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      const optimisticMessage = snapshot
        ? {
            ...snapshot,
            reactions: applyReactionRemoved(snapshot.reactions, variables.emoji, currentUserId),
          }
        : undefined;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          reactions: applyReactionRemoved(msg.reactions, variables.emoji, currentUserId),
        }));
      });
      return { queryKey, snapshot, optimisticMessage };
    },
    onError: (_err, _variables, context) => {
      if (!context) return;
      const restored = restoreOptimisticMessage(
        queryClient,
        context.queryKey,
        context.snapshot,
        context.optimisticMessage
      );
      if (!restored) invalidateMessages(queryClient, context.queryKey);
    },
    onSuccess: (result, variables) => {
      if (!conversationId || currentUserId === null || result.id === null) return;
      const queryKey = messagesKey(conversationId);
      const reactionOperations = getReactionOperationTracker(conversationId);
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return applyReactionRemovedResponseToPages(old, conversationId, reactionOperations, {
          messageId: variables.messageId,
          emoji: variables.emoji,
          memberId: currentUserId,
          response: result,
        });
      });
    },
  });
}

export function useExecuteAction(
  client: KiloChatClient,
  conversationId: string | null,
  currentUserId: string | null
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
      if (!conversationId || currentUserId === null) return;
      const queryKey = messagesKey(conversationId);
      await queryClient.cancelQueries({ queryKey });
      const snapshot = findMessageInCache(queryClient, queryKey, variables.messageId);
      const optimisticResolution = {
        value: variables.value,
        resolvedBy: currentUserId,
        resolvedAt: Date.now(),
      };
      const optimisticMessage = snapshot
        ? applyActionResolution(snapshot, variables.groupId, optimisticResolution)
        : undefined;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, variables.messageId, msg => ({
          ...msg,
          content: msg.content.map(block => {
            if (block.type !== 'actions') return block;
            if (block.groupId !== variables.groupId) return block;
            return {
              ...block,
              resolved: optimisticResolution,
            };
          }),
        }));
      });
      return { queryKey, snapshot, optimisticMessage, optimisticResolution };
    },
    onError: (err, variables, context) => {
      if (!context?.snapshot || !context.optimisticMessage) return;
      const { optimisticMessage, snapshot } = context;
      const restored = restoreMessageInCache(queryClient, context.queryKey, snapshot, current =>
        messagesEqual(current, optimisticMessage)
      );
      if (restored) return;
      if (errorCode(err) !== 'already_resolved') {
        invalidateMessages(queryClient, context.queryKey);
        return;
      }
      const current = findMessageInCache(queryClient, context.queryKey, variables.messageId);
      const currentResolution = current
        ? findActionResolution(current, variables.groupId)
        : undefined;
      if (
        !currentResolution ||
        actionResolutionMatches(currentResolution, context.optimisticResolution)
      ) {
        invalidateMessages(queryClient, context.queryKey);
      }
    },
    onSuccess: (response, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData<MessageInfiniteData>(context.queryKey, old => {
        if (!old) return old;
        return applyExecuteActionResponseToPages(old, response);
      });
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
  onActionFailed?: () => void,
  onMessageDeliveryFailed?: () => void
): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!conversationId || !sandboxId) return;
    const queryKey = messagesKey(conversationId);
    const expectedContext = kiloclawConversationContext(sandboxId, conversationId);
    const reactionOperations = getReactionOperationTracker(conversationId);

    const onCreated = (ctx: string, e: MessageCreatedEvent) => {
      if (ctx !== expectedContext) return;
      if (!e.senderId.startsWith('bot:')) {
        onHumanMessageCreated?.(ctx, e.senderId);
      }
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        return applyMessageCreatedEventToPages(old ?? createEmptyMessageInfiniteData(), e);
      });
    };

    const onUpdated = (ctx: string, e: MessageUpdatedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return applyMessageUpdatedEventToPages(old, e);
      });
    };

    const onDeleted = (ctx: string, e: MessageDeletedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({ ...msg, deleted: true }));
      });
    };

    const onDeliveryFailed = (ctx: string, e: MessageDeliveryFailedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return updateMessageInPages(old, e.messageId, msg => ({ ...msg, deliveryFailed: true }));
      });
      onMessageDeliveryFailed?.();
    };

    const onActionDeliveryFailed = (ctx: string, e: ActionDeliveryFailedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
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
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return applyReactionAddedEventToPages(old, conversationId, reactionOperations, e);
      });
    };

    const onReactionRemoved = (ctx: string, e: ReactionRemovedEvent) => {
      if (ctx !== expectedContext) return;
      queryClient.setQueryData<MessageInfiniteData>(queryKey, old => {
        if (!old) return old;
        return applyReactionRemovedEventToPages(old, conversationId, reactionOperations, e);
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
  }, [
    client,
    sandboxId,
    conversationId,
    queryClient,
    onHumanMessageCreated,
    onActionFailed,
    onMessageDeliveryFailed,
  ]);
}
