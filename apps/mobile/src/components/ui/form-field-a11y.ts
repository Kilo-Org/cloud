/**
 * Accessibility helpers for form fields (P2-C-15b).
 *
 * React Native 0.86 has no `required` or `invalid` keys in
 * `AccessibilityState`, so required/invalid state is represented through the
 * composed `accessibilityLabel` (D16). The label reads in the order the
 * visible field presents state: label, then `required`, then the error.
 */

export function formFieldA11y({
  label,
  required,
  error,
}: Readonly<{
  label: string;
  required?: boolean;
  error?: string | null;
}>): string {
  const parts = [label];
  if (required) {
    parts.push('required');
  }
  if (error) {
    parts.push(`error: ${error}`);
  }
  return parts.join(', ');
}

/** A ref to a mounted focusable field; `current` is null when unmounted. */
export type FocusableFieldRef = {
  readonly current: { focus: () => void } | null;
};

/**
 * Focus the first invalid field the form owner passed in, skipping fields
 * that are not currently mounted. The form owner decides which fields are
 * invalid and passes their refs in visible order (parent-owned validation).
 * Returns `true` when a field was focused, so callers can distinguish a
 * successful focus move from an all-unmounted list.
 */
export function focusFirstInvalid(fields: readonly FocusableFieldRef[]): boolean {
  for (const field of fields) {
    const node = field.current;
    if (node != null) {
      node.focus();
      return true;
    }
  }
  return false;
}
