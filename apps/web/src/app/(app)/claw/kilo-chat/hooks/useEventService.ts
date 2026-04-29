import { useEffect } from 'react';
import {
  type EventServiceClient,
  kiloclawInstanceContext,
  kiloclawConversationContext,
} from '@kilocode/event-service';

/**
 * Subscribes to the instance-level context (`/kiloclaw/{sandboxId}`).
 * Used at the layout level for cross-conversation events (future: unread counts).
 */
export function useInstanceContext(eventService: EventServiceClient, sandboxId: string | null) {
  useEffect(() => {
    if (!sandboxId) return;
    const context = kiloclawInstanceContext(sandboxId);
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
    const context = kiloclawConversationContext(sandboxId, conversationId);
    eventService.subscribe([context]);
    return () => eventService.unsubscribe([context]);
  }, [eventService, sandboxId, conversationId]);
}
