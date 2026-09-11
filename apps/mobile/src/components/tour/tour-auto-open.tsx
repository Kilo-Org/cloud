import { type Href, usePathname, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useCurrentUserId } from '@/lib/hooks/use-current-user-id';
import { useTourCompletion } from '@/lib/tour/tour-completion';

const TOUR_ROUTE = '/(app)/tour';

/** The tour pathname as expo-router reports it, with and without its group. */
const TOUR_PATHNAMES = new Set<string>([TOUR_ROUTE, '/tour']);

/**
 * Auto-opens the first-sign-in tour exactly once per account.
 *
 * Fires only when a user id is present, the stored decision has loaded, the
 * account has not already finished or skipped the tour, and the tour route is
 * not already on screen. A ref keyed by user id makes the push once-only for
 * that account, so later renders (and later sign-ins of the same account)
 * never re-open it — the persisted decision reinforces that for a fresh mount.
 * Returns null; it is mounted in the `(app)` layout beside the other mounts.
 */
export function TourAutoOpen() {
  const router = useRouter();
  const pathname = usePathname();
  const { userId } = useCurrentUserId();
  const { isLoaded, isCompleted } = useTourCompletion(userId);
  const openedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId || !isLoaded || isCompleted) {
      return;
    }
    // Already opened for this account, or the tour is on screen (an explicit
    // Profile open): mark it opened so we never push behind the person later.
    if (openedForRef.current === userId) {
      return;
    }
    openedForRef.current = userId;
    if (TOUR_PATHNAMES.has(pathname)) {
      return;
    }
    router.push(TOUR_ROUTE as Href);
  }, [userId, isLoaded, isCompleted, pathname, router]);

  return null;
}
