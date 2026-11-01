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
 * the palette's olive accent and the grip its foreground, which keeps the two
 * legible against each other in light and dark.
 *
 * The olive is `primary` in light and `selection` in dark: dark's `primary`
 * is the brand yellow (#ffdd00), which glares on the near-black page and pulls
 * the eye harder than the row title it sits beside, so dark takes the muted
 * olive the palette keeps for the same theme (`selection`, #4f5a10 — the light
 * primary's own hue) rather than the accent.
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
 * iOS is left alone: UIKit fades a disabled `UISwitch` itself, so painting the
 * muted pair there would dim the control twice. Android is the platform that
 * needs the pair, and only it takes it.
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
  // Only Android needs the muted pair: iOS fades a disabled `UISwitch` itself.
  const inactive = resolvedDisabled === true && Platform.OS === 'android';
  // The on pair is the olive accent at the luminance its grip needs: light
  // fills with `primary`, dark with the muted olive `selection`.
  const enabledOnTrack = dark ? colors.selection : colors.primary;
  const enabledOnGrip = dark ? colors.selectionForeground : colors.primaryForeground;
  const enabledOffGrip = dark ? colors.foreground : colors.primaryForeground;
  const enabledOffTrack = dark ? colors.mutedForeground : colors.mutedSoft;
  // The off grip sits on the off track; the grip and track lose their strength
  // when the control is unavailable, and the on track takes the disabled fill.
  const offGrip = inactive ? colors.mutedForeground : enabledOffGrip;
  const offTrack = inactive ? colors.mutedSoft : enabledOffTrack;
  const onTrack = inactive ? colors.primaryDisabled : enabledOnTrack;
  const onGrip = inactive ? colors.primaryForeground : enabledOnGrip;

  return (
    <NativeSwitch
      {...props}
      style={[{ minHeight: TOUCH_TARGET_DP, minWidth: TOUCH_TARGET_DP }, style]}
      value={value}
      trackColor={trackColor ?? { false: offTrack, true: onTrack }}
      thumbColor={thumbColor ?? (value ? onGrip : offGrip)}
      disabled={resolvedDisabled}
      accessibilityState={
        Platform.OS === 'ios'
          ? { ...accessibilityState, disabled: resolvedDisabled }
          : accessibilityState
      }
    />
  );
}
