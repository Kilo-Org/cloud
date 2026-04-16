import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  ConversationListResponse,
  ConversationDetailResponse,
  CreateConversationRequest,
  CreateConversationResponse,
} from '../types';
import { useKiloChatClient } from './useKiloChatClient';

const POLL_INTERVAL = 30_000;

export function useConversations(getToken: () => Promise<string>, sandboxId: string | null) {
  const client = useKiloChatClient(getToken);

  return useQuery({
    queryKey: ['kilo-chat', 'conversations', sandboxId],
    queryFn: () => client.fetch<ConversationListResponse>('/v1/conversations'),
    enabled: !!sandboxId,
    refetchInterval: POLL_INTERVAL,
  });
}

export function useConversationDetail(
  getToken: () => Promise<string>,
  conversationId: string | null
) {
  const client = useKiloChatClient(getToken);

  return useQuery({
    queryKey: ['kilo-chat', 'conversation', conversationId],
    queryFn: () => client.fetch<ConversationDetailResponse>(`/v1/conversations/${conversationId}`),
    enabled: !!conversationId,
  });
}

export function useCreateConversation(getToken: () => Promise<string>) {
  const client = useKiloChatClient(getToken);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (req: CreateConversationRequest) =>
      client.fetch<CreateConversationResponse>('/v1/conversations', {
        method: 'POST',
        body: req,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['kilo-chat', 'conversations'],
      });
    },
  });
}
