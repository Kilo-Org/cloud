import { useEffect, useMemo } from 'react';
import { type QueryFunction, useQueryClient } from '@tanstack/react-query';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { buildActiveSessionsInput } from '@/lib/agent-session-input';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

/**
 * React entry point for the active-sessions live-sync owner. Holds a standing
 * socket lease for the mount lifetime and recreates the per-context owner when
 * the selected personal/org context changes.
 */
function useActiveSessionsLiveSync(): void {
  const connection = useUserWebConnection();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { organizationId, isLoaded } = useOrganization();

  // The per-context owner below is recreated on every context switch, and its
  // detach()/attach() pair would drop the retain count to zero in between —
  // which stops the shared user-web socket. This lease spans the mount's whole
  // lifetime, so a context switch swaps owners without ever closing the socket,
  // and the socket still comes up before the organization context has loaded,
  // exactly as it does today. `retain()` returns its own release function.
  useEffect(() => connection.retain(), [connection]);

  const input = useMemo(() => buildActiveSessionsInput(organizationId), [organizationId]);
  const queryKey = useMemo(() => trpc.activeSessions.list.queryKey(input), [trpc, input]);
  const queryFn = useMemo(
    () =>
      trpc.activeSessions.list.queryOptions(input)
        .queryFn as QueryFunction<CachedActiveSessionsData>,
    [trpc, input]
  );

  // One owner per context: the tray cache key varies with the selected
  // personal/org context, so switching context has to retarget the WS writes. A
  // fresh instance per key is simpler than mutating a live owner's key, and
  // `attach()`'s cleanup releases the previous retain and listeners. Gated on
  // `isLoaded` so the pre-load default (personal) never claims the socket for a
  // context the user has not actually selected.
  useEffect(() => {
    if (!isLoaded) {
      return undefined;
    }
    const sync = new ActiveSessionsLiveSync({ connection, queryClient, queryKey, queryFn });
    return sync.attach();
  }, [connection, isLoaded, queryClient, queryFn, queryKey]);
}

/**
 * Component form for the layout wiring. Renders `null`.
 */
export function ActiveSessionsLiveSyncMount(): null {
  useActiveSessionsLiveSync();
  return null;
}
