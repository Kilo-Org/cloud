import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type ConversationListResponse, type CreateConversationRequest } from '@kilocode/kilo-chat';

import { useKiloChatClient } from './use-kilo-chat-client';

const CONVERSATIONS_PAGE_SIZE = 50;

export function useConversations(sandboxId: string | null) {
  const client = useKiloChatClient();
  return useInfiniteQuery({
    queryKey: ['kilo-chat', 'conversations', sandboxId],
    queryFn: async ({ pageParam }) => {
      const result = await client.listConversations({
        sandboxId: sandboxId ?? undefined,
        limit: CONVERSATIONS_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      });
      return result;
    },
    initialPageParam: null as string | null,
    getNextPageParam: lastPage => lastPage.nextCursor,
    enabled: Boolean(sandboxId),
    select: data => ({
      ...data,
      conversations: data.pages.flatMap(p => p.conversations),
    }),
  });
}

export function useConversationDetail(conversationId: string | null) {
  const client = useKiloChatClient();
  return useQuery({
    queryKey: ['kilo-chat', 'conversation', conversationId],
    queryFn: async () => {
      const result = await client.getConversation(conversationId ?? '');
      return result;
    },
    enabled: Boolean(conversationId),
  });
}

export function useCreateConversation() {
  const client = useKiloChatClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (req: CreateConversationRequest) => {
      const result = await client.createConversation(req);
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
    },
  });
}

export function useRenameConversation() {
  const client = useKiloChatClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ conversationId, title }: { conversationId: string; title: string }) => {
      const result = await client.renameConversation(conversationId, { title });
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
    },
  });
}

export function useLeaveConversation() {
  const client = useKiloChatClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) => {
      await client.leaveConversation(conversationId);
    },
    onSuccess: (_data, conversationId) => {
      queryClient.removeQueries({ queryKey: ['kilo-chat', 'conversation', conversationId] });
      queryClient.removeQueries({ queryKey: ['kilo-chat', 'messages', conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
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
  if (!data) {
    return data;
  }
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
  if (!data) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      conversations: page.conversations.filter(predicate),
    })),
  };
}

export function useMarkConversationRead() {
  const client = useKiloChatClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (conversationId: string) => {
      await client.markConversationRead(conversationId);
    },
    onMutate: conversationId => {
      // Optimistically set lastReadAt = now in all cached conversation lists
      const now = Date.now();
      const queryKey = ['kilo-chat', 'conversations'];
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
