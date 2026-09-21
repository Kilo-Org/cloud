import { presenceContextForPlatform } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useAppStateActive } from '@/lib/hooks/use-app-state-active';

export function useAppPresence() {
  const active = useAppStateActive();
  usePresenceSubscription(presenceContextForPlatform('app'), active);
}
