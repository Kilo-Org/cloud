import { presenceContextForCliSession } from '@kilocode/event-service';
import { usePresenceSubscription } from '@/components/event-service-provider';
import { useAppActiveAndFocused } from '@/lib/hooks/use-app-active-and-focused';

export function resolveLoadedCliSessionPresenceId(
  routeSessionId: string,
  loadedSessionId: string | null | undefined
): string | undefined {
  return loadedSessionId === routeSessionId ? routeSessionId : undefined;
}

export function useCliSessionPresence(sessionId: string | undefined): void {
  const activeAndFocused = useAppActiveAndFocused();
  usePresenceSubscription(
    sessionId ? presenceContextForCliSession(sessionId) : null,
    Boolean(sessionId) && activeAndFocused
  );
}
