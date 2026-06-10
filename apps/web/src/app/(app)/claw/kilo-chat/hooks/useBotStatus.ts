'use client';

import type { BotStatusRecord } from '@kilocode/kilo-chat';
import { useBotStatus as useSharedBotStatus } from '@kilocode/kilo-chat-hooks';
import { useKiloChatContext } from '../components/kiloChatContext';

export function useBotStatus(): BotStatusRecord | null {
  const { kiloChatClient, eventService, sandboxId } = useKiloChatContext();
  return useSharedBotStatus(kiloChatClient, eventService, sandboxId);
}
