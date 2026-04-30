import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { messagesKey } from '@kilocode/kilo-chat-hooks';

import { conversationEventSubscriptionContext } from './conversation-event-subscription-context';
import { useAppActiveAndFocused } from './use-app-active-and-focused';
import { useEventServiceClient } from './use-kilo-chat-client';

export function useConversationEventSubscription(
  sandboxId: string | undefined,
  conversationId: string | undefined
) {
  const eventService = useEventServiceClient();
  const queryClient = useQueryClient();
  const activeAndFocused = useAppActiveAndFocused();
  const context = conversationEventSubscriptionContext(sandboxId, conversationId, activeAndFocused);

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
    if (!conversationId || !activeAndFocused) {
      return undefined;
    }
    void queryClient.invalidateQueries({ queryKey: messagesKey(conversationId) });
    return eventService.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: messagesKey(conversationId) });
    });
  }, [eventService, queryClient, conversationId, activeAndFocused]);
}
