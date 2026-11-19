import {
  type Href,
  type NativeStackNavigationProp,
  useNavigation,
  usePathname,
  useRouter,
} from 'expo-router';
import { useEffect, useRef } from 'react';

import {
  getProfileOverviewPath,
  getProfileOverviewRouteName,
  getProfileRouteNames,
  getProfilesPath,
  getProfilesRouteName,
  type ProfileManagementStack,
} from '@/lib/profile-agent-navigation';
import {
  hasParentsToPush,
  isFocusedProfileScreen,
  profileExternalOpener,
  profileScreenPath,
  type ProfileStackParents,
  profileStackRepair,
  withRebuiltParents,
} from '@/lib/profile-route-stack';
import {
  notePendingProfileRetirement,
  takeRetirableProfileRoutes,
} from '@/lib/profile-stack-retirement';

/** The navigation object a screen of a Stack sees. */
type StackNavigation = NativeStackNavigationProp<Record<string, undefined>>;

/**
 * Give a profile screen the parents it is missing.
 *
 * A profile screen pushed from the profiles list has the list beneath it, and a
 * section pushed from the overview has both. A deep link, a relaunch restore, or
 * a link delivered while the app sits on its opening route pushes ONE screen:
 * Back then leaves the profile tree at once instead of stepping back through the
 * screens the reader would have passed on the way in.
 *
 * The repair pushes the missing parents, re-pushes this screen above them, and
 * retires the original copy once its replacement is on top. It never removes a
 * screen and inserts another in one commit, the shape the Android native stack
 * crashes on (`stack-safe-replace.ts`); every step is a plain push or a reset
 * that keeps the focused screen where it is. The rebuilt pushes carry
 * `PROFILE_STACK_REBUILT_PARAM`, which turns their transitions off in the
 * layouts' screen options and tells a rebuilt screen not to repair again.
 *
 * The removal belongs to the rebuilt copy, not to the copy that asked for the
 * repair: a native Stack unmounts a covered screen, so the repairing screen is
 * already gone when its rebuilt copy lands, and a removal tracked there never
 * ran. It therefore lives outside both screens
 * (`profile-stack-retirement.ts`), and every profile screen finishes a pending
 * removal the moment a rebuilt copy of that screen is focused. A repair that
 * leaves its original in the stack is worse than no repair: Back then steps out
 * to the parents and the leftover copy becomes the focused screen again, so the
 * section returns instead of the reader leaving it.
 *
 * The decision is taken once this screen is the focused one, never from its own
 * first render: a route renders before the navigator's state lists it as
 * current, so an earlier read sees the previous screen and rebuilds the wrong
 * stack.
 */
export function useRepairProfileRouteStack({
  profileId,
  organizationId,
  parents,
  self,
  stack,
}: Readonly<{
  /** The profile the screen shows; null for the screens that carry no profile. */
  profileId?: string | null;
  /** The organization context the profile was opened with. */
  organizationId?: string;
  /** The parents this screen needs beneath it. */
  parents: ProfileStackParents;
  /** The href that re-opens this screen above its parents. */
  self: Href;
  /** The Stack this screen is mounted in. */
  stack: ProfileManagementStack;
}>): void {
  const router = useRouter();
  const navigation = useNavigation<StackNavigation>();
  const pathname = usePathname();
  // The listeners below fire on state changes, so they read the newest pathname
  // through a ref instead of the value captured when they subscribed.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const profile = profileId ?? null;
  const screenPath = profileScreenPath(self);

  useEffect(() => {
    // One decision per mounted screen, whatever it decides.
    let decided = false;

    const decide = () => {
      if (decided) {
        return;
      }
      const state = navigation.getState();
      const current = state.routes[state.index];
      if (current === undefined) {
        return;
      }
      if (
        !isFocusedProfileScreen({
          pathname: pathnameRef.current,
          screenPath,
          currentRouteName: current.name,
          profileRouteNames: getProfileRouteNames(stack),
          currentParams: current.params,
        })
      ) {
        return;
      }
      decided = true;
      const toPush = profileStackRepair({
        routes: state.routes,
        currentIndex: state.index,
        openedOutsideProfileTree: profileExternalOpener(current.params) !== null,
        parents,
        listRouteName: getProfilesRouteName(stack),
        overviewRouteName: getProfileOverviewRouteName(stack),
      });
      if (!hasParentsToPush(toPush)) {
        return;
      }
      // This copy is about to be replaced by the rebuilt one above the parents,
      // and a covered screen stops running code, so the removal is recorded where
      // any profile screen can finish it (`profile-stack-retirement.ts`).
      notePendingProfileRetirement({
        key: current.key,
        stack,
        selfName: current.name,
        now: Date.now(),
      });
      if (toPush.list) {
        router.push(withRebuiltParents(getProfilesPath(stack)));
      }
      if (toPush.overview && profile !== null) {
        router.push(withRebuiltParents(getProfileOverviewPath(profile, { organizationId, stack })));
      }
      router.push(withRebuiltParents(self));
    };

    const unsubscribeDecide = navigation.addListener('state', decide);
    // The focused pathname settles on its own render, after a state event.
    decide();
    return unsubscribeDecide;
  }, [navigation, organizationId, parents, profile, router, screenPath, self, stack]);

  // The rebuilt copy of a repaired screen is what finishes the repair: every
  // profile screen watches the Stack for the state that puts a rebuilt copy on
  // top, and removes the original below it then. Watching here rather than in the
  // repairing screen is what makes the removal happen at all — the repairing
  // screen is covered (and unmounted) by the time its rebuilt copy lands.
  useEffect(() => {
    const retire = () => {
      const state = navigation.getState();
      const next = takeRetirableProfileRoutes({
        routes: state.routes,
        index: state.index,
        stack,
        now: Date.now(),
      });
      if (next === null) {
        return;
      }
      navigation.reset({ ...state, routes: next.routes, index: next.index });
    };
    // A screen can mount after the state that retired its original was applied by
    // another instance, and a navigator reports no further event for a stack that
    // is already settled, so judge the stack once as this instance mounts.
    retire();
    return navigation.addListener('state', retire);
  }, [navigation, stack]);
}
