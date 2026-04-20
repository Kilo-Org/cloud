import { useEffect, useMemo } from 'react';
import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { KILO_CHAT_URL, EVENT_SERVICE_URL } from '@/lib/constants';

/**
 * Creates and manages the EventServiceClient + KiloChatClient singleton.
 * Connects the WebSocket on mount, disconnects on unmount.
 * Returns the clients for use by child hooks.
 */
export function useEventService(getToken: () => Promise<string>) {
  const eventService = useMemo(
    () => new EventServiceClient({ url: EVENT_SERVICE_URL, getToken }),
    [getToken]
  );

  const kiloChatClient = useMemo(
    () => new KiloChatClient({ eventService, baseUrl: KILO_CHAT_URL, getToken }),
    [eventService, getToken]
  );

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    void eventService.connect();
    return () => eventService.disconnect();
  }, [eventService]);

  return { eventService, kiloChatClient };
}

/**
 * Subscribes to a conversation context for the duration of the component's mount.
 */
export function useConversationContext(
  eventService: EventServiceClient,
  sandboxId: string | null,
  conversationId: string | null
) {
  useEffect(() => {
    if (!sandboxId || !conversationId) return;
    const context = `/kiloclaw/${sandboxId}/${conversationId}`;
    eventService.subscribe([context]);
    return () => eventService.unsubscribe([context]);
  }, [eventService, sandboxId, conversationId]);
}
