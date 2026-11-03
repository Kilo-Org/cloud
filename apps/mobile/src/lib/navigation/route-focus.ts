// Position and focus of the screen a shared surface renders inside.
//
// `useIsFocused()` throws when there is no navigation object above the caller,
// which is exactly the case for the sheet shell in a harness that mocks
// `expo-router` partially. Reading the vendored React Navigation context
// instead returns `undefined` there and reports "focused", so the shell mounts
// unchanged. expo-router 58 vendors react-navigation and does not re-export
// the context from its package root; importing the concrete module keeps a
// future expo-router change to this one file.
import { useCallback, useContext, useSyncExternalStore } from 'react';

import { NavigationContext } from 'expo-router/build/react-navigation/core/NavigationContext';
import { NavigationRouteContext } from 'expo-router/build/react-navigation/core/NavigationProvider';

type FocusableNavigation = {
  addListener?: (type: 'focus' | 'blur' | 'state', listener: () => void) => () => void;
  isFocused?: () => boolean;
  getState?: () => { index?: number; routes?: { key: string }[] } | undefined;
};

type NavigationRoute = { key?: string };

const NO_UNSUBSCRIBE = () => undefined;
const ASSUME_STACK_ROOT = () => true;

/**
 * Whether the caller's route is the first screen of its own stack.
 *
 * A native `formSheet` that is its stack's first screen presents with the sheet
 * surface at the window top, while a sheet pushed over another screen settles at
 * the detent cap, a status-bar inset below it (measured on the PR review sheets:
 * the pushed merge sheet's header sits a status-bar inset lower on the same
 * code). Surfaces that reserve their own top clearance read this to decide who
 * owns the top of the window.
 *
 * The answer comes from the route's own position, not from a value captured at
 * mount: a pushed screen renders once before the state that pushed it commits,
 * and that first state still lists only the screens below it.
 */
export function useRouteIsStackRoot(): boolean {
  const navigation = useContext(NavigationContext) as FocusableNavigation | undefined;
  const route = useContext(NavigationRouteContext) as NavigationRoute | undefined;
  const routeKey = route?.key;
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      navigation?.addListener?.('state', onStoreChange) ?? NO_UNSUBSCRIBE,
    [navigation]
  );
  const getSnapshot = useCallback(() => {
    const routes = navigation?.getState?.()?.routes;
    if (!routes || routeKey === undefined) {
      return true;
    }
    // A state that does not list this route yet belongs to a push in flight; the
    // sheet edge then provides the clearance, so nothing is reserved.
    return routes.findIndex(candidate => candidate.key === routeKey) === 0;
  }, [navigation, routeKey]);
  return useSyncExternalStore(subscribe, getSnapshot, ASSUME_STACK_ROOT);
}

/** Whether the caller's screen is the focused route; true outside a navigator. */
export function useRouteFocused(): boolean {
  const navigation = useContext(NavigationContext) as FocusableNavigation | undefined;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const addListener = navigation?.addListener;
      if (!addListener) {
        return NO_UNSUBSCRIBE;
      }
      const removeFocus = addListener('focus', onStoreChange);
      const removeBlur = addListener('blur', onStoreChange);
      return () => {
        removeFocus();
        removeBlur();
      };
    },
    [navigation]
  );

  const getSnapshot = useCallback(() => navigation?.isFocused?.() ?? true, [navigation]);

  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
