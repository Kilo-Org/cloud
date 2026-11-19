import {
  type Href,
  type NativeStackNavigationProp,
  useNavigation,
  usePathname,
  useRouter,
} from 'expo-router';
import { useEffect, useRef } from 'react';

import { ORGANIZATION_HUB_PATH, ORGANIZATION_HUB_ROUTE_NAME } from '@/lib/organization-navigation';
import {
  isFocusedProfileScreen,
  profileScreenPath,
  type ProfileStackParents,
  profileStackRepair,
  withRebuiltParents,
} from '@/lib/profile-route-stack';

/** The navigation object a screen of a Stack sees. */
type StackNavigation = NativeStackNavigationProp<Record<string, undefined>>;

/**
 * The organization screens the repair may rebuild, in the Profile tab's Stack
 * below the organization layout: the hub (`index`) plus every child the hub
 * pushes. Expo Router names a screen after its file below the layout that
 * declares it, the same shape the profile route names rely on.
 */
export const ORGANIZATION_ROUTE_NAMES: readonly string[] = [
  ORGANIZATION_HUB_ROUTE_NAME,
  'audit-log',
  'billing',
  'credit-activity',
  'guardrails',
  'group-form',
  'groups',
  'invoices',
  'members',
  'mode-form',
  'modes',
  'providers-and-models',
  'request-logs',
  'usage',
  '[org-id]',
];

/**
 * Give an organization screen the hub when it is missing beneath it.
 *
 * The organization hub is the first route of the organization Stack
 * (`organization/_layout.tsx`), and the hub pushes its children on top of
 * itself. A deep link, a relaunch restore, or a link delivered while another
 * route is focused pushes ONE child: Back then leaves the organization tree at
 * once instead of stepping back to the hub the reader would have passed on the
 * way in.
 *
 * The repair pushes the missing hub, re-pushes this screen above it, and
 * retires the original copy once its replacement is on top — the same moves the
 * profile screens make (`use-repair-profile-route-stack.ts`), and every step is
 * a plain push or a reset that keeps the focused screen where it is, the shapes
 * the Android native stack commits cleanly (`stack-safe-replace.ts`). The
 * rebuilt pushes carry `PROFILE_STACK_REBUILT_PARAM`, which turns their
 * transitions off in the layout's screen options and tells a rebuilt screen not
 * to repair again.
 *
 * The decision is taken once this screen is the focused one, never from its own
 * first render: a route renders before the navigator's state lists it as
 * current, so an earlier read sees the previous screen and rebuilds the wrong
 * stack.
 */
export function useRepairOrganizationRouteStack({
  self,
}: Readonly<{
  /** The href that re-opens this screen above the hub. */
  self: Href;
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
      // own. The rebuilt hub on top of it is not this screen yet.
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
          profileRouteNames: ORGANIZATION_ROUTE_NAMES,
          currentParams: current.params,
        })
      ) {
        return;
      }
      decided = true;
      const toPush = profileStackRepair({
        routes: state.routes,
        currentIndex: state.index,
        // An outside screen that deliberately opened an organization child
        // (the session opener) owns its Back target, so the tree is never
        // built under it — the rule `profileStackRepair` applies to the
        // profile screens.
        openedOutsideProfileTree: false,
        parents: { list: true, overview: false } satisfies ProfileStackParents,
        listRouteName: ORGANIZATION_HUB_ROUTE_NAME,
        overviewRouteName: ORGANIZATION_HUB_ROUTE_NAME,
      });
      if (!(toPush.list || toPush.overview)) {
        return;
      }
      const retiredKey = current.key;
      const selfName = current.name;
      unsubscribeRetire = navigation.addListener('state', () => {
        retireOriginal(retiredKey, selfName);
      });
      router.push(withRebuiltParents(ORGANIZATION_HUB_PATH));
      router.push(withRebuiltParents(self));
    };

    const unsubscribeDecide = navigation.addListener('state', decide);
    // The focused pathname settles on its own render, after a state event.
    decide();
    return () => {
      unsubscribeDecide();
      unsubscribeRetire?.();
    };
  }, [navigation, router, screenPath, self]);
}
