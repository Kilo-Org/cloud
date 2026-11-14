import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useRouteFocused } from '@/lib/navigation/route-focus';
import { type ProfileManagementStack } from '@/lib/profile-agent-navigation';

/**
 * Leave a Profile tab route whose profile went away after the screen painted
 * it, and leave every other refusal where it is.
 *
 * The Profile tab keeps its stack across tab switches, so a route that showed a
 * working profile and later reads a terminal refusal has nothing to show and
 * nothing to press: the tab stays on an empty screen until the reader finds
 * Back. This returns the tab to the first screen of its own stack, the tab's
 * Profile root, where the list behind the dead row is one tap away.
 *
 * The rule is "rendered, then refused", not "the read holds a profile" and not a
 * timing or focus heuristic. A route opened with a cached profile the server
 * refuses on the first answer never painted that profile, so the reader still
 * has to see why the screen is empty and leave with Back; only a person who
 * read the profile and came back to it gone is stranded. Focus is part of the
 * decision: an off-screen tab must not navigate itself.
 */
export function useLeaveMissingProfileRoute(
  contentShown: boolean,
  terminalRefusal: boolean,
  stack: ProfileManagementStack
): void {
  const router = useRouter();
  const routeFocused = useRouteFocused();
  // Whether this instance ever painted the profile. A ref, because the answer
  // must survive the render that replaces the content with the refusal.
  const painted = useRef(false);
  useEffect(() => {
    if (contentShown) {
      painted.current = true;
    }
  }, [contentShown]);

  useEffect(() => {
    // The root `(app)` stack keeps the terminal view: its profile route has no
    // tab stack to return to, so its Back is the whole way out.
    if (!terminalRefusal || !painted.current || !routeFocused || stack !== 'profileTab') {
      return;
    }
    router.dismissAll();
  }, [routeFocused, router, stack, terminalRefusal]);
}
