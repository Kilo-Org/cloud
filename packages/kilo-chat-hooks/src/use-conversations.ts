import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import { ulidToTimestamp, type KiloChatClient } from '@kilocode/kilo-chat';
import type {
  CreateConversationRequest,
  ConversationListItem,
  ConversationListResponse,
  MarkConversationReadRequest,
} from '@kilocode/kilo-chat';

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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: conversationsKeyAll() });
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
};

export function useMarkConversationRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      lastSeenMessageId,
    }: MarkConversationReadRequest & { conversationId: string }) =>
      client.markConversationRead(conversationId, { lastSeenMessageId }),
    onMutate: ({ conversationId, lastSeenMessageId }): MarkConversationReadMutationContext => {
      const optimisticReadAt = ulidToTimestamp(lastSeenMessageId);
      const queryKey = conversationsKeyAll();
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
            conversation.conversationId === conversationId
              ? { ...conversation, lastReadAt: optimisticReadAt }
              : conversation
          )
        );
      }

      return { rollbacks };
    },
    onError: (_err, _variables, context) => {
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

      if (shouldInvalidate) {
        void queryClient.invalidateQueries({ queryKey: conversationsKeyAll() });
      }
    },
  });
}
