import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KiloChatClient } from '@kilocode/kilo-chat';
import type { CreateConversationRequest, ConversationListResponse } from '@kilocode/kilo-chat';
import { useMemo } from 'react';
import { KILO_CHAT_URL } from '@/lib/constants';

const POLL_INTERVAL = 30_000;

function useClient(getToken: () => Promise<string>) {
  return useMemo(() => new KiloChatClient({ baseUrl: KILO_CHAT_URL, getToken }), [getToken]);
}

export function useConversations(getToken: () => Promise<string>, sandboxId: string | null) {
  const client = useClient(getToken);
  return useQuery({
    queryKey: ['kilo-chat', 'conversations', sandboxId],
    queryFn: () => client.listConversations(sandboxId ?? undefined),
    enabled: !!sandboxId,
    refetchInterval: POLL_INTERVAL,
  });
}

export function useConversationDetail(
  getToken: () => Promise<string>,
  conversationId: string | null
) {
  const client = useClient(getToken);
  return useQuery({
    queryKey: ['kilo-chat', 'conversation', conversationId],
    queryFn: () => client.getConversation(conversationId ?? ''),
    enabled: !!conversationId,
  });
}

export function useCreateConversation(getToken: () => Promise<string>) {
  const client = useClient(getToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (req: CreateConversationRequest) => client.createConversation(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat', 'conversations'] });
    },
  });
}

export function useRenameConversation(getToken: () => Promise<string>) {
  const client = useClient(getToken);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
      client.renameConversation(conversationId, { title }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['kilo-chat'] });
    },
  });
}

export function useLeaveConversation(getToken: () => Promise<string>) {
  const client = useClient(getToken);
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

export function useMarkConversationRead(getToken: () => Promise<string>) {
  const client = useClient(getToken);
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
