import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

import { useRouteFocused } from '@/lib/navigation/route-focus';
import { type ProfileManagementStack } from '@/lib/profile-agent-navigation';

/** What the caller's render says about the profile route it serves. */
type MissingProfileLeave = {
  contentShown: boolean;
  profileMissing: boolean;
  stack: ProfileManagementStack;
};

/**
 * Leave a Profile tab route whose profile was deleted after the screen painted
 * it, and leave every other refusal where it is.
 *
 * The Profile tab keeps its stack across tab switches, so a route that showed a
 * working profile and later reads that the profile is gone has nothing to show
 * and nothing to press, apart from leaving: the tab stays on the empty screen
 * until the reader finds Back. This returns the tab to the first screen of its
 * own stack, the tab's Profile root, where the Profiles list is one tap away and
 * the stale row has already been refreshed out.
 *
 * The rule is "rendered, then deleted", not "the read holds a profile" and not a
 * timing or focus heuristic. A route opened with a cached profile the server
 * refuses on the first answer never painted that profile, so the reader still
 * has to see why the screen is empty and leave with Back; only a person who read
 * the profile and came back to it gone is stranded.
 *
 * A refusal that is not a deletion keeps its own screen even after the profile
 * painted. A permission denial is an answer about the reader's access, and its
 * copy is the only place the app states it; leaving would discard the reason.
 *
 * The record names the profile it belongs to, which is what makes a reused route
 * instance safe: the navigator reuses one when it opens the same route name with
 * other params, and an instance that painted one profile has painted nothing of
 * the next. A late effect of the previous destination can then only write the id
 * it was rendered for, so it cannot claim the new profile was painted.
 *
 * Focus is part of the decision: an off-screen tab must not navigate itself.
 */
export function useLeaveMissingProfileRoute(
  profileId: string,
  { contentShown, profileMissing, stack }: MissingProfileLeave
): void {
  const router = useRouter();
  const routeFocused = useRouteFocused();
  // The profile this instance painted, if any. State, because the answer must
  // outlive the render that replaced the content with the refusal.
  const [paintedProfileId, setPaintedProfileId] = useState<string | null>(null);
  useEffect(() => {
    if (contentShown) {
      setPaintedProfileId(profileId);
    }
  }, [contentShown, profileId]);

  useEffect(() => {
    // The root `(app)` stack keeps the terminal view: its profile route has no
    // tab stack to return to, so its Back is the whole way out.
    if (!profileMissing || !routeFocused || stack !== 'profileTab') {
      return;
    }
    if (paintedProfileId !== profileId) {
      return;
    }
    router.dismissAll();
  }, [paintedProfileId, profileId, profileMissing, routeFocused, router, stack]);
}
