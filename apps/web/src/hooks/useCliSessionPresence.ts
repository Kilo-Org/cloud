'use client';

import { presenceContextForCliSession } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useDocumentVisible } from './useDocumentVisible';

export function useCliSessionPresence(sessionId: string | null, enabled = true) {
  const visible = useDocumentVisible();
  usePresenceSubscription(
    sessionId ? presenceContextForCliSession(sessionId) : null,
    Boolean(sessionId) && enabled && visible
  );
}
