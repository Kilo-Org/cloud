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

/**
 * The keyboard's raw height and the occlusion it reserves at the screen bottom,
 * `0` while the keyboard is down.
 *
 * The two platforms measure the IME from different origins: Android's stops at
 * the navigation bar (`ReactRootView` reports `imeInsets.bottom −
 * barInsets.bottom`) while iOS's frame reaches the screen bottom. The reserved
 * space is anchored to the screen bottom, so resolve the occlusion with the same
 * rule the login screen and the Toaster use (`resolveKeyboardBottomPadding`);
 * padding by the raw Android height left the manual review form's Start button
 * behind the IME's navigation row (2026-09-20). A caller that reserves the
 * keyboard's height in its own layout (a surface inset) reads the occlusion from
 * here; the padded view below also needs the raw metric.
 */
export function useKeyboardOcclusion() {
  const keyboardHeight = useAppAwareKeyboardPadding();
  const { bottom } = useSafeAreaInsets();
  const keyboardOcclusion =
    keyboardHeight > 0
      ? resolveKeyboardBottomPadding({
          keyboardHeight,
          bottomInset: bottom,
          platform: Platform.OS,
        })
      : 0;
  return { keyboardHeight, keyboardOcclusion };
}

export function AppAwareKeyboardPaddingView({
  style,
  keyboardOffset = 0,
  containerReservesBottomInset = false,
  contentReservesBottomInset = false,
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
  /**
   * The wrapped content pads the platform's bottom inset itself: the session
   * composer adds `MESSAGE_INPUT_BOTTOM_CLEARANCE + bottomInset` and the
   * discussion CTA bar adds `useDetailScreenBottomPadding()`. The occlusion
   * resolved above is anchored to the screen bottom, so it counts that inset on
   * top of the content's own padding and floats the composer / CTA a
   * navigation-bar height above the keyboard. Such a caller adds the platform's
   * raw keyboard metric instead: on Android the content's inset padding
   * completes it, and on iOS the metric already reaches the screen bottom, so
   * the lift those callers shipped with is unchanged (2026-09-21 review
   * finding).
   */
  contentReservesBottomInset?: boolean;
}) {
  const { keyboardHeight, keyboardOcclusion } = useKeyboardOcclusion();
  const { bottom } = useSafeAreaInsets();
  // One inset per screen: where a container outside this view (a trailing
  // spacer, a parent `paddingBottom`) or the wrapped content's own bottom
  // padding already reserved the bottom inset, the screen-bottom-anchored
  // occlusion must not count it a second time.
  let keyboardPadding = keyboardOcclusion;
  if (containerReservesBottomInset) {
    keyboardPadding = Math.max(keyboardOcclusion - bottom, 0);
  } else if (contentReservesBottomInset) {
    keyboardPadding = keyboardHeight;
  }

  const resolvedKeyboardPadding = keyboardPadding > 0 ? keyboardPadding + keyboardOffset : 0;

  return <View {...props} style={[style, { paddingBottom: resolvedKeyboardPadding }]} />;
}
