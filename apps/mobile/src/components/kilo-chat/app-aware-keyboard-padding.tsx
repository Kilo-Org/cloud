import { type ComponentProps, useEffect, useState } from 'react';
import { AppState, Keyboard, type KeyboardEvent, Platform, View } from 'react-native';

import { resolveAppAwareKeyboardPadding } from './app-aware-keyboard-padding-state';

function keyboardPaddingFromEvent(event: KeyboardEvent): number {
  return event.endCoordinates.height;
}

export function AppAwareKeyboardPaddingView({ style, ...props }: ComponentProps<typeof View>) {
  const [keyboardPadding, setKeyboardPadding] = useState(0);

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

  return (
    <View {...props} style={[style, Platform.OS === 'ios' && { paddingBottom: keyboardPadding }]} />
  );
}
