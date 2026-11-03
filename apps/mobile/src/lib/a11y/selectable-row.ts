import { type AccessibilityRole, type AccessibilityState, Platform } from 'react-native';

type SelectableRowA11y = {
  accessibilityRole: AccessibilityRole;
  accessibilityState: AccessibilityState;
};

type SelectableRowOptions = {
  /** True for a checkbox row that toggles values, false for a single-choice radio row. */
  multi: boolean;
  selected: boolean;
  disabled?: boolean;
  busy?: boolean;
};

/**
 * React Native maps iOS checkbox/radio roles to no native trait. Use button
 * and selected traits there; retain checkbox/radio and checked on Android.
 */
export function selectableRowA11y({
  multi,
  selected,
  disabled,
  busy,
}: Readonly<SelectableRowOptions>): SelectableRowA11y {
  const isIOS = Platform.OS === 'ios';
  const accessibilityState: AccessibilityState = isIOS ? { selected } : { checked: selected };
  if (disabled !== undefined) {
    accessibilityState.disabled = disabled;
  }
  if (busy !== undefined) {
    accessibilityState.busy = busy;
  }
  if (isIOS) {
    return { accessibilityRole: 'button', accessibilityState };
  }
  return { accessibilityRole: multi ? 'checkbox' : 'radio', accessibilityState };
}
