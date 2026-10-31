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
    let retired = false;

    const retireOriginal = (retiredKey: string, selfName: string) => {
      if (retired) {
        return;
      }
      const state = navigation.getState();
      const top = state.routes[state.index];
      // Wait until this screen's own rebuilt copy is the focused route: the
      // removed screen is never the focused one, so the reset commits on its
      // own. Another rebuilt parent on top is not this screen yet.
      if (
        top === undefined ||
        top.key === retiredKey ||
        top.name !== selfName ||
        pathnameRef.current !== screenPath
      ) {
        return;
      }
      if (!state.routes.some(route => route.key === retiredKey)) {
        retired = true;
        return;
      }
      const routes = state.routes.filter(route => route.key !== retiredKey);
      if (routes.length === state.routes.length || routes.length === 0) {
        return;
      }
      retired = true;
      navigation.reset({ ...state, routes, index: routes.length - 1 });
    };

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
      const retiredKey = current.key;
      const selfName = current.name;
      if (toPush.list) {
        router.push(withRebuiltParents(getProfilesPath(stack)));
      }
      if (toPush.overview && profile !== null) {
        router.push(withRebuiltParents(getProfileOverviewPath(profile, { organizationId, stack })));
      }
      router.push(withRebuiltParents(self));
      navigation.addListener('state', () => {
        retireOriginal(retiredKey, selfName);
      });
    };

    const unsubscribe = navigation.addListener('state', decide);
    // The focused pathname settles on its own render, after a state event.
    decide();
    return unsubscribe;
  }, [navigation, organizationId, parents, profile, router, screenPath, self, stack]);
}