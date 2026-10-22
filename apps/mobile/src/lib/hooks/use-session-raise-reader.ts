import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import {
  buildActiveSessionsTrayInput,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

/** The raise a live session row is waiting on, as the tray cache holds it. */
export type ObservedSessionRaise = {
  status: string;
  statusUpdatedAt?: string;
};

/**
 * Read the raise the tray last observed for a session, at call time.
 *
 * The answer paths know which request they answered but not when its raise was
 * created; the raise id is `statusUpdatedAt ?? status` of the row, and the row
 * the app has observed lives in the `activeSessions.list` cache the tab layout,
 * the list rows and the live-sync owner all write. This reads that cache once
 * per ack — no fetch, no subscription — so an ack can name the exact raise the
 * user answered instead of degrading to its status.
 *
 * Returns null when the session is not in the cache (an offline or already
 * finished session), and the caller then acks with the status alone.
 */
export function useSessionRaiseReader(): (sessionId: string) => ObservedSessionRaise | null {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationId } = useOrganization();
  const queryKey = useMemo(
    () => trpc.activeSessions.list.queryKey(buildActiveSessionsTrayInput(organizationId)),
    [trpc, organizationId]
  );
  return useCallback(
    (sessionId: string): ObservedSessionRaise | null => {
      const data = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
      const row = data?.sessions.find(session => session.id === sessionId);
      if (row === undefined) {
        return null;
      }
      return { status: row.status, statusUpdatedAt: row.statusUpdatedAt };
    },
    [queryClient, queryKey]
  );
}
