import { type NativeStackNavigationProp } from 'expo-router';
import { type ParamListBase } from 'expo-router/react-navigation';
import { useEffect } from 'react';

import { TAB_STACK_ROOT_ROUTE_NAME, tabStackRootRepair } from '@/lib/tab-stack-root-repair';

/**
 * The states this repair already acted on.
 *
 * Every scene of a tab's Stack renders its own scene layout, so a screen that
 * arrives with the root missing has several of these hooks subscribed at once
 * and they all read the same state object before the first reset commits.
 * Acting once per state object keeps a second insert out of the Stack; a real
 * navigation produces a new state object, so a later departure still repairs.
 */
const repairedStates = new WeakSet<object>();

/**
 * The navigation object a tab Stack's scene layout sees.
 *
 * Read and dispatch only: a scene layout renders outside the route's
 * NavigationProvider, so it is handed the screen's own navigation instead of
 * using a hook, and this is all the repair needs from it.
 */
export type TabStackNavigation = Pick<
  NativeStackNavigationProp<ParamListBase>,
  'getState' | 'reset' | 'addListener'
>;

/**
 * Put a tab's root beneath a tab screen that was restored without it.
 *
 * A fresh navigation destination — a link that replaces the focused route, or
 * the restore a relaunch performs — can be built from the target alone, with
 * the tab Stack's anchor never read. The Stack is then the subpage's only
 * route: Back leaves the tab for Home, and a press on the selected tab cannot
 * reach the tab's root because the press plan reads the Stack as already at
 * its root.
 *
 * Inserting the root directly beneath the focused screen gives every leave a
 * destination inside the tab again, which is the state the root -> subpage
 * path already produces. The insertion keeps the existing routes, and so their
 * keys: the screen the reader is on keeps its identity and its state and only
 * falls to the next index, so the native stack never sees a screen removed and
 * another inserted in one commit. The repair runs on mount and on every later
 * state change, because a later link can replace the focused route again; it
 * is a no-op once the root sits beneath the screen.
 */
export function useRepairTabStackRoot(navigation: TabStackNavigation | undefined): void {
  useEffect(() => {
    if (navigation === undefined) {
      return undefined;
    }
    const repair = () => {
      const state = navigation.getState();
      if (repairedStates.has(state)) {
        return;
      }
      // A Stack that does not register the root route rejects the reset, and
      // remembering that state would stop the repair from ever trying again.
      // Only a Stack that declares its root can take the insertion.
      if (!state.routeNames.includes(TAB_STACK_ROOT_ROUTE_NAME)) {
        return;
      }
      const repaired = tabStackRootRepair(state);
      if (repaired === null) {
        return;
      }
      repairedStates.add(state);
      navigation.reset({ ...state, routes: repaired.routes, index: repaired.index });
    };
    repair();
    return navigation.addListener('state', repair);
  }, [navigation]);
}
