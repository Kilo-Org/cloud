import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type BotStatusRecord,
  type KiloChatClient,
  type KiloChatEventOf,
} from '@kilocode/kilo-chat';

import { botStatusKey } from './query-keys';

const POLL_INTERVAL_MS = 15_000;

export function useBotStatus(
  client: KiloChatClient,
  sandboxId: string | null
): BotStatusRecord | null {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!sandboxId) {
      return;
    }
    return client.onBotStatus((_ctx: string, event: KiloChatEventOf<'bot.status'>) => {
      if (event.sandboxId !== sandboxId) {
        return;
      }
      queryClient.setQueryData<BotStatusRecord | null>(botStatusKey(sandboxId), prev =>
        prev && prev.at >= event.at
          ? prev
          : { online: event.online, at: event.at, updatedAt: event.at }
      );
    });
  }, [client, queryClient, sandboxId]);

  useEffect(() => {
    if (!sandboxId) {
      return;
    }
    let cancelled = false;

    const tick = () => {
      if (cancelled) {
        return;
      }
      void client.requestBotStatus(sandboxId).catch(() => {
        // Best effort; the visible status comes from event-service pushes.
      });
    };

    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, sandboxId]);

  const { data } = useQuery({
    queryKey: botStatusKey(sandboxId),
    queryFn: async () => {
      if (!sandboxId) {
        return null;
      }
      const res = await client.getBotStatus(sandboxId);
      return res.status;
    },
    enabled: sandboxId !== null,
    staleTime: Infinity,
  });

  return data ?? null;
}
