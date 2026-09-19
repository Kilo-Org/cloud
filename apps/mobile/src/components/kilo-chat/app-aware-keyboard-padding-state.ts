type KeyboardPaddingAppState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

type KeyboardPaddingEvent =
  | { type: 'keyboard-visible'; keyboardHeight: number }
  | { type: 'keyboard-hidden' }
  | { type: 'app-state-change'; appState: KeyboardPaddingAppState };

type KeyboardPaddingPlatformEvents = {
  show: 'keyboardDidShow' | 'keyboardWillShow';
  hide: 'keyboardDidHide' | 'keyboardWillHide';
};

export function resolveKeyboardPaddingEventsForPlatform(
  platform: string
): KeyboardPaddingPlatformEvents | null {
  if (platform === 'android') {
    return { show: 'keyboardDidShow', hide: 'keyboardDidHide' };
  }
  if (platform === 'ios') {
    return { show: 'keyboardWillShow', hide: 'keyboardWillHide' };
  }
  return null;
}

/**
 * Height to reserve from the window's bottom edge while the keyboard is open.
 *
 * Android reports the IME frame stopping above the system bar — ReactRootView
 * sends `imeInsets.bottom − barInsets.bottom` and exposes no keyboard-top
 * coordinate (`endCoordinates.screenY` is the visible display frame's bottom) —
 * so the system-bar inset is added back to reach the keyboard's top edge. iOS
 * reports the keyboard frame down to the window bottom, so its height already
 * contains the home-indicator inset and adding it there would double-count. The
 * reported geometry is the platform capability that differs; the caller keeps
 * one padding path for both platforms.
 */
export function resolveKeyboardBottomOcclusionForPlatform({
  platform,
  keyboardHeight,
  systemBarInset,
}: {
  platform: string;
  keyboardHeight: number;
  systemBarInset: number;
}): number {
  if (keyboardHeight <= 0) {
    return 0;
  }
  if (platform === 'android') {
    return keyboardHeight + systemBarInset;
  }
  return keyboardHeight;
}

export function resolveAppAwareKeyboardPadding({
  currentPadding,
  event,
}: {
  currentPadding: number;
  event: KeyboardPaddingEvent;
}): number {
  if (event.type === 'keyboard-visible') {
    return Math.max(event.keyboardHeight, 0);
  }
  if (event.type === 'keyboard-hidden') {
    return 0;
  }
  if (event.appState !== 'active') {
    return 0;
  }
  return currentPadding;
}
