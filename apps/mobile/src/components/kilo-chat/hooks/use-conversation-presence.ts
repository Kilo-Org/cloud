import { presenceContextForConversation } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useAppActiveAndFocused } from './use-app-active-and-focused';

export function useConversationPresence(
  sandboxId: string | undefined,
  conversationId: string | undefined
) {
  const activeAndFocused = useAppActiveAndFocused();
  usePresenceSubscription(
    sandboxId && conversationId ? presenceContextForConversation(sandboxId, conversationId) : null,
    Boolean(sandboxId && conversationId) && activeAndFocused
  );
}
