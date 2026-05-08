import { useEffect } from 'react';

import { useEventServiceClient } from './context';

export function usePresenceSubscription(context: string | null, active: boolean) {
  const eventService = useEventServiceClient();
  useEffect(() => {
    if (!active || context === null) return;
    eventService.subscribe([context]);
    return () => {
      eventService.unsubscribe([context]);
    };
  }, [eventService, context, active]);
}
