import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
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

type ApplyConversationActivityResult = {
  data: ConversationListInfiniteData | undefined;
  applied: boolean;
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
): ApplyConversationActivityResult {
  const firstPage = data?.pages[0];
  if (!data || !firstPage?.conversations.some(c => c.conversationId === activity.conversationId)) {
    return { data, applied: false };
  }

  return {
    data: {
      ...data,
      pages: data.pages.map((page, index) =>
        index === 0
          ? {
              ...page,
              conversations: page.conversations
                .map(c =>
                  c.conversationId === activity.conversationId
                    ? { ...c, lastActivityAt: activity.lastActivityAt }
                    : c
                )
                .sort(compareConversationsByActivity),
            }
          : page
      ),
    },
    applied: true,
  };
}

export function useMarkConversationRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      conversationId,
      lastSeenMessageId,
    }: MarkConversationReadRequest & { conversationId: string }) =>
      client.markConversationRead(conversationId, { lastSeenMessageId }),
    onMutate: ({ conversationId }) => {
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
  });
}
