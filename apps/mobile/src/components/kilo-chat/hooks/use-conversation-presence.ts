import { presenceContextForConversation } from '@kilocode/event-service';

import { useAppActiveAndFocused } from './use-app-active-and-focused';
import { usePresenceSubscription } from './use-presence-subscription';

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
