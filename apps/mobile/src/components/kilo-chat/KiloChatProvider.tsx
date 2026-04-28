import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';

import { EVENT_SERVICE_WS_URL, KILO_CHAT_URL } from '@/lib/config';

import { useKiloChatToken } from './hooks/useKiloChatToken';

type KiloChatCtx = {
  eventService: EventServiceClient;
  kiloChatClient: KiloChatClient;
};

const KiloChatContext = createContext<KiloChatCtx | null>(null);

export function KiloChatProvider({ children }: { children: ReactNode }) {
  const { getToken, invalidate } = useKiloChatToken();

  const value = useMemo<KiloChatCtx>(() => {
    const eventService = new EventServiceClient({
      url: EVENT_SERVICE_WS_URL,
      getToken,
      onUnauthorized: invalidate,
    });
    const kiloChatClient = new KiloChatClient({
      eventService,
      baseUrl: KILO_CHAT_URL,
      getToken,
    });
    return { eventService, kiloChatClient };
  }, [getToken, invalidate]);

  useEffect(() => {
    void value.eventService.connect();
    return () => value.eventService.disconnect();
  }, [value.eventService]);

  return <KiloChatContext.Provider value={value}>{children}</KiloChatContext.Provider>;
}

export function useKiloChat(): KiloChatCtx {
  const ctx = useContext(KiloChatContext);
  if (!ctx) throw new Error('useKiloChat used outside KiloChatProvider');
  return ctx;
}
