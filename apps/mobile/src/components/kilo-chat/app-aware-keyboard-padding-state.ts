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
