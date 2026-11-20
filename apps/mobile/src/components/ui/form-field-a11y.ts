/**
 * Accessibility helpers for form fields (P2-C-15b).
 *
 * React Native 0.86 has no `required` or `invalid` keys in
 * `AccessibilityState`, so required/invalid state is represented through the
 * composed `accessibilityLabel` (D16). The label reads in the order the
 * visible field presents state: label, then `required`, then the error.
 *
 * `joinAccessibleName` owns the separator rule: punctuation, never a list
 * conjunction, which would read the state as a second offered item.
 */

import { i18n } from '@/i18n';
import { joinAccessibleName } from '@/lib/a11y/accessible-name';

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
    parts.push(i18n.t('common.required'));
  }
  if (error) {
    parts.push(i18n.t('common.error', { error }));
  }
  return joinAccessibleName(parts);
}
