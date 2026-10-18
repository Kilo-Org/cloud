import { i18n } from '@/i18n';
import { MIN_BOTTOM_CHROME_HEIGHT } from '@/lib/toast-offset';

/**
 * Bottom padding that keeps the login content clear of both the keyboard and
 * the device's bottom bar.
 *
 * The height comes from the root `KeyboardProvider`
 * (`react-native-keyboard-controller`), whose metric reaches the screen bottom
 * on both platforms: on Android edge-to-edge the navigation bar is translucent,
 * so nothing is subtracted from the IME inset, and iOS reports the keyboard
 * frame, which already spans the home indicator. One rule therefore serves both
 * platforms — while the keyboard is up, reserve exactly its height.
 *
 * With the keyboard down the reported inset is not a reliable floor for the
 * chrome the platform draws over the app, so it is floored at
 * `MIN_BOTTOM_CHROME_HEIGHT` — the same rule, and the same constant, the
 * bottom-center toast uses (`lib/toast-offset.ts`). Android reports
 * `navigationBars()` only and reports `0` whenever the window does not inset
 * for the bar: in landscape the gesture bar sits on the side, so the inset is
 * `0` while the home indicator still overlaps the bottom edge. The login form's
 * last control — the OTP screen's Back button, or "More sign-in options" on the
 * landing view — was then captured with its lower half under that indicator
 * (2026-09-22 device finding). A platform that reports a larger inset still
 * wins, because the inset is floored, never replaced.
 */
export function resolveKeyboardBottomPadding({
  keyboardHeight,
  bottomInset,
}: {
  keyboardHeight: number;
  bottomInset: number;
}): number {
  if (keyboardHeight > 0) {
    return keyboardHeight;
  }
  return Math.max(bottomInset, MIN_BOTTOM_CHROME_HEIGHT);
}

export function errorMessage(status: string, fallback: string | undefined): string {
  switch (status) {
    case 'expired': {
      return i18n.t('login.signInCodeExpired');
    }
    case 'denied': {
      return i18n.t('login.accessDenied');
    }
    default: {
      return fallback ?? i18n.t('authErrors.default');
    }
  }
}
