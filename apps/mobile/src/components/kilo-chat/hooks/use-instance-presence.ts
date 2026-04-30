import { presenceContextForInstance } from '@kilocode/event-service';

import { useAppActiveAndFocused } from './use-app-active-and-focused';
import { usePresenceSubscription } from './use-presence-subscription';

export function useInstancePresence(sandboxId: string | undefined) {
  const activeAndFocused = useAppActiveAndFocused();
  usePresenceSubscription(
    sandboxId ? presenceContextForInstance(sandboxId) : null,
    Boolean(sandboxId) && activeAndFocused
  );
}
