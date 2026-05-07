import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { kiloclawConversationContext } from '@kilocode/event-service';
import { messagesKey } from '@kilocode/kilo-chat-hooks';

import { useEventServiceClient } from './use-kilo-chat-client';

export function useConversationEventSubscription(
  sandboxId: string | undefined,
  conversationId: string | undefined
) {
  const eventService = useEventServiceClient();
  const queryClient = useQueryClient();
  const context =
    sandboxId && conversationId ? kiloclawConversationContext(sandboxId, conversationId) : null;

  useEffect(() => {
    if (!context) {
      return undefined;
    }
    eventService.subscribe([context]);
    return () => {
      eventService.unsubscribe([context]);
    };
  }, [eventService, context]);

  useEffect(() => {
    if (!conversationId) {
      return undefined;
    }
    return eventService.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: messagesKey(conversationId) });
    });
  }, [eventService, queryClient, conversationId]);
}
