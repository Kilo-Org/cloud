import { presenceContextForInstance } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useAppActiveAndFocused } from './use-app-active-and-focused';

export function useInstancePresence(sandboxId: string | undefined) {
  const activeAndFocused = useAppActiveAndFocused();
  usePresenceSubscription(
    sandboxId ? presenceContextForInstance(sandboxId) : null,
    Boolean(sandboxId) && activeAndFocused
  );
}
