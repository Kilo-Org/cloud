// Focus of the screen a shared surface renders inside.
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

type FocusableNavigation = {
  addListener?: (type: 'focus' | 'blur', listener: () => void) => () => void;
  isFocused?: () => boolean;
};

const NO_UNSUBSCRIBE = () => undefined;

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
