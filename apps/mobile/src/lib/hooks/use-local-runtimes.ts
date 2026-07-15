import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useAppPresence } from '@/components/kilo-chat/hooks/use-app-presence';
import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { useTRPC } from '@/lib/trpc';

const RUNTIME_SYSTEM_EVENTS = new Set([
  'runtimes.list',
  'runtime.connected',
  'runtime.updated',
  'runtime.disconnected',
]);

/**
 * Source of truth for the local-runtime list shown on the
 * `RuntimeDiscoveryContent` screen.
 *
 * - Wraps the `localRuntimeControl.list` tRPC query.
 * - Reuses the shared `UserWebConnection` (no second socket) by retaining it
 *   exactly once for the lifetime of this hook.
 * - Refreshes whenever the relay advertises a runtime change, on every
 *   user-web reconnect, and when the app returns to the foreground.
 * - Returns the raw `useQuery` result so callers can read the error
 *   unchanged — we never collapse a fetch failure into the empty state.
 */
export function useLocalRuntimes() {
  const trpcClient = useTRPC();
  const queryClient = useQueryClient();
  const connection = useUserWebConnection();
  const query = useQuery(trpcClient.localRuntimeControl.list.queryOptions());
  useAppPresence();

  useEffect(() => {
    // The public type says retain is optional; the runtime value may also be
    // null in tests or if the provider ever relaxes its non-null contract.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!connection || typeof connection.retain !== 'function') {
      return undefined;
    }
    const release = connection.retain();
    const offSystem = connection.onSystemEvent(event => {
      if (RUNTIME_SYSTEM_EVENTS.has(event.event)) {
        void queryClient.invalidateQueries({
          queryKey: trpcClient.localRuntimeControl.list.queryKey(),
        });
      }
    });
    const offReconnect = connection.onReconnect(() => {
      void query.refetch();
    });

    return () => {
      offSystem();
      offReconnect();
      release();
    };
    // query.refetch from react-query is referentially stable per query key
    // and the connection lifecycle spans the whole hook lifetime; the
    // explicit list of deps keeps the effect from re-binding on every
    // re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, queryClient, trpcClient]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') {
        void query.refetch();
      }
    });
    return () => {
      subscription.remove();
    };
  }, [query]);

  return query;
}
