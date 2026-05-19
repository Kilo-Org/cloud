import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type BotStatusEvent,
  type BotStatusRecord,
  type KiloChatClient,
  type KiloChatEventOf,
} from '@kilocode/kilo-chat';

import { botStatusKey, botStatusRequestKey } from './query-keys';

const POLL_INTERVAL_MS = 15_000;
const STATUS_STALE_MS = 10_000;

export function reduceBotStatusOnEvent(
  prev: BotStatusRecord | null | undefined,
  event: BotStatusEvent
): BotStatusRecord {
  if (prev && prev.at >= event.at) return prev;
  return {
    online: event.online,
    at: event.at,
    updatedAt: event.at,
    capabilities: event.capabilities ?? prev?.capabilities,
  };
}

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
        reduceBotStatusOnEvent(prev, event)
      );
    });
  }, [client, queryClient, sandboxId]);

  useQuery({
    queryKey: botStatusRequestKey(sandboxId),
    queryFn: async () => {
      if (!sandboxId) {
        return null;
      }
      await client.requestBotStatus(sandboxId).catch(() => {
        // Best effort; the visible status comes from event-service pushes.
      });
      return null;
    },
    enabled: sandboxId !== null,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: POLL_INTERVAL_MS,
  });

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
    staleTime: STATUS_STALE_MS,
  });

  return data ?? null;
}
