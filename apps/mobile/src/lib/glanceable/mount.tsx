import { hashKey, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { i18n } from '@/i18n';
import {
  buildActiveSessionsTrayInput,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { useAuth } from '@/lib/auth/auth-context';
import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useOrganization } from '@/lib/organization-context';
import { useSessionAttentionRevision } from '@/lib/session-attention';
import { useTRPC } from '@/lib/trpc';

import { resolveAnsweredRaises } from './attention-rows';
import { createGlanceablePublisher } from './create-publisher';
import { getGlanceableFixtureReleases, subscribeGlanceableFixtureReleases } from './fixture-hold';
import { setGlanceableFixtureScope } from './fixture-harness';
import { getLastHomeWidgetData, subscribeHomeWidgetData } from './home-widget-data';
import {
  clearHomeWidgetRefresh,
  restoreNativeHomeWidgetData,
  syncHomeWidgetRefresh,
} from './home-widget-refresh';
import { persistGlanceableSink, restorePersistedGlanceable } from './persist';
import { type GlanceablePublisher } from './publisher';
import { registerGlanceableSink } from './sink-registry';

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
  const { token, isLoading: authLoading, restoreFailed } = useAuth();
  const { userId } = useCurrentUserId();

  const input = useMemo(() => buildActiveSessionsTrayInput(organizationId), [organizationId]);
  const queryKey = useMemo(() => trpc.activeSessions.list.queryKey(input), [trpc, input]);
  const targetHash = useMemo(() => hashKey(queryKey), [queryKey]);

  // Answering a raise from the needs-input notification writes an ack that the
  // in-app list reads; the counts below must drop it too, so re-derive on every
  // ack revision instead of only on tray events.
  const attentionRevision = useSessionAttentionRevision();

  const signedIn = token != null;

  // Dev-only: a released fixture hold rebuilds the publisher below, seeded from
  // the persisted fixture snapshot, so its first live write supersedes the
  // fixture on every surface. Never changes in a release build.
  const fixtureReleases = useSyncExternalStore(
    subscribeGlanceableFixtureReleases,
    getGlanceableFixtureReleases
  );

  // The publisher of the current signed-in context, so an ack revision can
  // re-derive without rebuilding it (a rebuild would reset its activity state).
  const live = useRef<{
    publisher: GlanceablePublisher;
    ctx: { userId: string; organizationId: string | null };
  } | null>(null);

  // Populate the persisted last snapshot once so cleanup/org-fence can see it,
  // and so the publisher below seeds its revision from the persisted value.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const restore = async (): Promise<void> => {
      await restorePersistedGlanceable();
      await restoreNativeHomeWidgetData();
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

    const publisher = createGlanceablePublisher();
    const ctx = { userId, organizationId };
    live.current = { publisher, ctx };
    if (__DEV__) {
      setGlanceableFixtureScope(ctx);
    }
    const derive = (sessions: CachedActiveSessionsData['sessions'], checkedAt: number) => {
      publisher.handleSessions(resolveAnsweredRaises(sessions), ctx, checkedAt);
    };

    // Initial state: derive from the existing cache, or mark waiting while the
    // first fetch is in flight.
    const state = queryClient.getQueryState(queryKey);
    const data = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
    if (data !== undefined && state !== undefined) {
      derive(data.sessions, state.dataUpdatedAt);
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
          derive(next.sessions, event.query.state.dataUpdatedAt);
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
      live.current = null;
      if (__DEV__) {
        setGlanceableFixtureScope(null);
      }
    };
  }, [
    queryClient,
    queryKey,
    targetHash,
    isLoaded,
    signedIn,
    userId,
    organizationId,
    restored,
    fixtureReleases,
  ]);

  useEffect(() => {
    const current = live.current;
    if (current === null) {
      return;
    }
    const data = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
    if (data !== undefined) {
      current.publisher.handleSessions(
        resolveAnsweredRaises(data.sessions),
        current.ctx,
        queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0
      );
    }
  }, [attentionRevision, queryClient, queryKey]);

  useEffect(() => {
    if (!restored || !isLoaded || authLoading || restoreFailed) {
      return undefined;
    }
    if (!signedIn || userId === undefined) {
      void clearHomeWidgetRefresh();
      return undefined;
    }
    const context = { userId, organizationId };
    const sync = () => {
      const data = getLastHomeWidgetData();
      if (
        data !== null &&
        data.snapshot.status !== 'signed_out' &&
        data.snapshot.status !== 'privacy'
      ) {
        void syncHomeWidgetRefresh(context);
      }
    };
    const unsubscribe = subscribeHomeWidgetData(sync);
    i18n.on('languageChanged', sync);
    sync();
    return () => {
      unsubscribe();
      i18n.off('languageChanged', sync);
    };
  }, [
    restored,
    isLoaded,
    authLoading,
    restoreFailed,
    signedIn,
    token,
    userId,
    organizationId,
    fixtureReleases,
  ]);

  return null;
}
