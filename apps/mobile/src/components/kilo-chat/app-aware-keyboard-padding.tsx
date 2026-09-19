import { type ComponentProps, useEffect, useState } from 'react';
import { AppState, Keyboard, type KeyboardEvent, Platform, View } from 'react-native';

import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

function keyboardPaddingFromEvent(event: KeyboardEvent): number {
  return event.endCoordinates.height;
}

/**
 * The bottom padding an AppAwareKeyboardPaddingView applies: the IME's height
 * while the keyboard is open (plus the caller's offset), 0 while it is closed.
 * Exported so a pinned footer inside the padding view can measure its own
 * clearance against the same lift instead of re-listening to the keyboard.
 */
export function useAppAwareKeyboardPadding(keyboardOffset = 0): number {
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

  return keyboardPadding > 0 ? keyboardPadding + keyboardOffset : 0;
}

export function AppAwareKeyboardPaddingView({
  style,
  keyboardOffset = 0,
  ...props
}: ComponentProps<typeof View> & { keyboardOffset?: number }) {
  const resolvedKeyboardPadding = useAppAwareKeyboardPadding(keyboardOffset);

  return <View {...props} style={[style, { paddingBottom: resolvedKeyboardPadding }]} />;
}
