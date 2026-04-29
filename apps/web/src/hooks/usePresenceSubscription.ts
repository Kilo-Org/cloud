'use client';

import { useEffect } from 'react';
import { useEventServiceClient } from '@/contexts/EventServiceContext';

/**
 * Subscribes to a single presence/event-service context for the lifetime of
 * the calling component. Bails out when `active` is false so callers can
 * gate the subscription on, e.g., feature flags or page visibility.
 *
 * Reads the global `EventServiceClient` from `EventServiceProvider`, mounted
 * in `(app)/layout.tsx` for every authenticated route.
 */
export function usePresenceSubscription(context: string, active: boolean) {
  const { eventService } = useEventServiceClient();
  useEffect(() => {
    if (!active || !context) return;
    eventService.subscribe([context]);
    return () => {
      eventService.unsubscribe([context]);
    };
  }, [eventService, context, active]);
}
