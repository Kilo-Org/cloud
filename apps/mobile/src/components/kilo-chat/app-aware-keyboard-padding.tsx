import { type ComponentProps, useEffect, useState } from 'react';
import { AppState, Dimensions, Keyboard, type KeyboardEvent, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

function keyboardPaddingFromEvent(event: KeyboardEvent): number {
  // Android edge-to-edge reports the visible-frame bottom as screenY, not the
  // IME top, and its height excludes the bottom system-bar inset; the inset
  // added back in the hook rebuilds the IME top. iOS reports the keyboard's top
  // in screen coordinates, which already includes the system bars.
  if (Platform.OS === 'android') {
    return event.endCoordinates.height;
  }
  return Dimensions.get('screen').height - event.endCoordinates.screenY;
}

/**
 * The bottom padding an AppAwareKeyboardPaddingView applies: the strip the IME
 * hides from the screen bottom — its reported height plus the bottom system-bar
 * inset on Android, the screen overlap on iOS — plus the caller's offset while
 * the keyboard is open, else 0.
 *
 * This is the app's one keyboard read (`keyboardWillShow` on iOS,
 * `keyboardDidShow` on Android, where the window never resizes for the IME
 * under API 35+). Exported so a screen that must react to the keyboard beyond
 * reserving its height — a pinned footer measuring its own clearance, a
 * reveal-end scroll — reads the same lift the padding view applies instead of
 * adding a second listener.
 */
export function useAppAwareKeyboardPadding(keyboardOffset = 0): number {
  const { bottom } = useSafeAreaInsets();
  const [keyboardPadding, setKeyboardPadding] = useState(0);

  useEffect(() => {
    const keyboardEvents = resolveKeyboardPaddingEventsForPlatform(Platform.OS);
    if (keyboardEvents === null) {
      setKeyboardPadding(0);
      return undefined;
    }

    const keyboardShowSubscription = Keyboard.addListener(keyboardEvents.show, event => {
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
    const keyboardHideSubscription = Keyboard.addListener(keyboardEvents.hide, () => {
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

  // Android reports the IME height with the navigation bar already subtracted
  // (ReactRootView: imeInsets.bottom − barInsets.bottom), so the shared lift
  // adds it back and covers the whole strip the keyboard hides. Callers that
  // reserve the same inset while the keyboard is closed then yield to this lift.
  const systemBarInset = Platform.OS === 'android' ? bottom : 0;
  return keyboardPadding > 0 ? keyboardPadding + keyboardOffset + systemBarInset : 0;
}

export function AppAwareKeyboardPaddingView({
  style,
  keyboardOffset = 0,
  ...props
}: ComponentProps<typeof View> & { keyboardOffset?: number }) {
  const resolvedKeyboardPadding = useAppAwareKeyboardPadding(keyboardOffset);

  return <View {...props} style={[style, { paddingBottom: resolvedKeyboardPadding }]} />;
}
