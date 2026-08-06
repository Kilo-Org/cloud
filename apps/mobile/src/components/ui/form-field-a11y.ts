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
