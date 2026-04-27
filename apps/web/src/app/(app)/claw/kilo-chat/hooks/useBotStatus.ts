'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotStatusRecord, KiloChatEventOf } from '@kilocode/kilo-chat';
import { useKiloChatContext } from '../components/kiloChatContext';

const botKey = (sandboxId: string) => ['kilo-chat', 'bot-status', sandboxId] as const;

export function useBotStatus(): BotStatusRecord | null {
  const { kiloChatClient, sandboxId } = useKiloChatContext();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sandboxId) return;
    return kiloChatClient.onBotStatus((_ctx: string, e: KiloChatEventOf<'bot.status'>) => {
      if (e.sandboxId !== sandboxId) return;
      queryClient.setQueryData<BotStatusRecord | null>(botKey(sandboxId), prev =>
        prev && prev.at >= e.at ? prev : { online: e.online, at: e.at, updatedAt: e.at }
      );
    });
  }, [kiloChatClient, sandboxId, queryClient]);

  const { data } = useQuery({
    queryKey: botKey(sandboxId ?? ''),
    queryFn: async () => {
      if (!sandboxId) return null;
      const res = await kiloChatClient.getBotStatus(sandboxId);
      return res.status;
    },
    enabled: !!sandboxId,
    staleTime: Infinity,
  });

  return data ?? null;
}
