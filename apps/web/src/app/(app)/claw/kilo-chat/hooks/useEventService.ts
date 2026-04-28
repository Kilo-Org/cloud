import { useEffect, useMemo } from 'react';
import { EventServiceClient } from '@kilocode/event-service';
import { KiloChatClient } from '@kilocode/kilo-chat';
import { presenceContextForConversation } from '@kilocode/notifications';
import { KILO_CHAT_URL, EVENT_SERVICE_URL } from '@/lib/constants';
import { clearKiloChatToken } from '../token';

/**
 * Creates and manages the EventServiceClient + KiloChatClient singleton.
 * Connects the WebSocket on mount, disconnects on unmount.
 * Returns the clients for use by child hooks.
 */
export function useEventService(getToken: () => Promise<string>) {
  const eventService = useMemo(
    () =>
      new EventServiceClient({
        url: EVENT_SERVICE_URL,
        getToken,
        // Event Service rejected our token as 401/403. Drop the cached
        // token so the next request refetches; the socket is permanently
        // stopped by the client to avoid a reconnect storm.
        onUnauthorized: () => {
          clearKiloChatToken();
        },
      }),
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
 * Subscribes to the instance-level context (`/kiloclaw/{sandboxId}`).
 * Used at the layout level for cross-conversation events (future: unread counts).
 */
export function useInstanceContext(eventService: EventServiceClient, sandboxId: string | null) {
  useEffect(() => {
    if (!sandboxId) return;
    const context = `/kiloclaw/${sandboxId}`;
    eventService.subscribe([context]);
    return () => eventService.unsubscribe([context]);
  }, [eventService, sandboxId]);
}

/**
 * Subscribes to the conversation-level context (`/kiloclaw/{sandboxId}/{conversationId}`).
 * Used in MessageArea for message/typing/reaction events.
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

/**
 * Subscribes to the presence context for the given conversation
 * (`/presence/kiloclaw/chat/{conversationId}`), but only while the tab/window
 * is visible. Unsubscribes when the document becomes hidden and re-subscribes
 * when it becomes visible again.
 */
export function useConversationPresence(eventService: EventServiceClient, conversationId: string) {
  useEffect(() => {
    const ctx = presenceContextForConversation(conversationId);
    let subscribed = false;
    const reconcile = () => {
      const shouldSub = !document.hidden;
      if (shouldSub && !subscribed) {
        eventService.subscribe([ctx]);
        subscribed = true;
      } else if (!shouldSub && subscribed) {
        eventService.unsubscribe([ctx]);
        subscribed = false;
      }
    };
    reconcile();
    document.addEventListener('visibilitychange', reconcile);
    return () => {
      document.removeEventListener('visibilitychange', reconcile);
      if (subscribed) eventService.unsubscribe([ctx]);
    };
  }, [conversationId, eventService]);
}
