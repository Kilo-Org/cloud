'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationStatusRecord, KiloChatEventOf } from '@kilocode/kilo-chat';
import { useKiloChatContext } from '../components/kiloChatContext';

const cvKey = (conversationId: string) =>
  ['kilo-chat', 'conversation-status', conversationId] as const;

export function useConversationStatus(conversationId: string): ConversationStatusRecord | null {
  const { kiloChatClient } = useKiloChatContext();
  const queryClient = useQueryClient();

  useEffect(() => {
    return kiloChatClient.onConversationStatus(
      (_ctx: string, e: KiloChatEventOf<'conversation.status'>) => {
        if (e.conversationId !== conversationId) return;
        queryClient.setQueryData<ConversationStatusRecord | null>(cvKey(conversationId), prev =>
          prev && prev.at >= e.at
            ? prev
            : {
                conversationId: e.conversationId,
                contextTokens: e.contextTokens,
                contextWindow: e.contextWindow,
                model: e.model,
                provider: e.provider,
                at: e.at,
                updatedAt: e.at,
              }
        );
      }
    );
  }, [kiloChatClient, conversationId, queryClient]);

  const { data } = useQuery({
    queryKey: cvKey(conversationId),
    queryFn: async () => {
      const res = await kiloChatClient.getConversationStatus(conversationId);
      return res.status;
    },
    staleTime: Infinity,
  });

  return data ?? null;
}
