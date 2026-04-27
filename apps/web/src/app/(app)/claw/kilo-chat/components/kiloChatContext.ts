'use client';

import { createContext, useContext } from 'react';
import type { EventServiceClient } from '@kilocode/event-service';
import type { KiloChatClient } from '@kilocode/kilo-chat';

export type KiloChatContextValue = {
  getToken: () => Promise<string>;
  currentUserId: string;
  instanceStatus: string | null;
  leavingConversationId: string | null;
  assistantName: string | null;
  sandboxId: string | null;
  basePath: string;
  noInstanceRedirect: string;
  isInstanceLoading: boolean;
  eventService: EventServiceClient;
  kiloChatClient: KiloChatClient;
};

export const KiloChatContext = createContext<KiloChatContextValue | null>(null);

export function useKiloChatContext() {
  const ctx = useContext(KiloChatContext);
  if (!ctx) throw new Error('useKiloChatContext must be used within KiloChatLayout');
  return ctx;
}
