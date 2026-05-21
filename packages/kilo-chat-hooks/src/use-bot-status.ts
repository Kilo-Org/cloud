import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventServiceClient } from '@kilocode/event-service';
import {
  type BotStatusEvent,
  type BotStatusRecord,
  type KiloChatClient,
  type KiloChatEventOf,
} from '@kilocode/kilo-chat';

import { botStatusKey } from './query-keys';

const POLL_INTERVAL_MS = 15_000;

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
  eventClient: EventServiceClient,
  sandboxId: string | null
): BotStatusRecord | null {
  const queryClient = useQueryClient();

  // WS-ready gate. onConnected fires synchronously if already connected, and on every reconnect.
  const [wsReady, setWsReady] = useState(false);
  useEffect(() => {
    return eventClient.onConnected(() => {
      setWsReady(true);
      // On reconnect, refetch to catch up on anything we missed while disconnected.
      if (sandboxId) {
        void queryClient.invalidateQueries({ queryKey: botStatusKey(sandboxId) });
      }
    });
  }, [eventClient, queryClient, sandboxId]);

  // Steady-state WS push handler.
  useEffect(() => {
    if (!sandboxId) return;
    return client.onBotStatus((_ctx: string, event: KiloChatEventOf<'bot.status'>) => {
      if (event.sandboxId !== sandboxId) return;
      queryClient.setQueryData<BotStatusRecord | null>(botStatusKey(sandboxId), prev =>
        reduceBotStatusOnEvent(prev, event)
      );
    });
  }, [client, queryClient, sandboxId]);

  const { data } = useQuery({
    queryKey: botStatusKey(sandboxId),
    queryFn: async () => {
      if (!sandboxId) return null;
      const res = await client.requestBotStatus(sandboxId);
      // Use a functional updater so any WS event that races between requestBotStatus resolving
      // and this write is preserved: the updater sees the current cache value atomically.
      queryClient.setQueryData<BotStatusRecord | null>(botStatusKey(sandboxId), prev => {
        if (!res.cached) return prev ?? null;
        if (prev && prev.at >= res.cached.at) return prev;
        return res.cached;
      });
      return queryClient.getQueryData<BotStatusRecord | null>(botStatusKey(sandboxId)) ?? null;
    },
    enabled: sandboxId !== null && wsReady,
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 0,
  });

  return data ?? null;
}
