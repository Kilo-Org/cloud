import { type ReactNode } from 'react';
import { type AccessibilityRole, type AccessibilityState, View } from 'react-native';

import { selectableRowA11y } from '@/lib/a11y/selectable-row';

/**
 * Accessible single-choice group. Renders a `radiogroup` container whose
 * accessible name is the required `label` — the visible group name above
 * the list. Radio items inside must expose their selection via
 * `radioItemA11y`.
 */
export function RadioGroup({
  label,
  children,
  className,
}: Readonly<{
  /** The visible group name; also the container's accessible label. */
  label: string;
  children: ReactNode;
  className?: string;
}>) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} className={className}>
      {children}
    </View>
  );
}

type RadioItemA11y = {
  accessibilityRole: AccessibilityRole;
  accessibilityLabel: string;
  accessibilityState: AccessibilityState;
};

/**
 * Accessibility props for one radio item, spread onto a Pressable. Exposes the
 * radio role on Android, an explicit label, and `checked`/`disabled`/`busy`
 * state. `selectableRowA11y` maps the row onto a button with the `selected`
 * trait on iOS, where React Native has no radio trait.
 */
export function radioItemA11y({
  label,
  checked,
  disabled = false,
  busy = false,
}: Readonly<{
  label: string;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
}>): RadioItemA11y {
  return {
    accessibilityLabel: label,
    ...selectableRowA11y({ multi: false, selected: checked, disabled, busy }),
  };
}
