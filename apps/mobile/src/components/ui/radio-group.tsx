import { type ReactNode } from 'react';
import { View } from 'react-native';

/**
 * Accessible single-choice group. Renders a `radiogroup` container whose
 * accessible name is the required `label` — the visible group name above
 * the list. Radio items inside must expose `checked` state via
 * `radioItemA11y`, never `selected`.
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

export type RadioItemA11y = {
  accessibilityRole: 'radio';
  accessibilityLabel: string;
  accessibilityState: {
    checked: boolean;
    disabled: boolean;
    busy: boolean;
  };
};

/**
 * Accessibility props for one radio item, spread onto a Pressable. Exposes
 * the radio role, an explicit label, and `checked`/`disabled`/`busy` state.
 * React Native radios report their current choice through `checked`, not
 * `selected`.
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
    accessibilityRole: 'radio',
    accessibilityLabel: label,
    accessibilityState: { checked, disabled, busy },
  };
}
