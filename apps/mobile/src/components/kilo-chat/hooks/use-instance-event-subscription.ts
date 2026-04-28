import { useEffect } from 'react';

import { useKiloChat } from '../kilo-chat-provider';

export function useInstanceEventSubscription(sandboxId: string) {
  const { eventService } = useKiloChat();
  useEffect(() => {
    const ctx = `/kiloclaw/${sandboxId}`;
    eventService.subscribe([ctx]);
    return () => {
      eventService.unsubscribe([ctx]);
    };
  }, [eventService, sandboxId]);
}
