import { type NativeStackNavigationProp } from 'expo-router';
import { type ParamListBase } from 'expo-router/react-navigation';
import { useEffect } from 'react';

import {
  isScopeDashboardMissing,
  SCOPE_DASHBOARD_ROUTE_NAME,
} from '@/lib/security-agent-route-stack';

/**
 * The states this repair already acted on.
 *
 * Every screen of the Stack renders its own scene layout, so a screen that
 * arrives with the dashboard missing has several of these hooks subscribed at
 * once and they all read the same state object before the first reset
 * commits. Acting once per state object keeps a second insert out of the
 * Stack; a real navigation produces a new state object, so a later departure
 * still repairs.
 */
const repairedStates = new WeakSet<object>();

/**
 * The navigation object a `[scope]` Stack scene sees.
 *
 * Read and dispatch only: the scene layout renders outside the route's
 * NavigationProvider, so it is handed the screen's own navigation instead of
 * using a hook, and this is all the repair needs from it.
 */
export type ScopeStackNavigation = Pick<
  NativeStackNavigationProp<ParamListBase>,
  'getState' | 'reset' | 'addListener'
>;

/**
 * Put the scope dashboard beneath a Security Agent screen that was opened
 * without it.
 *
 * A screen the group opened as a fresh destination — a link delivered while
 * another route of the group is focused replaces that route — has no screen
 * beneath it, so a back press resolves on the ROOT stack and pops the whole
 * Security Agent group. Inserting the dashboard directly under the focused
 * screen gives every leave a destination inside the group again, which is the
 * state the dashboard -> findings/settings path already produces.
 *
 * The insertion keeps the existing routes, and so their keys: the screen the
 * reader is on keeps its identity and its state (a half-filled form, a draft)
 * and only falls to the next index. The repair runs on mount and on every
 * later state change, because a later link can replace the focused route
 * again; it is a no-op once the dashboard sits beneath the screen.
 */
export function useRepairSecurityAgentScopeStack(
  navigation: ScopeStackNavigation,
  scope: string | null
): void {
  useEffect(() => {
    if (scope === null) {
      return undefined;
    }
    const repair = () => {
      const state = navigation.getState();
      const focused = state.routes[state.index];
      if (focused === undefined || !isScopeDashboardMissing(state) || repairedStates.has(state)) {
        return;
      }
      repairedStates.add(state);
      const routes = [...state.routes];
      // Directly beneath the focused screen, not at the bottom: the screens
      // already beneath it are the ones the reader moved on from. The key is
      // derived from the screen it is inserted under, so it is unique in this
      // state and a second repair after the app replaced that screen gets a
      // new one.
      routes.splice(state.index, 0, {
        key: `${focused.key}:${SCOPE_DASHBOARD_ROUTE_NAME}`,
        name: SCOPE_DASHBOARD_ROUTE_NAME,
        params: { scope },
      });
      navigation.reset({ ...state, routes, index: state.index + 1 });
    };
    repair();
    return navigation.addListener('state', repair);
  }, [navigation, scope]);
}
