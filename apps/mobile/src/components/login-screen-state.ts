import { i18n } from '@/i18n';

/**
 * Bottom padding that keeps the login content clear of both the keyboard and
 * the device's bottom bar.
 *
 * Android and iOS report the IME from different origins, and React Native has
 * no cross-platform keyboard metric measured from the screen bottom: Android's
 * `endCoordinates.height` stops at the navigation bar (`ReactRootView` reports
 * `imeInsets.bottom − barInsets.bottom`), while iOS reports the keyboard window
 * frame, which reaches the screen bottom and so already includes the
 * home-indicator inset. Adding `bottomInset` on Android is what makes the
 * reserved occlusion equal on both platforms — the capability Android lacks is
 * a metric that reaches the screen bottom, and iOS has no equivalent inset to
 * add (adding it there would float the form above the IME). With the keyboard
 * down, the inset alone keeps the content clear of the bottom bar.
 */
export function resolveKeyboardBottomPadding({
  keyboardHeight,
  bottomInset,
  platform,
}: {
  keyboardHeight: number;
  bottomInset: number;
  platform: string;
}): number {
  if (keyboardHeight > 0) {
    return platform === 'android' ? keyboardHeight + bottomInset : keyboardHeight;
  }
  return bottomInset;
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
