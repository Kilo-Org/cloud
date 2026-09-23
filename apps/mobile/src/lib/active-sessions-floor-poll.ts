/**
 * The `activeSessions.list` floor poll, owned outside React Query's fetch path.
 *
 * React Query notifies every observer on every successful fetch, and the live
 * row consumers read `isFetching`/`isPaused`, so `notifyOnChangeProps` cannot
 * suppress the re-render. This hook instead calls the (fenced) query function
 * directly, compares the payload field-by-field, and writes the cache only when
 * it changed: an unchanged poll notifies no subscriber, and a manual cache
 * write never bumps the accepted-revision metadata the pull-to-refresh path
 * owns.
 *
 * The poll is armed by the live-sync mount — one owner for the whole app — and
 * only while a surface that shows live agents is focused.
 */

import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { type QueryClient, type QueryFunction, type QueryKey } from '@tanstack/react-query';

import {
  type CachedActiveSession,
  type CachedActiveSessionsData,
} from '@/lib/active-sessions-live';
import { useAuth } from '@/lib/auth/auth-context';
import { isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { fenceActiveSessionsQuery } from '@/lib/query-client';

/** The interval the repo shipped before the poll moved out of React Query. */
const CONNECTED_FLOOR_POLL_MS = 30_000;
const DISCONNECTED_FLOOR_POLL_MS = 10_000;

/**
 * Route segments that render live agent rows. `useSegments()` reports the
 * expo-router group segments, the same shape `screen-tracking-decision.ts`
 * matches. Each entry names the consumers behind it:
 *
 * - `(0_home)`: home-screen.tsx renders the Active now tray.
 * - `(2_agents)`: session-list-screen.tsx and use-agent-session-list-data.ts
 *   render and derive the Agents list.
 * - `share-gate`: share-gate-sheet.tsx shows the same live rows for sharing.
 *
 * `(1_kiloclaw)` and the quick-chat tab consume nothing from this query and are
 * deliberately absent.
 */
export const LIVE_AGENTS_SURFACE_SEGMENTS: readonly string[] = [
  '(0_home)',
  '(2_agents)',
  'share-gate',
];

/** True while any focused route segment belongs to a live-agents surface. */
export function isLiveAgentsSurfaceSegments(segments: readonly string[]): boolean {
  return segments.some(segment => LIVE_AGENTS_SURFACE_SEGMENTS.includes(segment));
}

/**
 * Scalar fields compared with `Object.is`; the payload differs when any of them
 * differs. `capabilities` and `associatedPr` are the nested objects and are
 * compared field-by-field one level deep.
 */
const ACTIVE_SESSION_SCALAR_FIELDS = [
  'id',
  'status',
  'title',
  'connectionId',
  'gitUrl',
  'gitBranch',
  'createdOnPlatform',
  'createdAt',
  'updatedAt',
  'lastActivityAt',
  'statusUpdatedAt',
  'platform',
  'totalCostMicrodollars',
  'organizationId',
] as const;

function areCapabilitiesEqual(
  current: CachedActiveSession['capabilities'],
  next: CachedActiveSession['capabilities']
): boolean {
  if (current === next) {
    return true;
  }
  if (current === undefined || next === undefined) {
    return false;
  }
  return Object.is(current.attachments, next.attachments);
}

function areAssociatedPrEqual(
  current: CachedActiveSession['associatedPr'],
  next: CachedActiveSession['associatedPr']
): boolean {
  if (current === next) {
    return true;
  }
  if (current === undefined || next === undefined) {
    return false;
  }
  return (
    Object.is(current.url, next.url) &&
    Object.is(current.number, next.number) &&
    Object.is(current.state, next.state) &&
    Object.is(current.title, next.title) &&
    Object.is(current.headSha, next.headSha) &&
    Object.is(current.lastSyncedAt, next.lastSyncedAt) &&
    Object.is(current.reviewDecision, next.reviewDecision) &&
    Object.is(current.reviewDecisionPending, next.reviewDecisionPending) &&
    Object.is(current.platform, next.platform)
  );
}

function areActiveSessionsEqual(current: CachedActiveSession, next: CachedActiveSession): boolean {
  if (current === next) {
    return true;
  }
  for (const field of ACTIVE_SESSION_SCALAR_FIELDS) {
    if (!Object.is(current[field], next[field])) {
      return false;
    }
  }
  return (
    areCapabilitiesEqual(current.capabilities, next.capabilities) &&
    areAssociatedPrEqual(current.associatedPr, next.associatedPr)
  );
}

/**
 * Field-by-field equality of two `activeSessions.list` payloads, same length
 * and same order. Key order must never decide equality, so this never
 * serializes to JSON.
 */
export function areActiveSessionsPayloadsEqual(
  current: CachedActiveSessionsData,
  next: CachedActiveSessionsData
): boolean {
  if (current === next) {
    return true;
  }
  const currentSessions = current.sessions;
  const nextSessions = next.sessions;
  if (currentSessions === nextSessions) {
    return true;
  }
  if (currentSessions.length !== nextSessions.length) {
    return false;
  }
  for (let index = 0; index < currentSessions.length; index += 1) {
    const currentSession = currentSessions[index];
    const nextSession = nextSessions[index];
    if (currentSession === undefined || nextSession === undefined) {
      return false;
    }
    if (!areActiveSessionsEqual(currentSession, nextSession)) {
      return false;
    }
  }
  return true;
}

type UseActiveSessionsFloorPollOptions = {
  /** The same read gate `useActiveSessions` uses (signed in, context loaded). */
  enabled: boolean;
  /** True while a route that shows live agents is focused. */
  visible: boolean;
  /** True while the live socket transport is ready. */
  connected: boolean;
  queryClient: QueryClient;
  queryKey: QueryKey;
  queryFn: QueryFunction<CachedActiveSessionsData>;
};

/**
 * Owns the `activeSessions.list` floor poll for the app. The interval is armed
 * only while `enabled && visible` and re-arms when `connected` flips (30s
 * connected, 10s offline, the intervals the query shipped). A tick is skipped
 * while the app is not foregrounded, while a tick is already in flight, or
 * before the first payload is in the cache (nothing to compare against, and an
 * empty cache belongs to the initial fetch, not this poll).
 */
export function useActiveSessionsFloorPoll({
  enabled,
  visible,
  connected,
  queryClient,
  queryKey,
  queryFn,
}: UseActiveSessionsFloorPollOptions): void {
  const { authEpoch } = useAuth();
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !visible) {
      return undefined;
    }
    const controller = new AbortController();
    const tick = async (): Promise<void> => {
      if (AppState.currentState !== 'active' || inFlight.current) {
        return;
      }
      if (queryClient.getQueryData(queryKey) === undefined) {
        return;
      }
      inFlight.current = true;
      try {
        const fetch = fenceActiveSessionsQuery(
          queryFn,
          () => isCurrentAuthEpoch(authEpoch) && !isSignOutActive()
        );
        const next = await fetch({
          client: queryClient,
          queryKey,
          signal: controller.signal,
          meta: undefined,
        });
        const current = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
        if (current === undefined || areActiveSessionsPayloadsEqual(current, next)) {
          return;
        }
        queryClient.setQueryData(queryKey, next);
      } catch (error) {
        // The floor poll must never blank or error a list it did not fetch:
        // the initial fetch and the pull-to-refresh path own those states.
        if (__DEV__) {
          // eslint-disable-next-line no-console -- dev-only visibility for a swallowed poll failure
          console.warn('[active-sessions] floor poll failed', error);
        }
      } finally {
        inFlight.current = false;
      }
    };
    const interval = setInterval(
      () => {
        void tick();
      },
      connected ? CONNECTED_FLOOR_POLL_MS : DISCONNECTED_FLOOR_POLL_MS
    );
    return () => {
      clearInterval(interval);
    };
  }, [authEpoch, connected, enabled, queryClient, queryFn, queryKey, visible]);
}
