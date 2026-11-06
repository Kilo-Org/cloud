/**
 * The `KeyboardAvoidingView` props a screen takes when the wrapped view does not
 * start at the window's top edge — below a screen header, or inside a modal
 * sheet.
 *
 * `automaticOffset` makes the library measure the view where the window places
 * it (its own native `viewPositionInWindow`) instead of its rect inside its
 * parent. Without it the frame is the view's rect in its parent, so a view whose
 * parent is inset from the window — the new-session form pushed over the Tour
 * modal, where the sheet starts below the window's top edge — has a bottom edge
 * the window does not share, and the lift stops short by exactly that distance:
 * the pinned footer's lower half stayed behind the software keyboard and a tap
 * at the Start control landed on the keyboard (the 2026-11-06 iOS finding, where
 * the button spanned y 517.3-561.3 against a keyboard top at 539).
 *
 * Take it wherever the wrapped view's own bottom edge may differ from the
 * window's bottom edge. A view whose container deliberately stops above that
 * edge and clears the reserved space itself keeps the parent-relative
 * measurement, as the session-detail transcript does with the navigation inset.
 */
export function keyboardAvoidingViewProps() {
  return { behavior: 'padding', automaticOffset: true } as const;
}
