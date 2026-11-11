import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { EventServiceClient, presenceContextForPlatform } from '@kilocode/event-service';

import { EVENT_SERVICE_URL } from '@/lib/config';
import { useAppStateActive } from '@/lib/hooks/use-app-state-active';
import {
  clearEventServiceTokenCache,
  useEventServiceTokenGetter,
} from '@/lib/hooks/use-event-service-token';

const EventServiceContext = createContext<EventServiceClient | null>(null);

export function EventServiceProvider({ children }: { children: ReactNode }) {
  const getToken = useEventServiceTokenGetter();
  const active = useAppStateActive();
  const [eventService] = useState(
    () =>
      new EventServiceClient({
        url: EVENT_SERVICE_URL,
        getToken,
        onUnauthorized: () => {
          clearEventServiceTokenCache();
          return 'retry';
        },
      })
  );

  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const context = presenceContextForPlatform('app');
    void eventService.acquire();
    eventService.subscribe([context]);
    return () => {
      eventService.unsubscribe([context]);
      eventService.release();
    };
  }, [eventService, active]);

  return (
    <EventServiceContext.Provider value={eventService}>{children}</EventServiceContext.Provider>
  );
}

export function usePresenceSubscription(context: string | null, active: boolean) {
  const eventService = useContext(EventServiceContext);
  if (!eventService) {
    throw new Error('usePresenceSubscription must be used within EventServiceProvider');
  }
  useEffect(() => {
    if (!active || context === null) {
      return undefined;
    }
    eventService.subscribe([context]);
    return () => {
      eventService.unsubscribe([context]);
    };
  }, [eventService, context, active]);
}
