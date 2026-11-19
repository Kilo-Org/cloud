import {
  Switch as NativeSwitch,
  Platform,
  type SwitchProps,
  useColorScheme,
  View,
} from 'react-native';

import { TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

const ANDROID_BOX_STYLE = { minHeight: TOUCH_TARGET_DP, minWidth: TOUCH_TARGET_DP } as const;
const IOS_TOUCH_BOX_STYLE = {
  alignSelf: 'center',
  justifyContent: 'center',
  minHeight: TOUCH_TARGET_DP,
} as const;

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
 * A disabled switch paints one muted pair, at the position it still shows.
 * Android folds the colours into the track and thumb drawables and only sets
 * `isEnabled`, so the platform draws no unavailable appearance of its own;
 * without this pair a row whose title dims for "not available" keeps a
 * full-strength accent track beside it and reads as both unavailable and on.
 *
 * The pair is the same for on and off and has one shape in light and dark: a
 * soft grip on the translucent ink track `ringTrack`, `muted` in light and
 * `mutedForeground` in dark. Each half is quieter than its enabled twin (the
 * white or `foreground` grip, the `mutedSoft` or `mutedForeground` off track,
 * the olive on track), so disabled reads quieter than enabled in both schemes,
 * while the thumb's position still says which way it points. The earlier
 * `mutedSoft` track under the ink `foreground` grip painted a near-black grip
 * in light, the darkest mark in its card, and a light one in dark, so one
 * state read two ways across themes (Android critic, 2026-11-19). An olive
 * `primaryDisabled` track read as active (`app-notifications` gate,
 * 2026-11-18).
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
 * 63x28pt on iOS 26 — which is under `DESIGN.md:364`'s 44pt touch target.
 *
 * Android: the audit reads the control's own node rect, so the node renders at
 * least {@link TOUCH_TARGET_DP} on both axes (the Android gate measured
 * 44.19dp), and a caller never shrinks it with a smaller `style` box. The
 * Android view centers its drawable in that box. A row that must keep its 48pt
 * frame cancels the excess with a negative vertical margin of
 * {@link TOUCH_TARGET_OVERHANG_DP} a side; `row-trailing.tsx` holds the one
 * switch host that does this.
 *
 * iOS: `UISwitch` draws at its fixed size at the top of a taller frame, and
 * React Native's iOS `Switch` composes `alignSelf: 'flex-start'`, so a 44pt
 * switch node painted the control about 11pt above its row's center. The
 * switch node keeps its native size, and a 44pt touch box centers it. `hitSlop`
 * cannot do this: a touch outside the `UISwitch` bounds never reaches the
 * native control (measured on the iOS 26 simulator). So the box is a `View`
 * hidden from assistive technology that takes the JS responder and flips the
 * value when a tap above or below the switch ends; the switch itself stays the
 * one accessible element. The box has the same 44pt height as the Android
 * node, so the row's negative margin fits both platforms.
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
  const ios = Platform.OS === 'ios';
  // Only Android needs the muted pair: iOS fades a disabled `UISwitch` itself.
  const inactive = resolvedDisabled === true && !ios;
  // The on pair is the olive accent at the luminance its grip needs: light
  // fills with `primary`, dark with the muted olive `selection`.
  const enabledOnTrack = dark ? colors.selection : colors.primary;
  const enabledOnGrip = dark ? colors.selectionForeground : colors.primaryForeground;
  const enabledOffGrip = dark ? colors.foreground : colors.primaryForeground;
  const enabledOffTrack = dark ? colors.mutedForeground : colors.mutedSoft;
  // The off grip sits on the off track. A control that cannot change paints
  // one quiet pair at the position it still shows: a soft grip on the
  // translucent ink track, quieter than every enabled half in both schemes.
  const disabledTrack = colors.ringTrack;
  const disabledGrip = dark ? colors.mutedForeground : colors.muted;
  const offGrip = inactive ? disabledGrip : enabledOffGrip;
  const offTrack = inactive ? disabledTrack : enabledOffTrack;
  const onTrack = inactive ? disabledTrack : enabledOnTrack;
  const onGrip = inactive ? disabledGrip : enabledOnGrip;

  const control = (
    <NativeSwitch
      {...props}
      style={ios ? undefined : [ANDROID_BOX_STYLE, style]}
      // The switch claims the JS responder, so a tap on it never reaches the touch box too.
      onStartShouldSetResponder={ios ? () => true : undefined}
      value={value}
      trackColor={trackColor ?? { false: offTrack, true: onTrack }}
      thumbColor={thumbColor ?? (value ? onGrip : offGrip)}
      disabled={resolvedDisabled}
      accessibilityState={
        ios ? { ...accessibilityState, disabled: resolvedDisabled } : accessibilityState
      }
    />
  );
  if (!ios) {
    return control;
  }
  return (
    <View
      accessible={false}
      style={[IOS_TOUCH_BOX_STYLE, style]}
      onStartShouldSetResponder={() => resolvedDisabled !== true}
      onResponderRelease={() => {
        void props.onValueChange?.(!value);
      }}
    >
      {control}
    </View>
  );
}
