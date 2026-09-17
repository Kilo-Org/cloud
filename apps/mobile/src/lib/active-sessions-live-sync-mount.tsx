import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { hashKey, type QueryFunction, useQueryClient } from '@tanstack/react-query';
import { usePathname } from 'expo-router';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import {
  buildActiveSessionsTrayInput,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { useAuth } from '@/lib/auth/auth-context';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import {
  applyNeedsInputNotifications,
  type NeedsInputNotificationRow,
  notificationIdentifierForSession,
  planNeedsInputNotifications,
} from '@/lib/needs-input-notification';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

/** Holds the socket lease across personal/organization context changes. */
function useActiveSessionsLiveSync(): void {
  const connection = useUserWebConnection();
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { organizationId, isLoaded } = useOrganization();
  const { token, isLoading, isSigningOut, authEpoch } = useAuth();
  const enabled = Boolean(token) && !isLoading && !isSigningOut && isLoaded;

  // Each per-context owner also owns and releases its own lease.
  useEffect(() => {
    if (enabled && !isSignOutActive()) {
      return connection.retain();
    }
    return undefined;
  }, [connection, enabled, authEpoch]);

  const input = useMemo(() => buildActiveSessionsTrayInput(organizationId), [organizationId]);
  const queryKey = useMemo(() => trpc.activeSessions.list.queryKey(input), [trpc, input]);
  const queryFn = useMemo(
    () =>
      trpc.activeSessions.list.queryOptions(input)
        .queryFn as QueryFunction<CachedActiveSessionsData>,
    [trpc, input]
  );
  // An unresolved selection must never attach the default personal context.
  useEffect(() => {
    if (!enabled || isSignOutActive()) {
      return undefined;
    }
    const sync = new ActiveSessionsLiveSync({ connection, queryClient, queryKey, queryFn });
    const detach = sync.attach();
    // One refresh per foreground transition. `change` fires on the transition
    // only, so this rides an existing wakeup instead of adding a poll.
    const appStateSubscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' && !isSignOutActive()) {
        sync.scheduleRefresh('foreground');
      }
    });
    return () => {
      appStateSubscription.remove();
      detach();
    };
  }, [connection, enabled, authEpoch, queryClient, queryFn, queryKey]);
}

/**
 * Posts (and dismisses) the app-owned needs-input notification from the cached
 * live rows. The rows are the same cache the Agents tab renders, so one
 * subscription covers socket writes and refetches; the rows whose notification
 * is currently posted are the `previous` the next plan diffs against, which is
 * what keeps a re-plan from re-posting a notification that is already on
 * screen and a cleared raise from leaving a stale one behind.
 */
function useNeedsInputLocalNotifications(): void {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const { organizationId, isLoaded } = useOrganization();
  const { token, isLoading, isSigningOut } = useAuth();
  const pathname = usePathname();
  const input = useMemo(() => buildActiveSessionsTrayInput(organizationId), [organizationId]);
  const queryKey = useMemo(() => trpc.activeSessions.list.queryKey(input), [trpc, input]);
  const queryHash = useMemo(() => hashKey(queryKey), [queryKey]);
  const enabled = Boolean(token) && !isLoading && !isSigningOut && isLoaded;

  // The route is read through a ref so a route change re-plans without
  // re-subscribing to the query cache.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // The full notified set, not the last plan's delta: a plan that publishes
  // nothing (an unchanged raise, a withheld post) would otherwise erase the
  // memory, re-alert on the next recompute, and leave a cleared raise with
  // nothing to dismiss.
  const notified = useRef<NeedsInputNotificationRow[]>([]);

  const recompute = useCallback(() => {
    const next = queryClient.getQueryData<CachedActiveSessionsData>(queryKey)?.sessions ?? [];
    const plan = planNeedsInputNotifications({
      previous: notified.current,
      next,
      pathname: pathnameRef.current,
      appState: AppState.currentState,
    });
    const dismissed = new Set(plan.dismiss);
    notified.current = [
      ...notified.current.filter(
        row => !dismissed.has(notificationIdentifierForSession(row.sessionId))
      ),
      ...plan.publish,
    ];
    // The applier reports and swallows every native failure; it never rejects.
    void applyNeedsInputNotifications(plan);
  }, [queryClient, queryKey]);

  useEffect(() => {
    if (!enabled || isSignOutActive()) {
      // A sign-out clears the cache without a rows change, so the dismissal
      // must ride the gate flipping rather than a subscription event.
      if (isSignOutActive()) {
        recompute();
      }
      return undefined;
    }
    recompute();
    return queryClient.getQueryCache().subscribe(event => {
      if (event.query.queryHash === queryHash) {
        recompute();
      }
    });
  }, [enabled, queryClient, queryHash, recompute]);

  // The route is a plan input, not only a subscription trigger: leaving a
  // waiting session's chat is what turns its raise back into a notification,
  // even though the rows themselves did not change.
  useEffect(() => {
    if (enabled) {
      recompute();
    }
  }, [enabled, pathname, recompute]);
}

export function ActiveSessionsLiveSyncMount(): null {
  useActiveSessionsLiveSync();
  useNeedsInputLocalNotifications();
  return null;
}
