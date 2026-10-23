import { Switch as NativeSwitch, Platform, type SwitchProps } from 'react-native';

/**
 * The native `Switch` with its disabled state mirrored into
 * `accessibilityState`.
 *
 * Fabric derives the accessibility traits from the role and
 * `accessibilityState`, then assigns them to the native control, replacing the
 * traits the control reports for itself. React Native's iOS bridge passes
 * `disabled` but not the matching state, so a switch that cannot be toggled
 * still announces itself as enabled. Android already folds `disabled` into that
 * state; doing it here keeps both platforms honest.
 */
export function Switch({ disabled, accessibilityState, ...props }: SwitchProps) {
  const resolvedDisabled = disabled ?? accessibilityState?.disabled;

  return (
    <NativeSwitch
      {...props}
      disabled={resolvedDisabled}
      accessibilityState={
        Platform.OS === 'ios'
          ? { ...accessibilityState, disabled: resolvedDisabled }
          : accessibilityState
      }
    />
  );
}
