import { useRef } from 'react';

import { consumeRestoredRouteOpen } from '@/lib/last-route';

/**
 * Whether the relaunch repair opened the route now on screen: the automatic
 * restore marks the stored route it navigates to, and the first screen it
 * reaches takes the mark. A tap or a live link leaves the route unmarked, so
 * the screen keeps its own answer for it.
 *
 * The answer is latched per route, not per mount. The navigator reuses a route
 * instance when it opens the same route name with other params — the session
 * screen already resets its own open clock and rendered guard for that case —
 * so a mount-only latch would keep the previous session's answer: a restored
 * open would stay "restored" for the next session the person picks, and a
 * screen mounted before the repair navigated would never see the mark at all.
 * The mark itself is one-shot, so the second route on an instance asks and
 * reads "not restored".
 */
export function useRestoredRouteOpen(pathname: string): boolean {
  const answered = useRef<{ pathname: string; restored: boolean } | null>(null);
  if (answered.current === null || answered.current.pathname !== pathname) {
    answered.current = { pathname, restored: consumeRestoredRouteOpen(pathname) };
  }
  return answered.current.restored;
}