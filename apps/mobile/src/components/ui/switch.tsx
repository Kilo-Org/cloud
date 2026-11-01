import { Switch as NativeSwitch, Platform, type SwitchProps, useColorScheme } from 'react-native';

import { TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The native `Switch`, painted with the app palette, with its disabled state
 * mirrored into `accessibilityState`.
 *
 * Untinted, the control draws its on-track with the platform accent, a
 * saturated teal on Android that belongs to no palette entry. In a list row
 * that outranks the row title and the screen's own button, so the track takes
 * the scheme's `primary` and the grip its `primaryForeground`, which keeps the
 * two legible against each other in light and dark.
 *
 * The off pair follows the scheme as well, because a grip that always takes
 * `primaryForeground` is near-black in dark mode and vanishes into the off
 * track. Off draws a light grip on a lighter track, so the control still reads
 * as a control while it says off: `mutedSoft` with a white grip in light,
 * `mutedForeground` with a `foreground` grip in dark. A caller that wants
 * another pair still wins: its own props are applied last.
 *
 * Fabric derives the accessibility traits from the role and
 * `accessibilityState`, then assigns them to the native control, replacing the
 * traits the control reports for itself. React Native's iOS bridge passes
 * `disabled` but not the matching state, so a switch that cannot be toggled
 * still announces itself as enabled. Android already folds `disabled` into that
 * state; doing it here keeps both platforms honest.
 *
 * The control draws at the platform's own size — about 46.5x27dp on Android,
 * 51x31pt on iOS — which is under `DESIGN.md:364`'s 44pt touch target, and the
 * audit reads the control's own node rect, so a caller's row or `hitSlop` does
 * not lift it. Every caller gets the target here instead: the node renders at
 * least {@link TOUCH_TARGET_DP} on both axes and a caller's `style` is applied
 * last, so a row grows to the control it hosts rather than the control
 * shrinking to the row.
 */
export function Switch({
  disabled,
  accessibilityState,
  trackColor,
  thumbColor,
  value,
  style,
  ...props
}: SwitchProps) {
  const colors = useThemeColors();
  const dark = useColorScheme() === 'dark';
  const resolvedDisabled = disabled ?? accessibilityState?.disabled;
  // The on grip sits on `primary`, the off grip on the off track.
  const offGrip = dark ? colors.foreground : colors.primaryForeground;

  return (
    <NativeSwitch
      {...props}
      style={[{ minHeight: TOUCH_TARGET_DP, minWidth: TOUCH_TARGET_DP }, style]}
      value={value}
      trackColor={
        trackColor ?? {
          false: dark ? colors.mutedForeground : colors.mutedSoft,
          true: colors.primary,
        }
      }
      thumbColor={thumbColor ?? (value ? colors.primaryForeground : offGrip)}
      disabled={resolvedDisabled}
      accessibilityState={
        Platform.OS === 'ios'
          ? { ...accessibilityState, disabled: resolvedDisabled }
          : accessibilityState
      }
    />
  );
}
