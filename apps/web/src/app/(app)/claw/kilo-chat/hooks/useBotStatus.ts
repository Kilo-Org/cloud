'use client';

import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { BotStatusRecord, KiloChatEventOf } from '@kilocode/kilo-chat';
import { useKiloChatContext } from '../components/kiloChatContext';

const botKey = (sandboxId: string) => ['kilo-chat', 'bot-status', sandboxId] as const;

// Matches the bot's old heartbeat cadence so UI staleness thresholds keep
// working unchanged. Server-side dedupe absorbs multi-tab / multi-device
// polling so this stays at ~1 webhook per sandbox per interval.
const POLL_INTERVAL_MS = 15_000;

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

  // Active presence signal: while the hook is mounted (user is on a chat
  // surface), nudge the bot to publish a fresh status. The server dedupes
  // and an idle sandbox with no observers stops generating traffic.
  useEffect(() => {
    if (!sandboxId) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void kiloChatClient.requestBotStatus(sandboxId).catch(() => {
        // Best-effort; the visible status comes from event-service pushes,
        // so a failed nudge just means the next tick retries.
      });
    };
    tick();
    const timer = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [kiloChatClient, sandboxId]);

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
