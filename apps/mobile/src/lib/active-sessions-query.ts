/**
 * The shared `activeSessions.list` query.
 *
 * Lives apart from `active-sessions-live-sync-mount.tsx` on purpose: the mount
 * module owns app-wide native side effects (the socket lease and the app-owned
 * needs-input notification, which loads expo-router and expo-notifications) and
 * is imported only by the `(app)` layout, while this query is consumed by every
 * Agents list surface. Keeping the query out of the mount keeps those native
 * modules off the list screens' import graph.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { refreshActiveSessionsNow } from '@/lib/active-sessions-live-sync';
import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { useAuth } from '@/lib/auth/auth-context';
import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { type UseAgentSessionsOptions } from '@/lib/hooks/use-agent-sessions';
import { useOrganization } from '@/lib/organization-context';
import { captureActiveSessionsQueryRefresh, fenceActiveSessionsQuery } from '@/lib/query-client';
import { useTRPC } from '@/lib/trpc';

/** Shared active query for the live-only and combined hooks. */
export function useActiveSessions(options?: UseAgentSessionsOptions) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { token, isLoading, isSigningOut, authEpoch } = useAuth();
  const { isLoaded } = useOrganization();
  const canRead =
    Boolean(token) &&
    !isLoading &&
    !isSigningOut &&
    isLoaded &&
    options?.enabled !== false &&
    !isSignOutActive();
  const input = useMemo(
    () => buildActiveSessionsTrayInput(options?.organizationId),
    [options?.organizationId]
  );
  const queryKey = useMemo(() => trpc.activeSessions.list.queryKey(input), [trpc, input]);
  const queryOptions = trpc.activeSessions.list.queryOptions(input, {
    // The floor poll is owned by `useActiveSessionsFloorPoll` in the live-sync
    // mount, scoped to the routes that show live agents; socket writes remain
    // the instant CLI path. React Query must not poll here: its fetch path
    // notifies every mounted observer on every successful fetch, which is what
    // re-rendered every live row on a timer.
    refetchInterval: false,
    staleTime: 5000,
    enabled: canRead,
  });
  const queryFn = queryOptions.queryFn;
  const active = useQuery({
    ...queryOptions,
    queryFn:
      queryFn &&
      fenceActiveSessionsQuery(queryFn, () => isCurrentAuthEpoch(authEpoch) && !isSignOutActive()),
  });
  const scope = useMemo(() => ({ queryKey, canRead, authEpoch }), [queryKey, canRead, authEpoch]);
  const currentScope = useRef<typeof scope | null>(scope);
  currentScope.current = scope;
  useEffect(() => {
    currentScope.current = scope;
    return () => {
      currentScope.current = null;
    };
  }, [scope]);

  const refetch = async (): Promise<boolean> => {
    const isCurrentScope = () =>
      canRead &&
      currentScope.current === scope &&
      isCurrentAuthEpoch(authEpoch) &&
      !isSignOutActive();
    if (!isCurrentScope()) {
      return false;
    }
    const refresh = captureActiveSessionsQueryRefresh(queryClient, queryKey);
    const handled = await refreshActiveSessionsNow(queryKey);
    if (!isCurrentScope() || !refresh.isCurrent()) {
      return false;
    }
    if (handled === false || (!handled.accepted && !handled.canceled)) {
      await active.refetch();
    }
    return (
      isCurrentScope() && (handled === false || handled.accepted) && refresh.hasAcceptedResult()
    );
  };
  return { ...active, queryKey, canRead, refetch };
}
