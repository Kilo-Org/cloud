import { i18n } from '@/i18n';
import { type DeviceAuthError } from '@/lib/auth/device-auth-state';
import { MIN_BOTTOM_CHROME_HEIGHT } from '@/lib/toast-offset';

/**
 * Bottom padding that keeps the login content clear of the device's bottom
 * chrome.
 *
 * The keyboard is not part of this padding: the scroll view owns the IME inset
 * itself (`KeyboardAwareScrollView`), so reserving the keyboard height here as
 * well would clear the form twice.
 *
 * The reported inset is not a reliable floor for the chrome the platform draws
 * over the app, so it is floored at `MIN_BOTTOM_CHROME_HEIGHT` — the same rule,
 * and the same constant, the bottom-center toast uses (`lib/toast-offset.ts`).
 * Android reports `navigationBars()` only and reports `0` whenever the window
 * does not inset for the bar: in landscape the gesture bar sits on the side, so
 * the inset is `0` while the home indicator still overlaps the bottom edge. The
 * login form's last control — the OTP screen's Back button, or "More sign-in
 * options" on the landing view — was then captured with its lower half under
 * that indicator (2026-09-22 device finding). A platform that reports a larger
 * inset still wins, because the inset is floored, never replaced.
 */
export function resolveBottomChromePadding({ bottomInset }: { bottomInset: number }): number {
  return Math.max(bottomInset, MIN_BOTTOM_CHROME_HEIGHT);
}

/** One form gap between stacked login controls (`gap-3`), in points. */
const FORM_GAP = 12;

/** The floor `Button` size `lg` keeps for its box regardless of the label. */
const PRIMARY_ACTION_MIN_HEIGHT = 44;

/** One line of the refusal a login form shows between a field and its action. */
const INLINE_MESSAGE_LINE = 18;

/**
 * The room the login scroller keeps between a focused field and the keyboard:
 * the primary action below the field, one form gap on each side of it, and one
 * line for the refusal a field or the code step can show above that action. The
 * action and the message are text, so both terms follow the system text scale;
 * the gaps are fixed lengths. A reserve that ignored either grew past the
 * keyboard exactly in the refusal state.
 */
export function resolveKeyboardFieldActionOffset(fontScale: number): number {
  return Math.ceil((PRIMARY_ACTION_MIN_HEIGHT + INLINE_MESSAGE_LINE) * fontScale) + FORM_GAP * 3;
}

/**
 * The banner text for a terminal device-auth error, in the active language.
 * Denied and expired are translated here from the status so a language switch
 * re-renders them; keyed descriptors translate at render the same way, and a
 * server-authored text (the start 429 body) passes through as-is.
 */
export function errorMessage(status: string, error: DeviceAuthError | undefined): string {
  switch (status) {
    case 'expired': {
      return i18n.t('login.signInCodeExpired');
    }
    case 'denied': {
      return i18n.t('login.accessDenied');
    }
    default: {
      if (!error) {
        return i18n.t('authErrors.default');
      }
      return error.kind === 'key' ? i18n.t(error.key) : error.text;
    }
  }
}
