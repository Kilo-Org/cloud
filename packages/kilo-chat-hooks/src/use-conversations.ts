import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import { ulidToTimestamp, type KiloChatClient } from '@kilocode/kilo-chat';
import type {
  CreateConversationRequest,
  CreateConversationResponse,
  ConversationListItem,
  ConversationListResponse,
  MarkConversationReadRequest,
  MarkConversationReadResponse,
} from '@kilocode/kilo-chat';

import { conversationKey, conversationsKey, conversationsKeyAll, messagesKey } from './query-keys';

const CONVERSATIONS_PAGE_SIZE = 50;

type MutationErrorOptions = {
  onError?: (error: unknown) => void;
};

function conversationListSandboxIdFromQueryKey(queryKey: QueryKey): string | null | undefined {
  const sandboxId = queryKey[2];
  if (typeof sandboxId === 'string' || sandboxId === null) {
    return sandboxId;
  }
  return undefined;
}

function conversationListInvalidationKey(sandboxId: string | null): QueryKey {
  return sandboxId === null ? conversationsKeyAll() : conversationsKey(sandboxId);
}

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
      settleCreateConversation(queryClient, variables, response);
    },
    onError: options?.onError,
  });
}

type RenameConversationMutationVariables = {
  conversationId: string;
  title: string;
  sandboxId: string | null;
};

export function useRenameConversation(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: RenameConversationMutationVariables) =>
      client.renameConversation(variables.conversationId, { title: variables.title }),
    onSuccess: (_data, variables) => {
      settleRenameConversation(queryClient, variables);
    },
  });
}

type LeaveConversationMutationVariables = {
  conversationId: string;
  sandboxId: string | null;
};

export function useLeaveConversation(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: LeaveConversationMutationVariables) =>
      client.leaveConversation(variables.conversationId),
    onSuccess: (_data, variables) => {
      settleLeaveConversation(queryClient, variables);
    },
  });
}

export type ConversationListInfiniteData = InfiniteData<ConversationListResponse, string | null>;

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

type ConversationActivity = {
  conversationId: string;
  lastActivityAt: number;
};

type ApplyConversationListPatchResult = {
  data: ConversationListInfiniteData | undefined;
  applied: boolean;
};

type ConversationRead = {
  conversationId: string;
  lastReadAt: number;
};

function conversationActivitySortValue(conversation: ConversationListItem): number {
  return conversation.lastActivityAt ?? conversation.joinedAt;
}

function compareConversationsByActivity(a: ConversationListItem, b: ConversationListItem): number {
  const timestampDelta = conversationActivitySortValue(b) - conversationActivitySortValue(a);
  if (timestampDelta !== 0) return timestampDelta;
  if (a.conversationId === b.conversationId) return 0;
  return a.conversationId < b.conversationId ? 1 : -1;
}

export function applyConversationActivityToPages(
  data: ConversationListInfiniteData | undefined,
  activity: ConversationActivity
): ApplyConversationListPatchResult {
  if (!data) {
    return { data, applied: false };
  }

  const current = data.pages
    .flatMap(page => page.conversations)
    .find(c => c.conversationId === activity.conversationId);
  if (!current) {
    return { data, applied: false };
  }

  if (current && conversationActivitySortValue(current) > activity.lastActivityAt) {
    return { data, applied: true };
  }

  const sortedConversations = data.pages
    .flatMap(page => page.conversations)
    .map(c =>
      c.conversationId === activity.conversationId
        ? { ...c, lastActivityAt: activity.lastActivityAt }
        : c
    )
    .sort(compareConversationsByActivity);

  let nextConversationOffset = 0;

  return {
    data: {
      ...data,
      pages: data.pages.map(page => {
        const conversations = sortedConversations.slice(
          nextConversationOffset,
          nextConversationOffset + page.conversations.length
        );
        nextConversationOffset += page.conversations.length;
        return {
          ...page,
          conversations,
        };
      }),
    },
    applied: true,
  };
}

