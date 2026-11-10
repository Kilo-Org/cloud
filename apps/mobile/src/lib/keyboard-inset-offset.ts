import { Platform } from 'react-native';

/**
 * The `keyboardVerticalOffset` that stops a keyboard lift covering a bottom
 * inset the wrapped content already pads itself.
 *
 * `react-native-keyboard-controller` lifts by the overlap between the keyboard
 * and the view's own bottom edge, and on Android edge-to-edge its reported
 * height is the full IME inset: the app keeps the navigation bar translucent, so
 * the native metric subtracts nothing. A surface whose content pads the platform
 * inset on its own must therefore reduce the lift by that inset, or the content
 * floats a navigation-bar height above the keyboard (the 2026-09-20 composer
 * finding and the 2026-09-21 discussion-CTA finding). iOS reports the keyboard
 * frame, which stops at the screen bottom, so no correction is due there.
 *
 * The lift is `overlap + keyboardVerticalOffset`, so the correction is negative.
 */
export function keyboardInsetOffset(bottomInset: number): number {
  return Platform.OS === 'android' ? -bottomInset : 0;
}

/**
 * The gap the pinned footer keeps between its last control and the software
 * keyboard once the keyboard is up.
 *
 * A lift already clears everything the keyboard covers, so a footer that pads
 * the platform inset on its own must not reserve it a second time above the
 * keyboard: on iOS that inset is the home indicator, which the keyboard frame
 * covers, and on Android the app-aware offset above already subtracted the
 * navigation-bar strip from the lift. Either way the footer ends at this gap
 * instead of a navigation-bar height away from the keys, and the composer keeps
 * the room. Interpolate the padding on the keyboard's own progress so the
 * inset and the lift move in one transition, as the chat composer's inset does.
 */
export const KEYBOARD_FOOTER_GAP = 16;
