/**
 * Bottom-center toasts are anchored to the safe-area inset, but Android draws
 * more than that inset over the app. The reported bottom inset is only
 * `WindowInsets.Type.navigationBars()`, and while a text input holds focus the
 * IME's navigation row (hide-keyboard chevron / show-keyboard control) sits
 * above the gesture bar without growing that inset. A toast anchored to the
 * inset alone then lands with its last line under that row, which is how the
 * manual-review error toast was captured with its final glyph row clipped at
 * the bottom edge (2026-09-18 device finding).
 *
 * Android's navigation bar is a platform constant in its tallest standard
 * configuration (3-button mode, 48dp), and the app already carries platform
 * metrics as constants (`tab-bar-layout.ts`). Flooring the toast's clearance at
 * it keeps the toast above whatever bottom chrome is on screen; the reported
 * inset wins when it is larger (taskbar/landscape devices).
 *
 * The in-app tab bar is bottom chrome too, and taller than the navigation bar:
 * it floats as an absolute overlay over the screen bottom, so the reported
 * inset does not include it and a toast anchored to the inset landed over the
 * tab icons (2026-09-19 visual spot check, p1). When a tab bar is on screen it
 * wins as the tallest chrome; the keyboard still wins while it is up.
 */
export const ANDROID_NAVIGATION_BAR_HEIGHT = 48;

/** sonner-native's own gap above the safe-area inset. */
export const TOAST_BOTTOM_GAP = 8;

/** sonner-native's fallback when no safe-area inset is known. */
const TOAST_BOTTOM_FALLBACK = 16;

/**
 * Bottom offset, in logical pixels, for the bottom-center toast container.
 * The keyboard height wins while the software keyboard is up so the toast
 * cannot hide behind it; otherwise the tallest bottom chrome decides: the
 * floating tab bar when one is on screen, else the safe-area inset (floored
 * on Android). The standard gap always separates the toast from the chrome.
 */
export function getToastBottomOffset({
  platform,
  safeAreaBottom,
  keyboardHeight,
  tabBarHeight = 0,
}: {
  platform: string;
  safeAreaBottom: number;
  keyboardHeight: number;
  /** Rendered height of the floating tab bar while one is on screen, `0` otherwise. */
  tabBarHeight?: number;
}): number {
  const bottomInset = Math.max(safeAreaBottom, 0);
  const chrome =
    platform === 'android' ? Math.max(bottomInset, ANDROID_NAVIGATION_BAR_HEIGHT) : bottomInset;
  const resting = chrome > 0 ? chrome + TOAST_BOTTOM_GAP : TOAST_BOTTOM_FALLBACK;
  const overTabBar = tabBarHeight > 0 ? tabBarHeight + TOAST_BOTTOM_GAP : Number.NEGATIVE_INFINITY;
  const withKeyboard =
    keyboardHeight > 0 ? keyboardHeight + TOAST_BOTTOM_GAP : Number.NEGATIVE_INFINITY;
  return Math.max(resting, overTabBar, withKeyboard);
}
