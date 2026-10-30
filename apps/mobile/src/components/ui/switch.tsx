import { Switch as NativeSwitch, Platform, type SwitchProps, useColorScheme } from 'react-native';

import { darkColors } from '@/lib/hooks/theme-colors.generated';

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
 *
 * Android fills an off switch's track from the theme's control color, which in
 * the dark theme is all but the card's own fill: the track disappears and only
 * the thumb reads, unlike the light theme, where the track stays a gray band.
 * The off track therefore takes `mutedSoft` in the dark theme — the one neutral
 * the theme guarantees differs from the card — and every other combination of
 * platform, theme and state keeps the platform colors.
 */
export function Switch({ disabled, accessibilityState, trackColor, ...props }: SwitchProps) {
  const resolvedDisabled = disabled ?? accessibilityState?.disabled;
  const colorScheme = useColorScheme();
  const darkOffTrack =
    Platform.OS === 'android' && colorScheme === 'dark' ? darkColors.mutedSoft : undefined;
  const resolvedTrackColor =
    darkOffTrack === undefined ? trackColor : { ...trackColor, false: darkOffTrack };

  return (
    <NativeSwitch
      {...props}
      trackColor={resolvedTrackColor}
      disabled={resolvedDisabled}
      accessibilityState={
        Platform.OS === 'ios'
          ? { ...accessibilityState, disabled: resolvedDisabled }
          : accessibilityState
      }
    />
  );
}
