'use client';

import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { KiloChatHooksProvider } from '@kilocode/kilo-chat-hooks';
import { EVENT_SERVICE_URL, KILO_CHAT_URL } from '@/lib/constants';
import { getKiloChatToken, clearKiloChatToken } from '@/app/(app)/claw/kilo-chat/token';

export type EventServiceContextValue = {
  eventService: EventServiceClient;
  kiloChatClient: KiloChatClient;
};

const EventServiceContext = createContext<EventServiceContextValue | null>(null);

type EventServiceProviderProps = {
  children: ReactNode;
};

/**
 * Global EventService provider — owns the single `EventServiceClient` and
 * `KiloChatClient` for the authenticated app. Mounted in `(app)/layout.tsx`
 * so platform-, instance-, and conversation-level presence subscriptions
 * (and the kilo-chat UI) all share one WebSocket.
 */
export function EventServiceProvider({ children }: EventServiceProviderProps) {
  const eventService = useMemo(
    () =>
      new EventServiceClient({
        url: EVENT_SERVICE_URL,
        getToken: getKiloChatToken,
        // Event Service rejected our token as 401/403. Drop the cached token
        // so the bounded reconnect path refetches a fresh one.
        onUnauthorized: () => {
          clearKiloChatToken();
          return 'retry';
        },
      }),
    []
  );

  const kiloChatClient = useMemo(
    () =>
      new KiloChatClient({
        eventService,
        baseUrl: KILO_CHAT_URL,
        getToken: getKiloChatToken,
        onUnauthorized: () => {
          clearKiloChatToken();
          return 'retry';
        },
      }),
    [eventService]
  );

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    void eventService.connect();
    return () => eventService.disconnect();
  }, [eventService]);

  const value = useMemo<EventServiceContextValue>(
    () => ({ eventService, kiloChatClient }),
    [eventService, kiloChatClient]
  );

  return (
    <EventServiceContext.Provider value={value}>
      <KiloChatHooksProvider value={{ kiloChatClient, eventService }}>
        {children}
      </KiloChatHooksProvider>
    </EventServiceContext.Provider>
  );
}

export function useEventServiceClient(): EventServiceContextValue {
  const ctx = useContext(EventServiceContext);
  if (!ctx) {
    throw new Error('useEventServiceClient must be used within an EventServiceProvider');
  }
  return ctx;
}
