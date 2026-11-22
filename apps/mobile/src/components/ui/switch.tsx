import { useRef } from 'react';
import {
  Switch as NativeSwitch,
  Platform,
  type SwitchProps,
  useColorScheme,
  View,
} from 'react-native';

import { TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** How much of itself a disabled control keeps. The repo's standard disabled dim. */
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
 * A disabled control paints the same thumb and track colours it paints when it
 * is live, and the whole control carries {@link DISABLED_OPACITY}. The position
 * therefore still reads — a dimmed olive track with its white thumb in light,
 * the muted olive with its `selectionForeground` thumb in dark — and the dim
 * says the control cannot change. `use-theme-colors.contrast.test.ts` measures
 * the dimmed pair on the `secondary` row it sits in. Track against row, then
 * thumb against its own dimmed track: light gives 2.23 and 2.42 on the on
 * position, 1.95 and 2.11 on `PreferenceRow`'s off position, 1.42 and 1.54 on
 * the shared off pair; dark gives 1.72 and 2.70 on, 2.15 and 2.16 off. Each
 * dimmed track also stays at least 1.51:1 from its own live track (2.89 light
 * on, 2.37 light off, 1.51 light off on the shared pair, 1.80 dark on, 2.11
 * dark off).
 *
 * iOS is left alone: UIKit fades a disabled `UISwitch` itself, so painting the
 * pair there would dim the control twice. Android is the platform that needs
 * it, and only it takes it.
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
 * Android: a size audit reads the control's own node rect, so the node renders at
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
 * value when a tap above or below the switch ends inside the box; the switch
 * itself stays the one accessible element. A size audit therefore reads the
 * accessible switch at 63x28pt (the gate's 28pt control minimum), while the
 * effective touch region is the 44pt box. The box has the same 44pt height as
 * the Android node, so the row's negative margin fits both platforms.
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
  // Only Android needs the painted tracks: iOS fades a disabled `UISwitch`
  // itself.
  const inactive = resolvedDisabled === true && !ios;
  // The on pair is the olive accent at the luminance its grip needs: light
  // fills with `primary`, dark with the muted olive `selection`.
  const enabledOnTrack = dark ? colors.selection : colors.primary;
  const enabledOnGrip = dark ? colors.selectionForeground : colors.primaryForeground;
  const enabledOffGrip = dark ? colors.foreground : colors.primaryForeground;
  const enabledOffTrack = dark ? colors.mutedForeground : colors.mutedSoft;
  // A disabled control keeps the live pair and dims as a whole, so its position
  // still reads under the dim that says it cannot change.
  const boxSize = useRef({ width: 0, height: 0 });

  const control = (
    <NativeSwitch
      {...props}
      style={
        ios
          ? undefined
          : [
              { minHeight: TOUCH_TARGET_DP, minWidth: TOUCH_TARGET_DP },
              inactive ? { opacity: DISABLED_OPACITY } : null,
              style,
            ]
      }
      // The switch claims the JS responder, so a tap on it never reaches the touch box too.
      onStartShouldSetResponder={ios ? () => true : undefined}
      value={value}
      trackColor={trackColor ?? { false: enabledOffTrack, true: enabledOnTrack }}
      thumbColor={thumbColor ?? (value ? enabledOnGrip : enabledOffGrip)}
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
      className="justify-center self-center"
      style={[{ minHeight: TOUCH_TARGET_DP }, style]}
      onStartShouldSetResponder={() => resolvedDisabled !== true}
      onLayout={event => {
        boxSize.current = event.nativeEvent.layout;
      }}
      // A gesture that starts in the band and lifts outside the box is not a tap.
      onResponderRelease={({ nativeEvent: { locationX, locationY } }) => {
        const { width, height } = boxSize.current;
        if (locationX >= 0 && locationX <= width && locationY >= 0 && locationY <= height) {
          void props.onValueChange?.(!value);
        }
      }}
    >
      {control}
    </View>
  );
}
