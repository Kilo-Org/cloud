import { usePathname, useSegments } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  getLastRouteHydrationVersion,
  isLastRouteHydrated,
  recordLastRoute,
  subscribeLastRoute,
} from '@/lib/last-route';
import { isRecordableLastRoute } from '@/lib/last-route-recordable';

type RecordLastRouteInput = {
  /** The account the record belongs to; null records nothing. */
  readonly userId: string | undefined;
};

/**
 * The href a `router.navigate` call resolves: the group segments
 * (`(app)`, `(tabs)`, …) are part of the route href even though `usePathname()`
 * reports the concrete path without them (`/profiles`). The segment list is
 * also the full route path — non-group segments carry the concrete values of
 * dynamic routes (`p1`, `ses_1`) — so the href is the segments joined.
 */
function lastRouteHrefFrom(segments: readonly string[]): string {
  const grouped = segments.filter(part => part.length > 0);
  return `/${grouped.join('/')}`;
}

/**
 * Record the focused in-app route on every navigation-state commit, so a
 * process death restores the screen the person actually had on screen instead
 * of the base Intent's stale deep link (see `lib/last-route.ts`).
 *
 * Recording waits for the store's restart read to settle: on a cold start the
 * OS has already restored the base Intent's route (possibly a stale deep
 * link), and the relaunch repair must read the persisted record before the
 * first commit of this process can overwrite it. The hydration version is
 * subscribed so the effect re-runs on the read's completion.
 *
 * The path and segments are read through hooks here rather than the
 * navigation-state events: `usePathname()` already re-renders this layout on
 * every commit, so an extra `state` listener would only duplicate the source.
 * Recording is synchronous and best-effort; a failed mirror write is reported
 * inside the store, never thrown into the layout.
 */
export function useRecordLastRoute({ userId }: RecordLastRouteInput): void {
  const pathname = usePathname();
  const segments = useSegments();
  const lastRecorded = useRef<string | null>(null);
  // Subscribed so this component re-renders when the restart read settles; the
  // version is a dependency of the effect below, which otherwise never re-runs
  // after hydration.
  const hydrationVersion = useSyncExternalStore(subscribeLastRoute, getLastRouteHydrationVersion);

  useEffect(() => {
    if (!isLastRouteHydrated()) {
      return;
    }
    if (userId === undefined || !isRecordableLastRoute(pathname, segments)) {
      return;
    }
    const href = lastRouteHrefFrom(segments);
    if (lastRecorded.current === href) {
      return;
    }
    // Advance the ref only when the store accepted the write. Before the
    // relaunch repair consumes the restored record the store drops writes, so
    // advancing here would mark the process's first real route as recorded
    // without anything persisted, and the route the person actually focused
    // would never reach the mirror.
    if (!recordLastRoute(href, userId)) {
      return;
    }
    lastRecorded.current = href;
  }, [pathname, segments, userId, hydrationVersion]);
}
