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
 * olive the palette keeps for the same theme (`selection` — the light primary's
 * hue, lifted for the dark page) rather than the accent.
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
 * On takes the palette's disabled primary fill and a grip that sits below it in
 * strength; off drops to the dimmer neutral track and the mid-neutral grip.
 * Both muted tracks clear a visible step on the row's `secondary` surface
 * (4.6:1 light, 4.5:1 dark for on; 2.2:1 for off) and stay apart from each
 * other (2.2:1 light, 2.1:1 dark), so a disabled switch still says which way it
 * points.
 *
 * The disabled on grip is the one thing a disabled pair cannot share with its
 * enabled one. Enabled, the grip is the scheme's light ink (`primaryForeground`
 * in light, `selectionForeground` in dark) on the accent fill, and that is the
 * signal of a working control. Kept there when disabled, a near-white thumb on
 * the muted fill reads as switched on and glares on a row the user cannot
 * change — the complaint that the read-only switches look active. Dropped to
 * `primaryForeground` instead, as both schemes once did, dark paints the thumb
 * the card's own near-black: Android's thumb is wider than the track, so its
 * outer arc sits on the row rather than on the fill, 1.1:1 there, and the dark
 * scheme draws no shadow to outline it — the right end of the pill dissolves
 * and what is left reads as a blank grey bar. Dark therefore takes
 * `mutedSoft`, the mid neutral its off track already uses: a dark thumb on the
 * light disabled fill, 2.1:1 against the fill and 2.2:1 against the row, muted
 * beside the olive of a control that works. Light keeps the white grip, which
 * already reads as a muted fill under a plain thumb.
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
  // The on grip leaves the scheme's on ink as well: a light thumb on the muted
  // fill reads as a working control. Dark takes the mid neutral, a dark thumb
  // on the light disabled fill, which keeps the thumb's overhanging arc off the
  // row's own near-black; light keeps its white grip.
  const offGrip = inactive ? colors.mutedForeground : enabledOffGrip;
  const offTrack = inactive ? colors.mutedSoft : enabledOffTrack;
  const onTrack = inactive ? colors.primaryDisabled : enabledOnTrack;
  const disabledOnGrip = dark ? colors.mutedSoft : colors.primaryForeground;
  const onGrip = inactive ? disabledOnGrip : enabledOnGrip;

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
