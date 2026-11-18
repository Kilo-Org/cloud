/**
 * Accessibility helpers for form fields (P2-C-15b).
 *
 * React Native 0.86 has no `required` or `invalid` keys in
 * `AccessibilityState`, so required/invalid state is represented through the
 * composed `accessibilityLabel` (D16). The label reads in the order the
 * visible field presents state: label, then `required`, then the error.
 *
 * The parts are separated with punctuation, never with a list conjunction: a
 * field's state is a paused sequence after its name, and `Intl.ListFormat`
 * has no locale-independent punctuation list — `type: 'unit'` inserts a
 * connector word in French, German and Arabic and none in Chinese, so the
 * announcement would read "Anmeldecode und erforderlich". A comma is a
 * separator in every catalog language, and joining in logical order leaves the
 * display direction to the platform's bidi pass.
 */

import { i18n } from '@/i18n';

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
  return parts.join(', ');
}
