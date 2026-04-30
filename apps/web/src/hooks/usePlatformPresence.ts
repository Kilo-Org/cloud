'use client';

import { presenceContextForPlatform } from '@kilocode/event-service';

import { useDocumentVisible } from './useDocumentVisible';
import { usePresenceSubscription } from './usePresenceSubscription';

export function usePlatformPresence() {
  const visible = useDocumentVisible();
  usePresenceSubscription(presenceContextForPlatform('web'), visible);
}
