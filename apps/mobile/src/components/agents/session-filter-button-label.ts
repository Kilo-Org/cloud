/**
 * Spoken name for the filter affordance: the title, plus the applied-filter
 * count while filters are active. The count is part of the name on purpose —
 * the accessible name must always state exactly what the visible badge states,
 * and it must fall back to the bare title when the list is no longer narrowed.
 *
 * The count is appended to the *label* rather than exposed as an Android
 * `accessibilityValue`: removing a value prop does not clear the text the
 * native view already wrote into its content description, so a cleared filter
 * could keep being announced while the badge is gone.
 */
export function filterButtonAccessibilityLabel(title: string, activeCount: number): string {
  return activeCount > 0 ? `${title}, ${activeCount}` : title;
}
