import { Switch as NativeSwitch, Platform, type SwitchProps } from 'react-native';

import { isDarkPalette } from '@/lib/hooks/theme-palette';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * The native `Switch` with its disabled state mirrored into
 * `accessibilityState`, and both of its colours taken from the app palette.
 *
 * Fabric derives the accessibility traits from the role and
 * `accessibilityState`, then assigns them to the native control, replacing the
 * traits the control reports for itself. React Native's iOS bridge passes
 * `disabled` but not the matching state, so a switch that cannot be toggled
 * still announces itself as enabled. Android already folds `disabled` into that
 * state; doing it here keeps both platforms honest.
 *
 * The colours are stated here because Android otherwise resolves the track and
 * the thumb from the device theme: the on track came out as the framework
 * accent (a teal that is in no palette) and the off thumb as near-white in dark
 * mode, which made one control look unlike every other surface.
 */
export function Switch({
  disabled,
  accessibilityState,
  thumbColor,
  trackColor,
  ...props
}: SwitchProps) {
  const resolvedDisabled = disabled ?? accessibilityState?.disabled;
  const colors = useThemeColors();

  // `thumbColor` is one value for both states, so the off track has to carry
  // the theme the thumb belongs to. The light palette's on-thumb ink is white
  // and sits well on the muted ink; the dark palette's is near-black, and a
  // near-black thumb over the muted ink in the dark card left the whole
  // control as one dim shape. The off track therefore takes the lighter
  // secondary ink in dark mode, which keeps the thumb and the outline of the
  // control visible against the card.
  const offTrack = isDarkPalette(colors) ? colors.ink2 : colors.mutedForeground;

  return (
    <NativeSwitch
      {...props}
      thumbColor={thumbColor ?? colors.primaryForeground}
      trackColor={trackColor ?? { false: offTrack, true: colors.primary }}
      disabled={resolvedDisabled}
      accessibilityState={
        Platform.OS === 'ios'
          ? { ...accessibilityState, disabled: resolvedDisabled }
          : accessibilityState
      }
    />
  );
}
