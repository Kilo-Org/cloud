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

type UserWebConnectionHealth = {
  isConnected: boolean;
  reconnectExhausted: boolean;
};

/**
 * Reactive binding to both user-web transport signals: readiness and
 * reconnect exhaustion. Readiness keeps driving the automatic
 * `Reconnecting…` / `Connecting…` labels; exhaustion drives the explicit
 * recovery UI (`Connection lost` + `Retry`).
 */
export function useUserWebConnectionHealth(): UserWebConnectionHealth {
  const connection = useUserWebConnection();
  const isConnected = useSyncExternalStore(
    listener => connection.onConnectionChange(listener),
    () => connection.isConnected()
  );
  const reconnectExhausted = useSyncExternalStore(
    listener => connection.onReconnectExhaustionChange(listener),
    () => connection.isReconnectExhausted()
  );
  return { isConnected, reconnectExhausted };
}
