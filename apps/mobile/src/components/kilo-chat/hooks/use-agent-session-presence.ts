import { presenceContextForAgentSession } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useAppActiveAndFocused } from './use-app-active-and-focused';

/**
 * Exact-session presence for the Cloud Agent / remote CLI session the user
 * is actively viewing. Mirrors the gating of `useConversationPresence`:
 * holds the presence context only while the app is in the foreground AND
 * the current expo-router route is focused. When the user is on any other
 * session (or no session at all), the context is released so notifications
 * can reach the device.
 *
 * The wrapper's policy filter already suppresses auto-approved and
 * non-actionable upstream events, so we only need to gate on
 * "is the user looking at this session right now" — not on transport
 * state, message stream status, or any other internal flag.
 */
export function useAgentSessionPresence(sessionId: string | undefined) {
  const activeAndFocused = useAppActiveAndFocused();
  usePresenceSubscription(
    sessionId ? presenceContextForAgentSession(sessionId) : null,
    Boolean(sessionId) && activeAndFocused
  );
}
