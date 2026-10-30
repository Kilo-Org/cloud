import { Switch as NativeSwitch, Platform, type SwitchProps } from 'react-native';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The native `Switch` with its disabled state mirrored into
 * `accessibilityState`, and themed track and thumb colours.
 *
 * Fabric derives the accessibility traits from the role and
 * `accessibilityState`, then assigns them to the native control, replacing the
 * traits the control reports for itself. React Native's iOS bridge passes
 * `disabled` but not the matching state, so a switch that cannot be toggled
 * still announces itself as enabled. Android already folds `disabled` into that
 * state; doing it here keeps both platforms honest.
 *
 * The track and thumb default to the theme for the same reason the app themes
 * every other control: the platform's own track is drawn from a system colour,
 * which in the dark scheme sits within 1.11:1 of `--card` (measured on the
 * Android dark cell: track #0a0a0b on card #17171a), so an off switch loses
 * its track and shows a thumb floating on nothing. The themed track keeps the
 * switch readable in both schemes — the off track contrasts ≥4.9:1 with the
 * card, and the thumb ≥4.8:1 with both track states — while the on track keeps
 * the brand fill a switch is expected to show. A caller that needs different
 * colours still passes `trackColor` or `thumbColor` and keeps them.
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
      disabled={resolvedDisabled}
      trackColor={trackColor ?? { false: colors.mutedForeground, true: colors.primary }}
      thumbColor={thumbColor ?? colors.card}
      accessibilityState={
        Platform.OS === 'ios'
          ? { ...accessibilityState, disabled: resolvedDisabled }
          : accessibilityState
      }
    />
  );
}
