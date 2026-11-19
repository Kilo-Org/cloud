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
 * A disabled switch keeps a pair of its own, at the position it still shows.
 * Android folds the colours into the track and thumb drawables and only sets
 * `isEnabled`, so the platform draws no unavailable appearance of its own;
 * without this pair a row whose title dims for "not available" keeps a
 * full-strength accent track beside it and reads as both unavailable and on.
 *
 * The disabled pair keeps the positions apart rather than painting one grey
 * pill for both: the olive on-track and the neutral off-track, each dimmed
 * toward the row so the control reads as unavailable, and a grip that still
 * stands off its own track. Painting the same mid-neutral for both positions
 * (the palette's `mutedSoft` under `foreground`) did read as unavailable, but
 * it stopped saying whether the switch was on — the one thing a read-only list
 * has to show. The steps are palette tokens of their own
 * (`--switch-disabled-on`, `--switch-disabled-off` and their grips), measured
 * over the `secondary` row the switch sits on: the two tracks separate at
 * 2.0:1 in light and 1.68:1 in dark, each track clears 1.6:1 over the row, and
 * each grip clears 1.6:1 over its track. A caller's own pair still wins: its
 * props are applied last.
 *
 * iOS is left alone: UIKit fades a disabled `UISwitch` itself, so the disabled
 * pair there would paint an unavailable control twice. Android is the platform
 * that needs the pair, and only it takes it.
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
 * not lift it. Every caller gets the target here: the node renders at least
 * {@link TOUCH_TARGET_DP} on both axes (the Android gate measured 44.19dp), and
 * a caller never shrinks it with a smaller `style` box. A row that must keep
 * its 48pt frame cancels the excess instead: a negative vertical margin of
 * {@link TOUCH_TARGET_OVERHANG_DP} a side makes the node contribute the row's
 * 27pt content band to layout, and the row's 10.5pt padding keeps the node
 * inside the row's bounds (Android delivers a touch only inside a parent
 * view). `row-trailing.tsx` holds the one switch host that does this.
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
  // Only Android needs the disabled pairs: iOS fades a disabled `UISwitch`
  // itself.
  const inactive = resolvedDisabled === true && Platform.OS === 'android';
  // The on pair is the olive accent at the luminance its grip needs: light
  // fills with `primary`, dark with the muted olive `selection`.
  const enabledOnTrack = dark ? colors.selection : colors.primary;
  const enabledOnGrip = dark ? colors.selectionForeground : colors.primaryForeground;
  const enabledOffGrip = dark ? colors.foreground : colors.primaryForeground;
  const enabledOffTrack = dark ? colors.mutedForeground : colors.mutedSoft;
  // A disabled control keeps the hue that says which way it points: the olive
  // on-track and the neutral off-track each dim toward the row, with a grip
  // that still stands off its own track. One grey pair for both positions read
  // as unavailable but stopped saying whether the switch was on, which is the
  // state a read-only list has to show.
  const offGrip = inactive ? colors.switchDisabledOffForeground : enabledOffGrip;
  const offTrack = inactive ? colors.switchDisabledOff : enabledOffTrack;
  const onTrack = inactive ? colors.switchDisabledOn : enabledOnTrack;
  const onGrip = inactive ? colors.switchDisabledOnForeground : enabledOnGrip;

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
