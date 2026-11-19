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
  type ProfileStackParents,
  profileStackRepair,
  TRIGGER_ROUTE_NAMES,
  TRIGGERS_LIST_ROUTE_NAME,
  withRebuiltParents,
} from '@/lib/profile-route-stack';
import {
  notePendingProfileRetirement,
  takeRetirableProfileRoutes,
} from '@/lib/profile-stack-retirement';
import { triggersListHref } from '@/lib/cloud-triggers/trigger-routes';

/** The navigation object a screen of a Stack sees. */
type StackNavigation = NativeStackNavigationProp<Record<string, undefined>>;

/**
 * The Stack the trigger screens are mounted in: the Profile tab's, the Stack the
 * retirement module scopes a pending removal to. The trigger routes exist only
 * there, so every repair records and finishes under this name.
 */
const TRIGGER_STACK = 'profileTab';

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
 *
 * The removal belongs to the rebuilt copy, not to the copy that asked for the
 * repair: a native Stack unmounts a covered screen, so the repairing screen is
 * already gone when its rebuilt copy lands, and a removal tracked there never
 * ran. It therefore lives outside both screens
 * (`profile-stack-retirement.ts`), and every trigger screen finishes a pending
 * removal the moment a rebuilt copy of that screen is focused. A repair that
 * leaves its original in the stack is worse than no repair: Back then steps out
 * to the list and the leftover copy becomes the focused screen again, so the
 * detail returns instead of the reader leaving it.
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
        parents: { list: true, overview: false } satisfies ProfileStackParents,
        listRouteName: TRIGGERS_LIST_ROUTE_NAME,
        // The trigger screens need one parent, the list, so the overview slot is
        // never pushed; the list's own name keeps the rule honest instead of a
        // profile route no trigger Stack can hold.
        overviewRouteName: TRIGGERS_LIST_ROUTE_NAME,
      });
      if (!(toPush.list || toPush.overview)) {
        return;
      }
      // This copy is about to be replaced by the rebuilt one above the list, and
      // a covered screen stops running code, so the removal is recorded where
      // any trigger screen can finish it (`profile-stack-retirement.ts`).
      notePendingProfileRetirement({
        key: current.key,
        stack: TRIGGER_STACK,
        selfName: current.name,
        now: Date.now(),
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
    return unsubscribeDecide;
  }, [navigation, organizationId, router, screenPath, self]);

  // The rebuilt copy of a repaired screen is what finishes the repair: every
  // trigger screen watches the Stack for the state that puts a rebuilt copy on
  // top, and removes the original below it then.
  useEffect(() => {
    const retire = () => {
      const state = navigation.getState();
      const next = takeRetirableProfileRoutes({
        routes: state.routes,
        index: state.index,
        stack: TRIGGER_STACK,
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
  }, [navigation]);
}
