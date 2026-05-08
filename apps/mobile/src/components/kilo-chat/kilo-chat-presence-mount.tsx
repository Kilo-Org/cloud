import { type ReactNode } from 'react';

import { useAppPresence } from './hooks/use-app-presence';
import { useUnreadCountsInvalidation } from '@/lib/hooks/use-unread-counts-invalidation';

export function KiloChatPresenceMount({ children }: { children: ReactNode }) {
  useAppPresence();
  useUnreadCountsInvalidation();
  return <>{children}</>;
}
