import { type AppStateStatus } from 'react-native';

type MessageInputAppStateTransition = {
  restoreFocusOnActive: boolean;
  shouldBlur: boolean;
  shouldFocus: boolean;
};

export function resolveMessageInputAppStateTransition({
  nextAppState,
  restoreFocusOnActive,
  wasFocused,
}: {
  nextAppState: AppStateStatus;
  restoreFocusOnActive: boolean;
  wasFocused: boolean;
}): MessageInputAppStateTransition {
  if (nextAppState === 'active') {
    return {
      restoreFocusOnActive: false,
      shouldBlur: false,
      shouldFocus: restoreFocusOnActive,
    };
  }

  return {
    restoreFocusOnActive: restoreFocusOnActive || wasFocused,
    shouldBlur: wasFocused,
    shouldFocus: false,
  };
}
