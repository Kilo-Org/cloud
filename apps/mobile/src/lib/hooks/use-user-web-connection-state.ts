import { useSyncExternalStore } from 'react';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';

/**
 * Reactive binding to the shared user-web-connection transport
 * readiness. Used by `useActiveSessions` to flip its `refetchInterval`
 * between 10s (offline) and disabled (connected). The subscription is
 * `useSyncExternalStore` over the wrapper-owned connection-state API
 * added in S2 (`isConnected` + `onConnectionChange`), so concurrent
 * consumers share one subscription per connection.
 */
export function useUserWebConnectionState(): boolean {
  const connection = useUserWebConnection();
  return useSyncExternalStore(
    listener => connection.onConnectionChange(listener),
    () => connection.isConnected()
  );
}
