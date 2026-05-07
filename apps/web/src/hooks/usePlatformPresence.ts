'use client';

import { presenceContextForPlatform } from '@kilocode/event-service';
import { usePresenceSubscription } from '@kilocode/kilo-chat-hooks';

import { useDocumentVisible } from './useDocumentVisible';

export function usePlatformPresence() {
  const visible = useDocumentVisible();
  usePresenceSubscription(presenceContextForPlatform('web'), visible);
}
