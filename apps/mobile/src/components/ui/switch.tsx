import { Switch as NativeSwitch, Platform, type SwitchProps, useColorScheme } from 'react-native';

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
 * A disabled switch paints the muted pair instead, in the position it still
 * shows. Android folds the colours into the track and thumb drawables and only
 * sets `isEnabled`, so the platform draws no unavailable appearance of its own;
 * without this pair a row whose title dims for "not available" keeps a
 * full-strength accent track beside it and reads as both unavailable and on.
 * On keeps the grip but takes the palette's disabled primary fill, which is
 * built to hold `primaryForeground` at text contrast (5.4:1 light, 4.8:1 dark);
 * off drops to the dimmer neutral track and the mid-neutral grip. Both muted
 * tracks clear a visible step on the row's `secondary` surface (4.6:1 light,
 * 4.5:1 dark for on; 2.2:1 for off) and stay apart from each other (2.2:1
 * light, 2.1:1 dark), so a disabled switch still says which way it points.
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
  value,
  ...props
}: SwitchProps) {
  const colors = useThemeColors();
  const dark = useColorScheme() === 'dark';
  const resolvedDisabled = disabled ?? accessibilityState?.disabled;
  const inactive = resolvedDisabled === true;
  const enabledOffGrip = dark ? colors.foreground : colors.primaryForeground;
  const enabledOffTrack = dark ? colors.mutedForeground : colors.mutedSoft;
  // The on grip sits on `primary`, the off grip on the off track; the off grip
  // and track lose their strength when the control is unavailable.
  const offGrip = inactive ? colors.mutedForeground : enabledOffGrip;
  const offTrack = inactive ? colors.mutedSoft : enabledOffTrack;
  const onTrack = inactive ? colors.primaryDisabled : colors.primary;

  return (
    <NativeSwitch
      {...props}
      value={value}
      trackColor={trackColor ?? { false: offTrack, true: onTrack }}
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
