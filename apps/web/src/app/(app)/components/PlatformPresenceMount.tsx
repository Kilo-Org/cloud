'use client';

import { usePlatformPresence } from '@/hooks/usePlatformPresence';

export function PlatformPresenceMount() {
  usePlatformPresence();
  return null;
}
