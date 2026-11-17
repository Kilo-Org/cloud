import {
  type Href,
  type NativeStackNavigationProp,
  useNavigation,
  usePathname,
  useRouter,
} from 'expo-router';
import { useEffect, useRef } from 'react';

import {
  isFocusedProfileScreen,
  profileScreenPath,
  profileStackRepair,
  TRIGGER_ROUTE_NAMES,
  withRebuiltParents,
} from '@/lib/profile-route-stack';
import { triggersListHref } from '@/lib/cloud-triggers/trigger-routes';

/** The navigation object a screen of a Stack sees. */
type StackNavigation = NativeStackNavigationProp<Record<string, undefined>>;

/**
 * Give the trigger screens the triggers list when it is missing beneath them.
 *
 * The trigger detail and create screens are children of the triggers list in
 * the Profile tab's Stack, but a deep link (or a create screen the guard left)
 * pushes one screen on its own: Back then leaves the profile tree for whatever
 * happened to be beneath instead of stepping back to the list the reader came
 * from. The repair pushes the list, re-pushes this screen above it, and retires
 * the original copy once its replacement is on top — the same moves the profile
 * screens make (`use-repair-profile-route-stack.ts`), and every step is a plain
 * push or a reset that keeps the focused screen where it is, the shapes the
 * Android native stack commits cleanly (`stack-safe-replace.ts`).
 *
 * The rebuilt pushes carry `PROFILE_STACK_REBUILT_PARAM`, which turns their
 * transitions off in the layouts' screen options and tells a rebuilt screen not
 * to repair again.
 */
export function useRepairTriggerRouteStack({
  self,
  organizationId,
}: Readonly<{
  /** The href that re-opens this screen above the list. */
  self: Href;
  /** The organization the caller is scoped to; absent is the caller's own triggers. */
  organizationId?: string;
}>): void {
  const router = useRouter();
  const navigation = useNavigation<StackNavigation>();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const screenPath = profileScreenPath(self);

  useEffect(() => {
    // One decision per mounted screen, whatever it decides.
    let decided = false;
    let retired = false;
    let unsubscribeRetire: (() => void) | undefined = undefined;

    const retireOriginal = (retiredKey: string, selfName: string) => {
      if (retired) {
        return;
      }
      const state = navigation.getState();
      const top = state.routes[state.index];
      // Wait until this screen's own rebuilt copy is the focused route: the
      // removed screen is never the focused one, so the reset commits on its
      // own. The rebuilt list on top of it is not this screen yet.
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
          profileRouteNames: TRIGGER_ROUTE_NAMES,
          currentParams: current.params,
        })
      ) {
        return;
      }
      decided = true;
      const toPush = profileStackRepair({
        routes: state.routes,
        currentIndex: state.index,
        openedOutsideProfileTree: false,
        parents: { list: true, overview: false },
        listRouteName: TRIGGERS_LIST_ROUTE_NAME,
        overviewRouteName: 'profiles/[profileId]/index',
      });
      if (!(toPush.list || toPush.overview)) {
        return;
      }
      const retiredKey = current.key;
      const selfName = current.name;
      unsubscribeRetire = navigation.addListener('state', () => {
        retireOriginal(retiredKey, selfName);
      });
      // The rebuilt list keeps the caller's scope: `org` is what scopes the
      // list, the detail and every write, so a personal rebuild would show the
      // caller's own triggers under an organization link.
      router.push(withRebuiltParents(triggersListHref(organizationId)));
      router.push(withRebuiltParents(self));
    };

    const unsubscribeDecide = navigation.addListener('state', decide);
    // The focused pathname settles on its own render, after a state event.
    decide();
    return () => {
      unsubscribeDecide();
      unsubscribeRetire?.();
    };
  }, [navigation, organizationId, router, screenPath, self]);
}
