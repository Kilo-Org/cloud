import { keyboardInsetOffset } from '@/lib/keyboard-inset-offset';

/**
 * The `KeyboardAvoidingView` props a screen takes when the wrapped content pads
 * the platform's bottom inset itself and the wrapped view does not start at the
 * window's top edge.
 *
 * `automaticOffset` makes the library measure the view's frame where the window
 * places it. Without it the frame is the view's rect inside its parent, so a
 * view that sits below a screen header has a bottom edge the window does not
 * share, and the lift stops short of the keyboard by that distance: the pinned
 * footer's lower half stays behind the keyboard, and a tap at its centre lands
 * on the keyboard instead of the control (the 2026-11-06 iOS new-session
 * finding, where the pinned Start control straddled the keyboard's top edge).
 *
 * `keyboardVerticalOffset` stays a separate correction: Android reports the IME
 * height across the translucent navigation bar, so a surface that pads its own
 * bottom inset reduces the lift by that inset (`keyboardInsetOffset`).
 */
export function keyboardAvoidingViewProps(bottomInset: number) {
  return {
    behavior: 'padding',
    automaticOffset: true,
    keyboardVerticalOffset: keyboardInsetOffset(bottomInset),
  } as const;
}
