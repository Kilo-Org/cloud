import { Switch as NativeSwitch, Platform, type SwitchProps, useColorScheme } from 'react-native';

import { TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

// A disabled Switch keeps its pair and dims the whole control instead.
const DISABLED_OPACITY = 0.5;

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
 * A disabled switch keeps the pair for the position it still shows. Android
 * folds the colours into the track and thumb drawables and only sets
 * `isEnabled`, so the platform draws no unavailable appearance of its own.
 * Painting a muted pair in its place made the on and the off control one grey
 * pill in dark, so a disabled list could not say which items were on. The
 * control keeps the scheme's on and off pairs at a reduced opacity instead:
 * the two tracks stay apart and each grip stays on its own fill, which keeps
 * which way it points readable while the dimming marks it unavailable. A
 * caller's `style` is applied last, so its own opacity still wins.
 *
 * iOS is left alone: it fades a disabled `UISwitch` itself, so the extra
 * opacity is Android's alone — the platform that draws no unavailable
 * appearance of its own.
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
  // Only Android needs the dim: iOS fades a disabled `UISwitch` itself.
  const inactive = resolvedDisabled === true && Platform.OS === 'android';
  // The on pair is the olive accent at the luminance its grip needs: light
  // fills with `primary`, dark with the muted olive `selection`.
  const onTrack = dark ? colors.selection : colors.primary;
  const onGrip = dark ? colors.selectionForeground : colors.primaryForeground;
  // The off pair follows the scheme as well: `mutedSoft` under a white grip in
  // light, `mutedForeground` under a `foreground` grip in dark.
  const offTrack = dark ? colors.mutedForeground : colors.mutedSoft;
  const offGrip = dark ? colors.foreground : colors.primaryForeground;

  return (
    <NativeSwitch
      {...props}
      style={[
        { minHeight: TOUCH_TARGET_DP, minWidth: TOUCH_TARGET_DP },
        inactive ? { opacity: DISABLED_OPACITY } : null,
        style,
      ]}
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
