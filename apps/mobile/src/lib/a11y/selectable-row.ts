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
 * Role and state for a row that picks one option (`multi` false) or toggles one
 * value (`multi` true).
 *
 * iOS has no checkbox or radio trait: React Native maps both roles to
 * `UIAccessibilityTraitNone` and only folds the checked state into the element's
 * accessibility value, so VoiceOver reads such a row as plain text and offers no
 * activation. iOS therefore gets the button trait, and the row's selection rides
 * the `selected` trait. Android keeps the native checkbox and radio with their
 * checked state.
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
