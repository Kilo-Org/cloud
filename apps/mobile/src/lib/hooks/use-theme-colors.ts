import { useColorScheme } from 'react-native';

// generated from src/global.css; do not edit by hand.
import { darkColors, lightColors } from './theme-colors.generated';

export { darkColors, lightColors };

export type ThemeColors = { readonly [K in keyof typeof lightColors]: string };

export function useThemeColors(): ThemeColors {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark' ? darkColors : lightColors;
}

/**
 * The ink a caller-painted mark (an ActivityIndicator, a glyph) takes on the
 * fill a disabled (not busy) primary action paints: the palette's
 * `--muted-foreground` on `--muted`, the pair the Button's muted fill uses in
 * `components/ui/button.tsx`. A mark painted on that fill must use this ink.
 */
export function useMutedDisabledInk(): string {
  const colors = useThemeColors();
  return colors.mutedForeground;
}

/**
 * The ink a caller-painted mark takes on the plate a disabled primary paints
 * when the caller opted into `disabledFace="primary"` — the face the Button
 * gives a screen's one primary action while it is disabled. The plate carries
 * `--primary-foreground` in light and `--foreground` in dark, so the mark
 * follows the same pair as the label beside it.
 */
export function usePlatedDisabledInk(): string {
  const colors = useThemeColors();
  return useColorScheme() === 'dark' ? colors.foreground : colors.primaryForeground;
}
