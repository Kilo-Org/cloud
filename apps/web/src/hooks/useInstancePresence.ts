'use client';

import { presenceContextForInstance } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useDocumentVisible } from './useDocumentVisible';

export function useInstancePresence(sandboxId: string | undefined, enabled = true) {
  const visible = useDocumentVisible();
  usePresenceSubscription(
    sandboxId ? presenceContextForInstance(sandboxId) : null,
    Boolean(sandboxId) && enabled && visible
  );
}
