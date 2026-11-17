import { useRef } from 'react';

import { consumeRestoredRouteOpen } from '@/lib/last-route';

/**
 * Whether the relaunch repair opened the destination this screen renders: the
 * automatic restore marks the stored route it navigates to, and the screen
 * that reaches that destination takes the mark. A tap or a live link leaves
 * the destination unmarked, so the screen keeps its own answer for it.
 *
 * The answer is latched per destination, never per mount or per re-render. A
 * screen keeps serving its destination while another route gains focus above
 * it (a sheet, a share gate), and the navigator reuses a route instance when it
 * opens the same route name with other params — the session screen already
 * resets its own open clock and rendered guard for that case. Keying on the
 * destination answers the restore for the screen that shows it, keeps that
 * answer while another route is in front, and asks once more when the same
 * instance serves a different destination. The mark itself is one-shot, so
 * that second destination reads "not restored".
 */
export function useRestoredRouteOpen(destination: string): boolean {
  const answered = useRef<{ destination: string; restored: boolean } | null>(null);
  if (answered.current === null || answered.current.destination !== destination) {
    answered.current = { destination, restored: consumeRestoredRouteOpen(destination) };
  }
  return answered.current.restored;
}