export function applyConversationCreatedToPages(
  data: ConversationListInfiniteData | undefined,
  created: ConversationListItem
): ApplyConversationListPatchResult {
  const firstPage = data?.pages[0];
  if (!data || !firstPage) {
    return { data, applied: false };
  }

  const loadedConversations = data.pages.flatMap(page => page.conversations);
  if (loadedConversations.some(c => c.conversationId === created.conversationId)) {
    return { data, applied: true };
  }

  const sortedConversations = [created, ...loadedConversations].sort(
    compareConversationsByActivity
  );
  const createdIndex = sortedConversations.findIndex(
    conversation => conversation.conversationId === created.conversationId
  );
  if (firstPage.hasMore && createdIndex >= firstPage.conversations.length) {
    return { data, applied: false };
  }

  const lastPageIndex = data.pages.length - 1;
  const lastPage = data.pages[lastPageIndex];
  const loadedWindowSize = loadedConversations.length + (lastPage?.hasMore ? 0 : 1);
  const nextLoadedWindow = sortedConversations.slice(0, loadedWindowSize);
  let nextConversationOffset = 0;

  return {
    data: {
      ...data,
      pages: data.pages.map((page, index) => {
        const pageSize =
          index === lastPageIndex && !page.hasMore
            ? page.conversations.length + 1
            : page.conversations.length;
        const conversations = nextLoadedWindow.slice(
          nextConversationOffset,
          nextConversationOffset + pageSize
        );
        nextConversationOffset += pageSize;
        return { ...page, conversations };
      }),
    },
    applied: true,
  };
}

export function settleCreateConversation(
  queryClient: QueryClient,
  variables: CreateConversationRequest,
  response: CreateConversationResponse
): void {
  let targetInvalidationRequired = false;
  let catchAllInvalidationRequired = false;
  let matchedTargetEntryCount = 0;
  const previousEntries = queryClient.getQueriesData<ConversationListInfiniteData>({
    queryKey: conversationsKeyAll(),
  });

  for (const [entryQueryKey, data] of previousEntries) {
    const sandboxId = conversationListSandboxIdFromQueryKey(entryQueryKey);
    if (sandboxId !== variables.sandboxId && sandboxId !== null) {
      continue;
    }
    if (sandboxId === variables.sandboxId) {
      matchedTargetEntryCount += 1;
    }

    const result = applyConversationCreatedToPages(data, response.conversation);
    if (!result.applied) {
      if (sandboxId === null) {
        catchAllInvalidationRequired = true;
      } else {
        targetInvalidationRequired = true;
      }
    } else {
      queryClient.setQueryData<ConversationListInfiniteData>(entryQueryKey, result.data);
    }
  }

  if (targetInvalidationRequired || matchedTargetEntryCount === 0) {
    void queryClient.invalidateQueries({ queryKey: conversationsKey(variables.sandboxId) });
  }
  if (catchAllInvalidationRequired) {
    void queryClient.invalidateQueries({ queryKey: conversationsKey(null) });
  }
}

export function settleRenameConversation(
  queryClient: QueryClient,
  variables: RenameConversationMutationVariables
): void {
  void queryClient.invalidateQueries({
    queryKey: conversationListInvalidationKey(variables.sandboxId),
  });
}

export function settleLeaveConversation(
  queryClient: QueryClient,
  variables: LeaveConversationMutationVariables
): void {
  queryClient.removeQueries({ queryKey: conversationKey(variables.conversationId) });
  queryClient.removeQueries({ queryKey: messagesKey(variables.conversationId) });
  void queryClient.invalidateQueries({
    queryKey: conversationListInvalidationKey(variables.sandboxId),
  });
}

export function applyConversationReadToPages(
  data: ConversationListInfiniteData | undefined,
  read: ConversationRead
): ApplyConversationListPatchResult {
  let foundConversation = false;
  let foundNewerOrEqualState = false;

  const next = updateConversationPages(data, conversation => {
    if (conversation.conversationId !== read.conversationId) {
      return conversation;
    }

    foundConversation = true;
    if (conversation.lastReadAt !== null && conversation.lastReadAt >= read.lastReadAt) {
      foundNewerOrEqualState = true;
      return conversation;
    }

    return { ...conversation, lastReadAt: read.lastReadAt };
  });

  return {
    data: foundNewerOrEqualState ? data : next,
    applied: foundConversation,
  };
}

type MarkConversationReadRollback = {
  conversationId: string;
  previousLastReadAt: number | null;
  optimisticReadAt: number;
};

type ApplyMarkConversationReadRollbackResult = {
  data: ConversationListInfiniteData | undefined;
  invalidationRequired: boolean;
};

