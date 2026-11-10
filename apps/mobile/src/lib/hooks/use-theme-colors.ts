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
 * muted fill a disabled (not busy) primary control paints. Light keeps the
 * label ink of the palette's disabled primary; dark takes `--ink2`, because
 * there the fill is the dim inactive-control surface and the primary label ink
 * (near-black) would not read on it. Paired with the Button's muted fill in
 * `components/ui/button.tsx`; a mark painted on that fill must use this ink.
 */
export function useMutedDisabledInk(): string {
  const colors = useThemeColors();
  return useColorScheme() === 'dark' ? colors.ink2 : colors.primaryForeground;
}
