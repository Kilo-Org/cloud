'use client';

import { presenceContextForInstance } from '@kilocode/event-service';

import { useDocumentVisible } from './useDocumentVisible';
import { usePresenceSubscription } from './usePresenceSubscription';

export function useInstancePresence(sandboxId: string | undefined, enabled = true) {
  const visible = useDocumentVisible();
  usePresenceSubscription(
    sandboxId ? presenceContextForInstance(sandboxId) : '',
    Boolean(sandboxId) && enabled && visible
  );
}
