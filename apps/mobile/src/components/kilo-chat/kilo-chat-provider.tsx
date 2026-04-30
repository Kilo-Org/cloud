import { createContext, useContext, useEffect, useState } from 'react';

import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { KiloChatHooksProvider } from '@kilocode/kilo-chat-hooks';

import { EVENT_SERVICE_URL, KILO_CHAT_URL } from '@/lib/config';

import { useKiloChatTokenGetter } from './hooks/use-kilo-chat-token';

type KiloChatContextValue = {
  eventService: EventServiceClient;
  kiloChatClient: KiloChatClient;
};

export const KiloChatContext = createContext<KiloChatContextValue | null>(null);

export function useKiloChatContext(): KiloChatContextValue {
  const ctx = useContext(KiloChatContext);
  if (!ctx) {
    throw new Error('useKiloChatContext must be used within a KiloChatProvider');
  }
  return ctx;
}

type KiloChatProviderProps = {
  children: React.ReactNode;
};

export function KiloChatProvider({ children }: KiloChatProviderProps) {
  const getToken = useKiloChatTokenGetter();

  const [value] = useState<KiloChatContextValue>(() => {
    const eventService = new EventServiceClient({
      url: EVENT_SERVICE_URL,
      getToken,
    });
    const kiloChatClient = new KiloChatClient({
      eventService,
      baseUrl: KILO_CHAT_URL,
      getToken,
    });
    return { eventService, kiloChatClient };
  });

  useEffect(() => {
    void value.eventService.connect();
    return () => {
      value.eventService.disconnect();
    };
  }, [value]);

  return (
    <KiloChatContext.Provider value={value}>
      <KiloChatHooksProvider
        value={{ kiloChatClient: value.kiloChatClient, eventService: value.eventService }}
      >
        {children}
      </KiloChatHooksProvider>
    </KiloChatContext.Provider>
  );
}
