import { type ComponentProps, useEffect, useState } from 'react';
import { AppState, Keyboard, type KeyboardEvent, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveKeyboardBottomPadding } from '@/components/login-screen-state';
import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

function keyboardPaddingFromEvent(event: KeyboardEvent): number {
  return event.endCoordinates.height;
}

/**
 * Height of the software keyboard while it is up, `0` otherwise, resolved for
 * the current platform (`keyboardWillShow` on iOS, `keyboardDidShow` on
 * Android, where the window never resizes for the IME under API 35+).
 *
 * A screen that must react to the keyboard beyond reserving its height (e.g.
 * revealing a call-to-action the IME covers) reads it from here instead of
 * adding a second listener.
 */
export function useAppAwareKeyboardPadding(): number {
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

  return keyboardPadding;
}

export function AppAwareKeyboardPaddingView({
  style,
  keyboardOffset = 0,
  containerReservesBottomInset = false,
  ...props
}: ComponentProps<typeof View> & {
  keyboardOffset?: number;
  /**
   * The caller's own container reserves the platform's bottom inset above this
   * view (a trailing spacer, or a `paddingBottom` on the parent), so the
   * view's bottom edge sits `bottomInset` above the screen bottom. The
   * resolved occlusion is anchored to the screen bottom, so the inset the
   * container already reserved is subtracted here — on Android that reduces to
   * the platform's raw metric, whose origin stops at the navigation bar.
   * Counting the inset twice floated the session composer and the new-session
   * Start button a nav-bar height above the keyboard (2026-09-20).
   */
  containerReservesBottomInset?: boolean;
}) {
  const keyboardHeight = useAppAwareKeyboardPadding();
  const { bottom } = useSafeAreaInsets();
  // The hook reports the platform's own keyboard metric, and the two platforms
  // measure it from different origins: Android's stops at the navigation bar
  // (`ReactRootView` reports `imeInsets.bottom − barInsets.bottom`) while iOS's
  // frame reaches the screen bottom. The reserved space is anchored to the
  // screen bottom, so resolve it with the same rule the login screen and the
  // Toaster use; padding by the raw Android height left the bottom
  // `bottomInset` of the content — the manual review form's Start button —
  // behind the IME's navigation row (2026-09-20).
  const keyboardOcclusion =
    keyboardHeight > 0
      ? resolveKeyboardBottomPadding({
          keyboardHeight,
          bottomInset: bottom,
          platform: Platform.OS,
        })
      : 0;
  // One inset per screen: where the container already reserved the bottom
  // inset outside this view, the screen-bottom-anchored occlusion would count
  // it a second time.
  const keyboardPadding = containerReservesBottomInset
    ? Math.max(keyboardOcclusion - bottom, 0)
    : keyboardOcclusion;

  const resolvedKeyboardPadding = keyboardPadding > 0 ? keyboardPadding + keyboardOffset : 0;

  return <View {...props} style={[style, { paddingBottom: resolvedKeyboardPadding }]} />;
}
