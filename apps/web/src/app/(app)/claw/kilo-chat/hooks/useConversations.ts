import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type { CreateConversationRequest, ConversationListResponse } from '@kilocode/kilo-chat';

const CONVERSATIONS_PAGE_SIZE = 50;

export function useConversations(client: KiloChatClient, sandboxId: string | null) {
  return useInfiniteQuery({
    queryKey: ['kilo-chat', 'conversations', sandboxId],
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
    queryKey: ['kilo-chat', 'conversation', conversationId],
    queryFn: () => client.getConversation(conversationId ?? ''),
    enabled: !!conversationId,
  });
}

export function useCreateConversation(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateConversationRequest) => client.createConversation(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
    },
  });
}

export function useRenameConversation(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
      client.renameConversation(conversationId, { title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
    },
  });
}

export function useLeaveConversation(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => client.leaveConversation(conversationId),
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

export function useMarkConversationRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => client.markConversationRead(conversationId),
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