export function applyMarkConversationReadRollbackToPages(
  data: ConversationListInfiniteData | undefined,
  rollback: MarkConversationReadRollback
): ApplyMarkConversationReadRollbackResult {
  let foundConversation = false;
  let foundNewerState = false;

  const next = updateConversationPages(data, conversation => {
    if (conversation.conversationId !== rollback.conversationId) {
      return conversation;
    }

    foundConversation = true;
    if (conversation.lastReadAt !== rollback.optimisticReadAt) {
      foundNewerState = true;
      return conversation;
    }

    return { ...conversation, lastReadAt: rollback.previousLastReadAt };
  });

  return {
    data: next,
    invalidationRequired: foundConversation && foundNewerState,
  };
}

type MarkConversationReadQueryRollback = MarkConversationReadRollback & {
  queryKey: QueryKey;
};

type MarkConversationReadMutationContext = {
  rollbacks: MarkConversationReadQueryRollback[];
  invalidationQueryKey: QueryKey;
};

type MarkConversationReadMutationVariables = MarkConversationReadRequest & {
  conversationId: string;
  sandboxId: string | null;
};

function markConversationReadQueryKey(sandboxId: string | null): QueryKey {
  return conversationListInvalidationKey(sandboxId);
}

export function applyOptimisticMarkConversationRead(
  queryClient: QueryClient,
  { sandboxId, conversationId, lastSeenMessageId }: MarkConversationReadMutationVariables
): MarkConversationReadMutationContext {
  const optimisticReadAt = ulidToTimestamp(lastSeenMessageId);
  const queryKey = markConversationReadQueryKey(sandboxId);
  const rollbacks: MarkConversationReadQueryRollback[] = [];
  const previousEntries = queryClient.getQueriesData<ConversationListInfiniteData>({
    queryKey,
  });

  for (const [entryQueryKey, data] of previousEntries) {
    const previousConversation = data?.pages
      .flatMap(page => page.conversations)
      .find(conversation => conversation.conversationId === conversationId);

    if (!previousConversation) {
      continue;
    }

    rollbacks.push({
      queryKey: entryQueryKey,
      conversationId,
      previousLastReadAt: previousConversation.lastReadAt,
      optimisticReadAt,
    });

    queryClient.setQueryData<ConversationListInfiniteData>(entryQueryKey, old =>
      updateConversationPages(old, conversation =>
        conversation.conversationId === conversationId &&
        (conversation.lastReadAt === null || conversation.lastReadAt < optimisticReadAt)
          ? { ...conversation, lastReadAt: optimisticReadAt }
          : conversation
      )
    );
  }

  return { rollbacks, invalidationQueryKey: queryKey };
}

export function rollbackOptimisticMarkConversationRead(
  queryClient: QueryClient,
  context: MarkConversationReadMutationContext | undefined
): void {
  let shouldInvalidate = false;

  for (const rollback of context?.rollbacks ?? []) {
    const current = queryClient.getQueryData<ConversationListInfiniteData>(rollback.queryKey);
    const result = applyMarkConversationReadRollbackToPages(current, rollback);
    if (result.invalidationRequired) {
      shouldInvalidate = true;
    } else {
      queryClient.setQueryData<ConversationListInfiniteData>(rollback.queryKey, result.data);
    }
  }

  if (shouldInvalidate && context) {
    void queryClient.invalidateQueries({ queryKey: context.invalidationQueryKey });
  }
}

export function settleMarkConversationRead(
  queryClient: QueryClient,
  context: MarkConversationReadMutationContext | undefined,
  response: MarkConversationReadResponse
): void {
  let shouldInvalidate = false;

  for (const rollback of context?.rollbacks ?? []) {
    const current = queryClient.getQueryData<ConversationListInfiniteData>(rollback.queryKey);
    const result = applyConversationReadToPages(current, {
      conversationId: rollback.conversationId,
      lastReadAt: response.lastReadAt,
    });
    if (!result.applied) {
      shouldInvalidate = true;
    } else {
      queryClient.setQueryData<ConversationListInfiniteData>(rollback.queryKey, result.data);
    }
  }

  if (shouldInvalidate && context) {
    void queryClient.invalidateQueries({ queryKey: context.invalidationQueryKey });
  }
}

export function useMarkConversationRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, lastSeenMessageId }: MarkConversationReadMutationVariables) =>
      client.markConversationRead(conversationId, { lastSeenMessageId }),
    onMutate: variables => applyOptimisticMarkConversationRead(queryClient, variables),
    onError: (_err, _variables, context) => {
      rollbackOptimisticMarkConversationRead(queryClient, context);
    },
    onSuccess: (response, _variables, context) => {
      settleMarkConversationRead(queryClient, context, response);
    },
  });
}
