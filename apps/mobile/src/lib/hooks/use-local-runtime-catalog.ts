import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { useAppPresence } from '@/components/kilo-chat/hooks/use-app-presence';
import { type LocalRuntimeFence } from '@/lib/hooks/local-runtime-catalog-types';
import { useTRPC } from '@/lib/trpc';

const RUNTIME_CATALOG_SYSTEM_EVENTS = new Set(['runtime.updated', 'runtime.disconnected']);

const PLACEHOLDER_FENCE: LocalRuntimeFence = { runtimeId: '', connectionId: '' };

/**
 * Fetch the model catalog for a specific local runtime fence. The hook:
 *
 * - Disables itself when `fence` is `null` (no capable runtime selected).
 * - Anchors the query on the exact `(runtimeId, connectionId)` pair so a
 *   runtime reconnect produces a fresh query key and React Query discards
 *   the previous (now detached) response.
 * - Listens for the same set of runtime system events the runtime-list hook
 *   listens for, plus an app-resume refresh — the catalog is read-only
 *   metadata, so a periodic "try again on resume" is cheap.
 * - Returns the raw `useQuery` shape so the caller can project the
 *   (loading, error, ready) slice onto its own view-model.
 */
export function useLocalRuntimeCatalog(fence: LocalRuntimeFence | null) {
  const trpcClient = useTRPC();
  const queryClient = useQueryClient();
  const connection = useUserWebConnection();
  useAppPresence();

  const queryOptions = trpcClient.localRuntimeControl.getCatalog.queryOptions(
    fence ?? PLACEHOLDER_FENCE,
    { enabled: Boolean(fence), staleTime: 60_000 }
  );

  const query = useQuery(queryOptions);

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

  useEffect(() => {
    // The public type says retain is optional; the runtime value may also be
    // null in tests or if the provider ever relaxes its non-null contract.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!connection || typeof connection.retain !== 'function') {
      return undefined;
    }
    const release = connection.retain();
    const offSystem = connection.onSystemEvent(event => {
      if (RUNTIME_CATALOG_SYSTEM_EVENTS.has(event.event)) {
        void queryClient.invalidateQueries({
          queryKey: ['localRuntimeControl', 'getCatalog'],
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
    // The catalog query is anchored to the fence; we do not want to rebind
    // the lifecycle effect on every fence change. The connection object
    // outlives any individual fence, so the effect should only run on
    // connection identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, queryClient]);

  return query;
}
