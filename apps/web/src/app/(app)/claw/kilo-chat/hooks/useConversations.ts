import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { KiloChatClient } from '@kilocode/kilo-chat';
import type { CreateConversationRequest, ConversationListResponse } from '@kilocode/kilo-chat';

const POLL_INTERVAL = 30_000;

export function useConversations(client: KiloChatClient, sandboxId: string | null) {
  return useQuery({
    queryKey: ['kilo-chat', 'conversations', sandboxId],
    queryFn: () => client.listConversations(sandboxId ?? undefined),
    enabled: !!sandboxId,
    refetchInterval: POLL_INTERVAL,
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
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat'] });
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

export function useMarkConversationRead(client: KiloChatClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (conversationId: string) => client.markConversationRead(conversationId),
    onMutate: conversationId => {
      // Optimistically set lastReadAt = now in all cached conversation lists
      const now = Date.now();
      queryClient.setQueriesData<ConversationListResponse>(
        { queryKey: ['kilo-chat', 'conversations'] },
        old => {
          if (!old) return old;
          return {
            ...old,
            conversations: old.conversations.map(c =>
              c.conversationId === conversationId ? { ...c, lastReadAt: now } : c
            ),
          };
        }
      );
    },
  });
}
