import { type RefObject, useEffect, useRef } from 'react';
import { type ScrollView } from 'react-native';

import { useAppAwareKeyboardPadding } from './app-aware-keyboard-padding';

/** One frame's grace for the keyboard padding to reach the scroll view. */
export const KEYBOARD_REVEAL_RETRY_MS = 80;

/**
 * Keeps a scroll view's trailing call-to-action reachable while the software
 * keyboard is open, returning the ref to attach to that scroll view.
 *
 * Android is the exposed case: under API 35+ edge-to-edge the window never
 * resizes for the IME and `automaticallyAdjustKeyboardInsets` is iOS-only, so
 * a form whose submit button is its last child keeps that button under the
 * keyboard. A screen that reserves the keyboard's height (e.g. with
 * `AppAwareKeyboardPaddingView`) makes the form scrollable, but nothing scrolls
 * it; this reveals the end, where the call-to-action lives, as the keyboard
 * comes up.
 *
 * The retry covers the frame the reserved padding lands on, when the first
 * scroll is still a no-op against the pre-lift viewport (the same one-frame
 * race the chat message list handles with its own scheduler).
 */
export function useRevealEndOnKeyboard(): RefObject<ScrollView | null> {
  const scrollRef = useRef<ScrollView>(null);
  const keyboardPadding = useAppAwareKeyboardPadding();

  useEffect(() => {
    if (keyboardPadding === 0) {
      return undefined;
    }
    const revealCallToAction = () => {
      scrollRef.current?.scrollToEnd({ animated: false });
    };
    revealCallToAction();
    const retry = setTimeout(revealCallToAction, KEYBOARD_REVEAL_RETRY_MS);
    return () => {
      clearTimeout(retry);
    };
  }, [keyboardPadding]);

  return scrollRef;
}
