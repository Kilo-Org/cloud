import { useEffect } from 'react';

import { useKiloChat } from '../kilo-chat-provider';

export function useEventSubscription(sandboxId: string, conversationId: string) {
  const { eventService } = useKiloChat();
  useEffect(() => {
    const ctx = `/kiloclaw/${sandboxId}/${conversationId}`;
    eventService.subscribe([ctx]);
    return () => {
      eventService.unsubscribe([ctx]);
    };
  }, [eventService, sandboxId, conversationId]);
}
