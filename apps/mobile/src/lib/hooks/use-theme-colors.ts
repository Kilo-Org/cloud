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
 * fill a disabled (not busy) primary action paints. That fill is the palette's
 * `--secondary-fill`, the pair the Button's disabled plate uses in
 * `components/ui/button.tsx`. In light the mark takes `--muted-foreground`
 * (4.62:1 on the light fill). In dark it takes `--ink2` (5.37:1), because
 * `--muted-foreground` measures 2.67:1 on the dark plate and would leave the
 * mark unreadable. A mark painted on that fill must use this ink.
 */
export function useMutedDisabledInk(): string {
  return useColorScheme() === 'dark' ? darkColors.ink2 : lightColors.mutedForeground;
}
