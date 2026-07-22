import { useEffect, useMemo, useRef } from 'react';
import { type QueryFunction, useQueryClient } from '@tanstack/react-query';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import { type CachedActiveSessionsData } from '@/lib/active-sessions-live';
import { useTRPC } from '@/lib/trpc';

/**
 * React entry point for the active-sessions live-sync owner. Mounts an
 * `ActiveSessionsLiveSync` instance exactly once per provider lifetime.
 */
function useActiveSessionsLiveSync(): void {
  const connection = useUserWebConnection();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const queryKey = useMemo(() => trpc.activeSessions.list.queryKey(), [trpc]);
  // `trpc.activeSessions.list.queryOptions()` returns a fresh object on
  // every call; we want a stable queryFn per provider lifetime so the
  // live-sync owner can call it via fetchQuery.
  const queryFn = useMemo(
    () =>
      trpc.activeSessions.list.queryOptions().queryFn as QueryFunction<CachedActiveSessionsData>,
    [trpc]
  );

  const syncRef = useRef<ActiveSessionsLiveSync | null>(null);
  syncRef.current ??= new ActiveSessionsLiveSync({
    connection,
    queryClient,
    queryKey,
    queryFn,
  });

  useEffect(() => {
    const sync = syncRef.current;
    return sync ? sync.attach() : undefined;
  }, []);
}

/**
 * Component form for the layout wiring. Renders `null`.
 */
export function ActiveSessionsLiveSyncMount(): null {
  useActiveSessionsLiveSync();
  return null;
}
