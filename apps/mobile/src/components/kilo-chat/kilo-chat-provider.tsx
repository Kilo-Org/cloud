import { createContext, useEffect, useState } from 'react';

import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { KiloChatHooksProvider } from '@kilocode/kilo-chat-hooks';

import { EVENT_SERVICE_URL, KILO_CHAT_URL } from '@/lib/config';

import {
  useKiloChatTokenGetter,
  useKiloChatTokenResponseGetter,
} from './hooks/use-kilo-chat-token';

type KiloChatProviderProps = {
  children: React.ReactNode;
};

export const KiloChatCurrentUserContext = createContext<string | null>(null);

export function KiloChatProvider({ children }: KiloChatProviderProps) {
  const getToken = useKiloChatTokenGetter();
  const getTokenResponse = useKiloChatTokenResponseGetter();
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [value] = useState(() => {
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

  useEffect(() => {
    let cancelled = false;

    async function resolveCurrentUserId() {
      try {
        const response = await getTokenResponse();
        if (!cancelled) {
          setCurrentUserId(response.userId);
        }
      } catch {
        if (!cancelled) {
          setCurrentUserId(null);
        }
      }
    }

    void resolveCurrentUserId();

    return () => {
      cancelled = true;
    };
  }, [getTokenResponse]);

  return (
    <KiloChatCurrentUserContext.Provider value={currentUserId}>
      <KiloChatHooksProvider
        value={{ kiloChatClient: value.kiloChatClient, eventService: value.eventService }}
      >
        {children}
      </KiloChatHooksProvider>
    </KiloChatCurrentUserContext.Provider>
  );
}
