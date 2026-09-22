import { type ComponentProps, useEffect, useState } from 'react';
import { AppState, Dimensions, Keyboard, type KeyboardEvent, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

/**
 * The platform's own keyboard metric, in the coordinates the IME event reports
 * it in. Android edge-to-edge reports the visible-frame height with the bottom
 * system-bar inset already subtracted (`ReactRootView` reports
 * `imeInsets.bottom − barInsets.bottom`), so the metric stops at the navigation
 * bar; iOS reports the keyboard top in screen coordinates, which reaches the
 * screen bottom, so the overlap is the distance from that top to the screen
 * bottom. An event that carries no screen position falls back to the reported
 * height, which already reaches the screen bottom there.
 */
function keyboardPaddingFromEvent(event: KeyboardEvent): number {
  if (Platform.OS === 'android') {
    return event.endCoordinates.height;
  }
  const keyboardTop = event.endCoordinates.screenY;
  if (!Number.isFinite(keyboardTop)) {
    return event.endCoordinates.height;
  }
  return Dimensions.get('screen').height - keyboardTop;
}

/**
 * The strip the IME hides from the screen bottom — its reported height plus the
 * bottom system-bar inset on Android, the screen overlap on iOS — and `0` while
 * the keyboard is down.
 *
 * This is the app's one keyboard read (`keyboardWillShow` on iOS,
 * `keyboardDidShow` on Android, where the window never resizes for the IME
 * under API 35+). Exported so a screen that must react to the keyboard beyond
 * reserving its height — a pinned footer measuring its own clearance, a
 * reveal-end scroll — reads the same lift `AppAwareKeyboardPaddingView` applies
 * instead of adding a second listener.
 */
export function useAppAwareKeyboardPadding(): number {
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
  // adds it back and covers the whole strip the keyboard hides. A caller whose
  // own container or wrapped content already reserved that inset passes
  // `containerReservesBottomInset` / `contentReservesBottomInset` so the view
  // subtracts it again: the screen resolves the inset once, never twice.
  const systemBarInset = Platform.OS === 'android' ? bottom : 0;
  return keyboardPadding > 0 ? keyboardPadding + systemBarInset : 0;
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
  const { bottom } = useSafeAreaInsets();
  // The hook reports the whole strip the IME hides, anchored to the screen
  // bottom, with the Android system-bar inset already added back.
  const keyboardOcclusion = useAppAwareKeyboardPadding();
  // One inset per screen: where a container outside this view (a trailing
  // spacer, a parent `paddingBottom`) or the wrapped content's own bottom
  // padding already reserved the bottom inset, the screen-bottom-anchored
  // occlusion must not count it a second time.
  let keyboardPadding = keyboardOcclusion;
  if (containerReservesBottomInset) {
    keyboardPadding = Math.max(keyboardOcclusion - bottom, 0);
  } else if (contentReservesBottomInset) {
    // The platform's raw metric: subtract the inset the occlusion added back.
    const systemBarInset = Platform.OS === 'android' ? bottom : 0;
    keyboardPadding = Math.max(keyboardOcclusion - systemBarInset, 0);
  }

  const resolvedKeyboardPadding = keyboardPadding > 0 ? keyboardPadding + keyboardOffset : 0;

  return <View {...props} style={[style, { paddingBottom: resolvedKeyboardPadding }]} />;
}
