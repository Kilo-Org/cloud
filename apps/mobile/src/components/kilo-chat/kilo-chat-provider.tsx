import { useEffect, useState } from 'react';

import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { KiloChatHooksProvider } from '@kilocode/kilo-chat-hooks';

import { EVENT_SERVICE_URL, KILO_CHAT_URL } from '@/lib/config';

import { useKiloChatTokenGetter } from './hooks/use-kilo-chat-token';

type KiloChatProviderProps = {
  children: React.ReactNode;
};

export function KiloChatProvider({ children }: KiloChatProviderProps) {
  const getToken = useKiloChatTokenGetter();

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

  return (
    <KiloChatHooksProvider
      value={{ kiloChatClient: value.kiloChatClient, eventService: value.eventService }}
    >
      {children}
    </KiloChatHooksProvider>
  );
}
