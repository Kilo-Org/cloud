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
 * Route segments that render live agent rows, or that render a control derived
 * from them. `useSegments()` reports the expo-router group segments, the same
 * shape `screen-tracking-decision.ts` matches.
 *
 * Every tabs segment is here: the tab layout renders the Agents tab badge from
 * the same cache on every tab (`_layout.tsx`), so Profile, KiloClaw and the
 * quick-chat tab show the needs-input count too. Polling only the two row
 * screens left that badge stale on the other tabs until a foreground, push or
 * socket refresh happened to land.
 *
 * - `(0_home)`: home-screen.tsx renders the Active now tray.
 * - `(2_agents)`: session-list-screen.tsx and use-agent-session-list-data.ts
 *   render and derive the Agents list and its badge.
 * - `(1_kiloclaw)`, `(3_profile)`, `(4_chat)`: the tab bar's Agents badge.
 * - `share-gate`: share-gate-sheet.tsx shows the same live rows for sharing.
 *
 * Session, chat-detail and pr-review routes are deliberately absent: the tab
 * bar is not on screen there and nothing renders the list, so the poll stays
 * off while the user is inside one session — the work is scoped to what is
 * visible.
 */
export const LIVE_AGENTS_SURFACE_SEGMENTS: readonly string[] = [
  '(0_home)',
  '(1_kiloclaw)',
  '(2_agents)',
  '(3_profile)',
  '(4_chat)',
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
      // The payload this tick compares against, captured before the fetch.
      // `next` is a snapshot taken when the request started, so any write that
      // lands while it is in flight (a socket write, a pull-to-refresh, another
      // mount) has already replaced this reference with a newer payload.
      const before = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
      if (before === undefined) {
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
        // The effect was re-armed or unmounted while this request ran; the
        // interval it belonged to is gone, so the tick must not write.
        if (controller.signal.aborted) {
          return;
        }
        // A cache write during the flight means `before` is stale: the compare
        // below proves only that the two payloads differ, not which is newer,
        // so the poll yields to the writer instead of overwriting it with its
        // older snapshot. The next tick compares against the new payload.
        const current = queryClient.getQueryData<CachedActiveSessionsData>(queryKey);
        if (current === undefined || current !== before) {
          return;
        }
        if (areActiveSessionsPayloadsEqual(before, next)) {
          return;
        }
        queryClient.setQueryData(queryKey, next);
      } catch (error) {
        // The floor poll must never blank or error a list it did not fetch:
        // the initial fetch and the pull-to-refresh path own those states. An
        // abort is this hook's own cleanup, not a failure worth reporting.
        if (__DEV__ && !controller.signal.aborted) {
          // eslint-disable-next-line no-console -- dev-only visibility for a swallowed poll failure
          console.warn('[active-sessions] floor poll failed', error);
        }
      } finally {
        // A tick whose controller was aborted must not clear the flag: cleanup
        // already cleared it for the interval that replaced this one.
        if (!controller.signal.aborted) {
          inFlight.current = false;
        }
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
      // Stop the in-flight request as well as future ticks: an aborted fetch
      // cannot resolve into a write after the app left the live surface, and
      // clearing the flag lets the interval armed by the next effect tick
      // immediately instead of waiting for the stale request to settle.
      controller.abort();
      inFlight.current = false;
    };
  }, [authEpoch, connected, enabled, queryClient, queryFn, queryKey, visible]);
}
