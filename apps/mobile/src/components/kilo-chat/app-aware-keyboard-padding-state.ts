type KeyboardPaddingAppState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

type KeyboardPaddingEvent =
  | { type: 'keyboard-visible'; keyboardHeight: number }
  | { type: 'keyboard-hidden' }
  | { type: 'app-state-change'; appState: KeyboardPaddingAppState };

type KeyboardPaddingPlatformEvents = {
  show: 'keyboardDidShow' | 'keyboardWillShow';
  hide: 'keyboardDidHide' | 'keyboardWillHide';
};

// The one keyboard-event difference the platforms keep: Android has no
// `keyboardWillShow`/`keyboardWillHide`, so it reports the did-show pair while
// iOS reports the will-show pair that lands with the keyboard animation.
export function resolveKeyboardPaddingEventsForPlatform(
  platform: string
): KeyboardPaddingPlatformEvents | null {
  if (platform === 'android') {
    // Android does not provide keyboardWillShow/keyboardWillHide events.
    return { show: 'keyboardDidShow', hide: 'keyboardDidHide' };
  }
  if (platform === 'ios') {
    return { show: 'keyboardWillShow', hide: 'keyboardWillHide' };
  }
  return null;
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
  // iOS reports `inactive` for transient interruptions the keyboard survives —
  // Control Center, the app-switcher preview, a call banner, a system
  // permission alert — and fires no fresh `keyboardWillShow` on the way back to
  // `active`. Dropping the padding there left the resolved occlusion stuck at 0
  // under an open keyboard, so only a real backgrounding (which dismisses the
  // keyboard) clears it.
  if (event.appState === 'background') {
    return 0;
  }
  return currentPadding;
}
