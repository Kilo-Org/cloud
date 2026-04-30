import { useEffect } from 'react';

import { useEventServiceClient } from './use-kilo-chat-client';

export function useEventSubscription(
  context: string | null,
  events: readonly string[],
  onEvent: (event: { event: string; payload: unknown }) => void
) {
  const eventService = useEventServiceClient();
  useEffect(() => {
    if (!context) return undefined;
    eventService.subscribe([context]);
    const offs = events.map(eventName =>
      eventService.on(eventName, (ctx, payload) => {
        if (ctx === context) onEvent({ event: eventName, payload });
      })
    );
    return () => {
      for (const off of offs) off();
      eventService.unsubscribe([context]);
    };
    // events is meant to be a stable array literal at the call site;
    // join to use as a dependency without forcing memoization on callers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventService, context, events.join('|'), onEvent]);
}
