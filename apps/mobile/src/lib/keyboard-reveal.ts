import {
  type MeasureInWindowOnSuccessCallback,
  type ScrollViewInstance,
  TextInput,
} from 'react-native';

/**
 * Scrolls the scrollable so the focused input clears the keyboard — the same
 * adjustment the scroll view makes natively when a field gains focus, applied
 * after a keyboard re-layout that the native path does not cover (a rotation
 * while the field stays focused). No-op without focus or a mounted scroll view,
 * and a no-op when the focused field already clears the keyboard.
 */
export function scrollFocusedInputAboveKeyboard(scrollable: {
  current: ScrollViewInstance | null;
  /** The scroll offset the scroll view reports through its own onScroll. */
  offsetRef: { current: number };
  /** The keyboard's occlusion height, `0` when it is down. */
  occlusionRef: { current: number };
  /** The window height the overlap math measures against. */
  windowHeight: number;
}): void {
  const scrollView = scrollable.current;
  if (!scrollView) {
    return;
  }
  // RN's d.ts types the return as always `HostInstance`, but the runtime
  // returns `null` with no field focused (TextInputState.js) — the widening
  // assertion carries the real contract.
  const focused = TextInput.State.currentlyFocusedInput() as {
    measureInWindow: (callback: MeasureInWindowOnSuccessCallback) => void;
  } | null;
  if (!focused) {
    return;
  }
  // MeasureInWindowOnSuccessCallback is positional (x, y, width, height); the
  // rest tuple keeps the lint param cap without renaming semantics.
  const onMeasured: MeasureInWindowOnSuccessCallback = (...[, y, , height]) => {
    const keyboardTop = scrollable.windowHeight - scrollable.occlusionRef.current;
    const overlap = y + height - keyboardTop;
    if (overlap > 0) {
      scrollView.scrollTo({ y: scrollable.offsetRef.current + overlap, animated: true });
    }
  };
  focused.measureInWindow(onMeasured);
}
