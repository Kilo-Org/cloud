import { type ComponentProps, useEffect, useState } from 'react';
import { AppState, Keyboard, type KeyboardEvent, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveAppAwareKeyboardPadding } from './app-aware-keyboard-padding-state';

function keyboardPaddingFromEvent(event: KeyboardEvent): number {
  return event.endCoordinates.height;
}

export function AppAwareKeyboardPaddingView({ style, ...props }: ComponentProps<typeof View>) {
  const [keyboardPadding, setKeyboardPadding] = useState(0);
  const { bottom: safeBottom } = useSafeAreaInsets();

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      setKeyboardPadding(0);
      return undefined;
    }

    const keyboardShowSubscription = Keyboard.addListener('keyboardWillShow', event => {
      setKeyboardPadding(currentPadding =>
        resolveAppAwareKeyboardPadding({
          currentPadding,
          event: {
            type: 'keyboard-visible',
            keyboardHeight: keyboardPaddingFromEvent(event),
          },
        })
      );
    });
    const keyboardHideSubscription = Keyboard.addListener('keyboardWillHide', () => {
      setKeyboardPadding(currentPadding =>
        resolveAppAwareKeyboardPadding({
          currentPadding,
          event: { type: 'keyboard-hidden' },
        })
      );
    });
    const appStateSubscription = AppState.addEventListener('change', appState => {
      setKeyboardPadding(currentPadding =>
        resolveAppAwareKeyboardPadding({
          currentPadding,
          event: { type: 'app-state-change', appState },
        })
      );
    });

    return () => {
      keyboardShowSubscription.remove();
      keyboardHideSubscription.remove();
      appStateSubscription.remove();
    };
  }, []);

  // When the keyboard is up, its height already covers the bottom safe area.
  // When it's dismissed, fall back to the safe-area inset so trailing content
  // (e.g. the typing indicator) clears the home indicator / rounded screen edge.
  const paddingBottom = Math.max(keyboardPadding, safeBottom);

  return <View {...props} style={[style, Platform.OS === 'ios' && { paddingBottom }]} />;
}
