'use client';

import { presenceContextForAgentSession } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useDocumentVisible } from './useDocumentVisible';

/**
 * Exact-session presence for the Cloud Agent / remote CLI session the user
 * is actively viewing. Holds the `/presence/agent-session/{sessionId}`
 * context only while the tab is visible and a session is loaded, so
 * notifications routed through this context are suppressed only when the
 * user is on that specific session.
 *
 * `kiloSessionId` is the Kilo-side session id (not the Cloud Agent
 * session id) — the wrapper's policy filter and the outbox downstream
 * already gate what reaches this hook, so we only need to gate on
 * "is the user looking at this session right now" and document
 * visibility.
 */
export function useAgentSessionPresence(kiloSessionId: string | null) {
  const visible = useDocumentVisible();
  usePresenceSubscription(
    kiloSessionId ? presenceContextForAgentSession(kiloSessionId) : null,
    Boolean(kiloSessionId) && visible
  );
}
