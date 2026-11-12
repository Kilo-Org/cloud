import { useRef } from 'react';

import { consumeRestoredRouteOpen } from '@/lib/last-route';

/**
 * Whether the relaunch repair opened this route: the automatic restore marks
 * the stored route it navigates to, and the first screen it reaches takes the
 * mark. A tap or a live link leaves the route unmarked, so the screen keeps its
 * own answer for it.
 *
 * The mark is taken once per mount, before the screen knows how its read
 * settles; a later render of the same route must not read the mark again, or a
 * state that arrives after the first frame would lose it.
 */
export function useRestoredRouteOpen(pathname: string): boolean {
  const marked = useRef<boolean | null>(null);
  marked.current ??= consumeRestoredRouteOpen(pathname);
  return marked.current;
}
