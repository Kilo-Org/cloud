import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KiloChatClient } from '@kilocode/kilo-chat';
import type { CreateConversationRequest } from '@kilocode/kilo-chat';
import { useMemo } from 'react';
import { KILO_CHAT_URL } from '@/lib/constants';

const POLL_INTERVAL = 30_000;

function useClient(getToken: () => Promise<string>) {
  return useMemo(() => new KiloChatClient({ baseUrl: KILO_CHAT_URL, getToken }), [getToken]);
}

export function useConversations(getToken: () => Promise<string>) {
  const client = useClient(getToken);
  return useQuery({
    queryKey: ['kilo-chat', 'conversations'],
    queryFn: () => client.listConversations(),
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
