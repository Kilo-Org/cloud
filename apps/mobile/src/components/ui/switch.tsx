import { Switch as NativeSwitch, Platform, type SwitchProps } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The native `Switch`, painted with the app palette, with its disabled state
 * mirrored into `accessibilityState`.
 *
 * Untinted, the control draws its on-track with the platform accent, a
 * saturated teal on Android that belongs to no palette entry. In a list row
 * that outranks the row title and the screen's own button, so the track takes
 * the scheme's `primary` and the grip its `primaryForeground`, which keeps the
 * two legible against each other in light and dark. The off-track uses the
 * muted grey rather than the accent, because a control that is off should
 * recede. A caller that wants another pair still wins: its own props are
 * applied last.
 *
 * Fabric derives the accessibility traits from the role and
 * `accessibilityState`, then assigns them to the native control, replacing the
 * traits the control reports for itself. React Native's iOS bridge passes
 * `disabled` but not the matching state, so a switch that cannot be toggled
 * still announces itself as enabled. Android already folds `disabled` into that
 * state; doing it here keeps both platforms honest.
 */
export function Switch({
  disabled,
  accessibilityState,
  trackColor,
  thumbColor,
  ...props
}: SwitchProps) {
  const colors = useThemeColors();
  const resolvedDisabled = disabled ?? accessibilityState?.disabled;

  return (
    <NativeSwitch
      {...props}
      trackColor={trackColor ?? { false: colors.mutedSoft, true: colors.primary }}
      thumbColor={thumbColor ?? (Platform.OS === 'android' ? colors.primaryForeground : undefined)}
      disabled={resolvedDisabled}
      accessibilityState={
        Platform.OS === 'ios'
          ? { ...accessibilityState, disabled: resolvedDisabled }
          : accessibilityState
      }
    />
  );
}
