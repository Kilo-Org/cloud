import { useColorScheme } from 'react-native';

// generated from src/global.css; do not edit by hand.
import { darkColors, lightColors } from './theme-colors.generated';

export { darkColors, lightColors };

export type ThemeColors = { readonly [K in keyof typeof lightColors]: string };

export function useThemeColors(): ThemeColors {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark' ? darkColors : lightColors;
}
