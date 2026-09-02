import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  buildActiveSessionsTrayInput,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { useAuth } from '@/lib/auth/auth-context';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

import {
  getLastGlanceableSnapshot,
  persistGlanceableSink,
  restorePersistedGlanceable,
} from './persist';
import { getTerminalBlankEpoch } from './cleanup';
import { GlanceablePublisher } from './publisher';
import { getGlanceableSinks, registerGlanceableSink } from './sink-registry';

// Register only the persist sink here; platform sinks register themselves from
// files their slices own.
registerGlanceableSink(persistGlanceableSink);

/**
 * React entry point for the glanceable publisher. Subscribes to the
 * `activeSessions.list` tray cache (the same key the live-sync owner writes)
 * and derives snapshots without fetching. A fresh publisher per signed-in
 * context, mirroring `ActiveSessionsLiveSyncMount`.
 */
export function GlanceablePublisherMount(): null {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { organizationId, isLoaded } = useOrganization();
  const { token } = useAuth();
  const { userId } = useCurrentUserId();

  const input = useMemo(() => buildActiveSessionsTrayInput(organizationId), [organizationId]);
  const queryKey = useMemo(() => trpc.activeSessions.list.queryKey(input), [trpc, input]);
  const targetHash = useMemo(() => hashKey(queryKey), [queryKey]);

  const signedIn = token != null;

  // Populate the persisted last snapshot once so cleanup/org-fence can see it,
  // and so the publisher below seeds its revision from the persisted value.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const restore = async (): Promise<void> => {
      await restorePersistedGlanceable();
      if (!cancelled) {
        setRestored(true);
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isLoaded || !signedIn || userId === undefined || !restored) {
      return undefined;
    }

    const publisher = new GlanceablePublisher({
      sinks: getGlanceableSinks(),
      initial: getLastGlanceableSnapshot(),
      terminalBlankEpoch: getTerminalBlankEpoch,
    });
    const ctx = { userId, organizationId };

    // Initial state: derive from the existing cache, or mark waiting while the
    // first fetch is in flight.
    const state = queryClient.getQueryState(queryKey);
    const data = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
    if (data !== undefined) {
      publisher.handleSessions(data.sessions, ctx);
    } else if (state?.fetchStatus === 'fetching') {
      publisher.handleFetchStarted(ctx);
    }

    const unsubscribe = queryClient.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || event.query.queryHash !== targetHash) {
        return;
      }
      if (event.action.type === 'success') {
        const next = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
        if (next !== undefined) {
          publisher.handleSessions(next.sessions, ctx);
        }
      } else if (event.action.type === 'error') {
        publisher.handleFetchError(ctx);
      } else if (event.action.type === 'fetch') {
        publisher.handleFetchStarted(ctx);
      }
    });

    return () => {
      unsubscribe();
      publisher.dispose();
    };
  }, [queryClient, queryKey, targetHash, isLoaded, signedIn, userId, organizationId, restored]);

  return null;
}
