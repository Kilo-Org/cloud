import { useEffect } from 'react';

import { useEventServiceClient } from './use-kilo-chat-client';

export function usePresenceSubscription(context: string | null, active: boolean) {
  const eventService = useEventServiceClient();
  useEffect(() => {
    if (!active || !context) {
      return undefined;
    }
    eventService.subscribe([context]);
    return () => {
      eventService.unsubscribe([context]);
    };
  }, [eventService, context, active]);
}
