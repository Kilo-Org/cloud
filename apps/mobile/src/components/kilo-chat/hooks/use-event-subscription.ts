import { useEffect } from 'react';

import { useEventServiceClient } from './use-kilo-chat-client';

/**
 * Subscribe to a single event-service event for one context. Call this hook
 * once per event name when you need multiple events on the same context.
 */
export function useEventSubscription(
  context: string | null,
  eventName: string,
  onEvent: (payload: unknown) => void
) {
  const eventService = useEventServiceClient();
  useEffect(() => {
    if (!context) {
      return undefined;
    }
    eventService.subscribe([context]);
    const off = eventService.on(eventName, (ctx, payload) => {
      if (ctx === context) {
        onEvent(payload);
      }
    });
    return () => {
      off();
      eventService.unsubscribe([context]);
    };
  }, [eventService, context, eventName, onEvent]);
}
