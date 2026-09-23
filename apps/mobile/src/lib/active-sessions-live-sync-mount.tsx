import { useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import { hashKey, type QueryFunction, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useSegments } from 'expo-router';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import {
  isLiveAgentsSurfaceSegments,
  useActiveSessionsFloorPoll,
} from '@/lib/active-sessions-floor-poll';
import { ActiveSessionsLiveSync } from '@/lib/active-sessions-live-sync';
import {
  buildActiveSessionsTrayInput,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { useAuth } from '@/lib/auth/auth-context';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { readAgentPushPreferenceIfLoaded } from '@/lib/hooks/agent-push-preference';
import { useUserWebConnectionState } from '@/lib/hooks/use-user-web-connection-state';
import {
  applyNeedsInputNotifications,
  type NeedsInputNotificationRow,
  notificationIdentifierForSession,
  planNeedsInputNotifications,
  reconcileNotifiedAfterApply,
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
  const segments = useSegments();
  const connected = useUserWebConnectionState();
  // The floor poll owns `activeSessions.list` refresh, and only while a route
  // that shows live agents is focused; the query no longer polls on its own.
  useActiveSessionsFloorPoll({
    enabled,
    visible: isLiveAgentsSurfaceSegments(segments),
    connected,
    queryClient,
    queryKey,
    queryFn,
  });
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
 *
 * The user's `agentAttention` preference is read from the cache the
 * Notifications screen edits and is a plan input, so the app-owned carrier
 * alerts exactly when the server's attention push would. The mount subscribes
 * to that query itself, because the Notifications screen may never be visited:
 * without the subscription the cache would stay empty after every restart and
 * the gate would have nothing to read. Until the row loads the plan withholds
 * the post, so the gate never falls back to ON for a user who turned the
 * category off.
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
  const preferencesQueryKey = useMemo(
    () => trpc.user.getNotificationPreferences.queryOptions().queryKey,
    [trpc]
  );
  const preferencesQueryHash = useMemo(() => hashKey(preferencesQueryKey), [preferencesQueryKey]);
  const enabled = Boolean(token) && !isLoading && !isSigningOut && isLoaded;

  // Subscribe/prefetch the preferences row at app start. The plan reads the
  // cache and the query-cache subscription below re-plans when the value lands,
  // so a cold start gates on the server row instead of an empty cache.
  useQuery({
    ...trpc.user.getNotificationPreferences.queryOptions(),
    enabled,
  });

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
    const previous = notified.current;
    const plan = planNeedsInputNotifications({
      previous,
      next,
      pathname: pathnameRef.current,
      appState: AppState.currentState,
      attentionEnabled: readAgentPushPreferenceIfLoaded(
        queryClient,
        preferencesQueryKey,
        'agentAttention'
      ),
    });
    const dismissed = new Set(plan.dismiss);
    // A re-published row REPLACES its previous entry instead of joining it. An
    // append would leave the stale row first in the set, so the next plan's
    // `find` would compare the raise against the shape it had before the
    // re-publish, publish again on every recompute, and grow the set without
    // bound.
    const republished = new Set(plan.publish.map(row => row.sessionId));
    // The rows this plan removes from the memory: a dismissed identifier and
    // the previous entry a re-publish replaces. Kept so a native failure can
    // restore them below.
    const dropped = previous.filter(
      row =>
        dismissed.has(notificationIdentifierForSession(row.sessionId)) ||
        republished.has(row.sessionId)
    );
    // Commit optimistically so an immediate re-plan does not re-post a raise
    // that is already on its way. The applier reports and swallows every native
    // failure; `reconcileNotifiedAfterApply` undoes the operations that never
    // landed, so the next recompute retries them instead of treating a failed
    // post as posted or a failed dismissal as cleared.
    notified.current = [...previous.filter(row => !dropped.includes(row)), ...plan.publish];
    const applyAndCorrect = async (): Promise<void> => {
      const result = await applyNeedsInputNotifications(plan);
      notified.current = reconcileNotifiedAfterApply(notified.current, {
        plan,
        dropped,
        result,
      });
    };
    void applyAndCorrect();
  }, [queryClient, queryKey, preferencesQueryKey]);

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
      // A rows change re-plans from scratch; a preference change re-plans so
      // turning `agentAttention` off dismisses a raise already on screen.
      if (event.query.queryHash === queryHash || event.query.queryHash === preferencesQueryHash) {
        recompute();
      }
    });
  }, [enabled, queryClient, queryHash, preferencesQueryHash, recompute]);

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
