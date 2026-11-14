import { useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';

import { useRouteFocused } from '@/lib/navigation/route-focus';
import { type ProfileManagementStack } from '@/lib/profile-agent-navigation';

/** What the caller's render says about the profile route it serves. */
type MissingProfileLeave = {
  contentShown: boolean;
  terminalRefusal: boolean;
  stack: ProfileManagementStack;
};

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
 * read the profile and came back to it gone is stranded.
 *
 * The marker is per destination, the way `useRestoredRouteOpen` answers per
 * destination: the navigator reuses a route instance when it opens the same
 * route name with other params, and such an instance has painted nothing of the
 * profile it now serves. A first-answer refusal for that profile must keep its
 * terminal view, so the marker drops as soon as the served id changes.
 *
 * Focus is part of the decision: an off-screen tab must not navigate itself.
 */
export function useLeaveMissingProfileRoute(
  profileId: string,
  { contentShown, terminalRefusal, stack }: MissingProfileLeave
): void {
  const router = useRouter();
  const routeFocused = useRouteFocused();
  // Whether this instance ever painted the profile it serves. A ref, because
  // the answer must survive the render that replaces the content with the
  // refusal.
  const painted = useRef<{ profileId: string; painted: boolean } | null>(null);
  if (painted.current === null || painted.current.profileId !== profileId) {
    painted.current = { profileId, painted: false };
  }

  useEffect(() => {
    // An effect of the previous destination can still run here, so the write is
    // guarded by the id rather than trusted to the dependency list alone.
    if (contentShown && painted.current?.profileId === profileId) {
      painted.current.painted = true;
    }
  }, [contentShown, profileId]);

  useEffect(() => {
    // The root `(app)` stack keeps the terminal view: its profile route has no
    // tab stack to return to, so its Back is the whole way out.
    if (!terminalRefusal || !routeFocused || stack !== 'profileTab') {
      return;
    }
    if (painted.current?.profileId !== profileId || !painted.current.painted) {
      return;
    }
    router.dismissAll();
  }, [profileId, routeFocused, router, stack, terminalRefusal]);
}
