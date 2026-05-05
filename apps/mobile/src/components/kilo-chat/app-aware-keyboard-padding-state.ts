type KeyboardPaddingAppState = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';

type KeyboardPaddingEvent =
  | { type: 'keyboard-visible'; keyboardHeight: number }
  | { type: 'keyboard-hidden' }
  | { type: 'app-state-change'; appState: KeyboardPaddingAppState };

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
