/**
 * Bottom-center toasts are anchored to the safe-area inset, but the reported
 * inset is not a reliable floor for the chrome the platform draws over the
 * app's own content. On Android it is only
 * `WindowInsets.Type.navigationBars()`: an inset of `0` is reported whenever
 * the window does not inset for the bar, and while a text input holds focus the
 * IME's navigation row (hide-keyboard chevron / show-keyboard control) sits
 * above the gesture bar without growing that inset. A toast anchored to the
 * inset alone then lands with its last line under that chrome, which is how the
 * manual-review error toast was captured with its final glyph row clipped at
 * the bottom edge (2026-09-18 device finding).
 *
 * One floor serves both platforms rather than an Android-only branch: the
 * tallest bottom chrome either platform draws is Android's navigation bar / IME
 * navigation row (48dp) and iOS's home indicator (34pt), so flooring the
 * reported inset at the taller of the two clears both with a single rule. A
 * platform that reports a larger inset (taskbar, landscape) still wins, because
 * the inset is floored, never replaced.
 *
 * The in-app tab bar is bottom chrome too, and taller than the navigation bar:
 * it floats as an absolute overlay over the screen bottom, so the reported
 * inset does not include it and a toast anchored to the inset landed over the
 * tab icons (2026-09-19 visual spot check, p1). When a tab bar is on screen it
 * wins as the tallest chrome; the keyboard still wins while it is up.
 */
export const MIN_BOTTOM_CHROME_HEIGHT = 48;

/** sonner-native's own gap above the safe-area inset. */
export const TOAST_BOTTOM_GAP = 8;

/**
 * Bottom offset, in logical pixels, for the bottom-center toast container.
 * The keyboard height wins while the software keyboard is up so the toast
 * cannot hide behind it; otherwise the tallest bottom chrome decides: the
 * floating tab bar when one is on screen, else the reported safe-area inset
 * floored at `MIN_BOTTOM_CHROME_HEIGHT`. The standard gap always separates the
 * toast from the chrome.
 */
export function getToastBottomOffset({
  safeAreaBottom,
  keyboardHeight,
  tabBarHeight = 0,
}: {
  safeAreaBottom: number;
  keyboardHeight: number;
  /** Rendered height of the floating tab bar while one is on screen, `0` otherwise. */
  tabBarHeight?: number;
}): number {
  const bottomInset = Math.max(safeAreaBottom, 0);
  const chrome = Math.max(bottomInset, MIN_BOTTOM_CHROME_HEIGHT);
  const resting = chrome + TOAST_BOTTOM_GAP;
  const overTabBar = tabBarHeight > 0 ? tabBarHeight + TOAST_BOTTOM_GAP : Number.NEGATIVE_INFINITY;
  const withKeyboard =
    keyboardHeight > 0 ? keyboardHeight + TOAST_BOTTOM_GAP : Number.NEGATIVE_INFINITY;
  return Math.max(resting, overTabBar, withKeyboard);
}
