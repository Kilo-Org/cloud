import { usePathname, useSegments, useUnstableGlobalHref } from 'expo-router';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  getLastRouteHydrationVersion,
  isLastRouteHydrated,
  recordLastRoute,
  subscribeLastRoute,
} from '@/lib/last-route';
import { isRecordableLastRoute, lastRouteHrefFrom } from '@/lib/last-route-recordable';

type RecordLastRouteInput = {
  /** The account the record belongs to; null records nothing. */
  readonly userId: string | undefined;
};

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
 * The href is read through hooks here rather than the navigation-state events:
 * the global-href hook already re-renders this layout on every commit, so an
 * extra `state` listener would only duplicate the source. Recording is
 * synchronous and best-effort; a failed mirror write is reported inside the
 * store, never thrown into the layout.
 */
export function useRecordLastRoute({ userId }: RecordLastRouteInput): void {
  const pathname = usePathname();
  const segments = useSegments();
  const globalHref = useUnstableGlobalHref();
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
    const href = lastRouteHrefFrom(globalHref, pathname, segments);
    if (href === null || lastRecorded.current === href) {
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
  }, [pathname, segments, globalHref, userId, hydrationVersion]);
}
