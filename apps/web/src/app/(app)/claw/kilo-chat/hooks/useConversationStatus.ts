'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { ConversationStatusRecord, KiloChatEventOf } from '@kilocode/kilo-chat';
import { useKiloChatContext } from '../components/kiloChatContext';

type ConversationStatusReconnectEventService = {
  onReconnect: (handler: () => void) => () => void;
};

export const conversationStatusKey = (conversationId: string) =>
  ['kilo-chat', 'conversation-status', conversationId] as const;

export function registerConversationStatusReconnectHandler({
  conversationId,
  eventService,
  queryClient,
}: {
  conversationId: string;
  eventService: ConversationStatusReconnectEventService;
  queryClient: QueryClient;
}): () => void {
  return eventService.onReconnect(() => {
    void queryClient.invalidateQueries({ queryKey: conversationStatusKey(conversationId) });
  });
}

export function useConversationStatus(conversationId: string): ConversationStatusRecord | null {
  const { eventService, kiloChatClient } = useKiloChatContext();
  const queryClient = useQueryClient();

  useEffect(() => {
    return kiloChatClient.onConversationStatus(
      (_ctx: string, e: KiloChatEventOf<'conversation.status'>) => {
        if (e.conversationId !== conversationId) return;
        queryClient.setQueryData<ConversationStatusRecord | null>(
          conversationStatusKey(conversationId),
          prev =>
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

  useEffect(() => {
    return registerConversationStatusReconnectHandler({
      conversationId,
      eventService,
      queryClient,
    });
  }, [conversationId, eventService, queryClient]);

  const { data } = useQuery({
    queryKey: conversationStatusKey(conversationId),
    queryFn: async () => {
      const res = await kiloChatClient.getConversationStatus(conversationId);
      return res.status;
    },
    staleTime: Infinity,
  });

  return data ?? null;
}
