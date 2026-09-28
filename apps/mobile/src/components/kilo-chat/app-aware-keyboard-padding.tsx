import { type ComponentProps, useEffect, useState } from 'react';
import { AppState, Dimensions, Keyboard, type KeyboardEvent, Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { resolveKeyboardBottomPadding } from '@/components/login-screen-state';
import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from './app-aware-keyboard-padding-state';

/**
 * The platform's own keyboard metric, in the coordinates the IME event reports
 * it in. This is the one platform capability that differs, and it is the
 * metric's origin: Android edge-to-edge reports the visible-frame height with
 * the bottom system-bar inset already subtracted (`ReactRootView` reports
 * `imeInsets.bottom − barInsets.bottom`), so the metric stops at the navigation
 * bar; iOS reports the keyboard frame in screen coordinates.
 *
 * A keyboard docked to the screen bottom reaches it, so the distance from the
 * keyboard top to the screen bottom is its own height. An undocked (floating or
 * split) iPad keyboard sits above the bottom, where that distance counts the
 * uncovered screen below it — hundreds of points — and overstates the lift the
 * shared keyboard view applies. Clamping the overlap to the reported frame
 * height keeps the docked metric and caps a floating keyboard at the strip it
 * actually hides (2026-09-22 review finding). An event that carries no screen
 * position falls back to the reported height too.
 */
function keyboardPaddingFromEvent(event: KeyboardEvent): number {
  if (Platform.OS === 'android') {
    return event.endCoordinates.height;
  }
  const keyboardTop = event.endCoordinates.screenY;
  if (!Number.isFinite(keyboardTop)) {
    return event.endCoordinates.height;
  }
  return Math.min(Dimensions.get('screen').height - keyboardTop, event.endCoordinates.height);
}

/**
 * The platform's reported keyboard metric while the keyboard is up, `0` while
 * it is down. Both platforms resolve the strip it hides through the same
 * `resolveKeyboardBottomPadding`; the metric's origin each of them reports from
 * is the one platform capability that differs (see `keyboardPaddingFromEvent`).
 *
 * This is the app's one keyboard read (`keyboardWillShow` on iOS,
 * `keyboardDidShow` on Android, where the window never resizes for the IME
 * under API 35+).
 */
function useReportedKeyboardHeight(): number {
  const [reportedHeight, setReportedHeight] = useState(0);

  useEffect(() => {
    const keyboardEvents = resolveKeyboardPaddingEventsForPlatform(Platform.OS);
    if (keyboardEvents === null) {
      setReportedHeight(0);
      return undefined;
    }

    const keyboardShowSubscription = Keyboard.addListener(keyboardEvents.show, event => {
      setReportedHeight(currentPadding =>
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
      setReportedHeight(currentPadding =>
        resolveAppAwareKeyboardPadding({
          currentPadding,
          event: { type: 'keyboard-hidden' },
        })
      );
    });
    const appStateSubscription = AppState.addEventListener('change', appState => {
      setReportedHeight(currentPadding =>
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

  return reportedHeight;
}

/**
 * The strip the IME hides from the screen bottom — its reported height plus the
 * bottom system-bar inset on Android, the screen overlap on iOS — and `0` while
 * the keyboard is down.
 *
 * Both platforms resolve it through the same `resolveKeyboardBottomPadding`,
 * the one implementation of the rule: Android's reported metric stops at the
 * navigation bar, while iOS's reaches the screen bottom, and that capability is
 * named there. Exported so a screen that must react to the keyboard beyond
 * reserving its height — a pinned footer measuring its own clearance — reads the
 * same lift `AppAwareKeyboardPaddingView` applies instead of adding a second
 * listener.
 */
export function useAppAwareKeyboardPadding(): number {
  const { bottom } = useSafeAreaInsets();
  const reportedHeight = useReportedKeyboardHeight();
  // `resolveKeyboardBottomPadding` reserves the bottom chrome alone at rest;
  // this view reserves nothing until the keyboard is up.
  return reportedHeight > 0
    ? resolveKeyboardBottomPadding({
        keyboardHeight: reportedHeight,
        bottomInset: bottom,
        platform: Platform.OS,
      })
    : 0;
}

/**
 * The keyboard's raw height and the occlusion it reserves at the screen bottom,
 * `0` while the keyboard is down.
 *
 * The two platforms measure the IME from different origins: Android's stops at
 * the navigation bar (`ReactRootView` reports `imeInsets.bottom −
 * barInsets.bottom`) while iOS's frame reaches the screen bottom. The reserved
 * space is anchored to the screen bottom, and `useAppAwareKeyboardPadding`
 * already reports it that way (`resolveKeyboardBottomPadding`: the raw height
 * plus the Android system-bar inset; padding by the raw Android height left the
 * manual review form's Start button behind the IME's navigation row,
 * 2026-09-20). The raw platform metric is therefore the reported height the one
 * keyboard read holds, and it is `0` while the keyboard is down. A caller that
 * reserves the keyboard's height in its own layout (a surface inset) reads the
 * occlusion from here; the padded view below also needs the raw metric.
 */
export function useKeyboardOcclusion() {
  const { bottom } = useSafeAreaInsets();
  const keyboardHeight = useReportedKeyboardHeight();
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
    // The platform's raw metric, which the content's own inset padding
    // completes.
    keyboardPadding = keyboardHeight;
  }

  const resolvedKeyboardPadding = keyboardPadding > 0 ? keyboardPadding + keyboardOffset : 0;

  return <View {...props} style={[style, { paddingBottom: resolvedKeyboardPadding }]} />;
}
