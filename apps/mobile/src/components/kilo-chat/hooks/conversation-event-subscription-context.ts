import { kiloclawConversationContext } from '@kilocode/event-service';

export function conversationEventSubscriptionContext(
  sandboxId: string | undefined,
  conversationId: string | undefined,
  activeAndFocused: boolean
): string | null {
  if (!activeAndFocused || !sandboxId || !conversationId) {
    return null;
  }
  return kiloclawConversationContext(sandboxId, conversationId);
}
