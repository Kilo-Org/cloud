import { DarkTheme, DefaultTheme } from 'expo-router';
import { useColorScheme } from 'react-native';

import { darkColors, lightColors } from './theme-colors.generated';

/**
 * The one place the app builds a navigation theme, and the only reason
 * `use-theme-colors` would need `expo-router`. It lives apart so a component
 * that only paints with the palette (a `Switch`, a `Text`) does not pull the
 * router into its module graph.
 */
export function useNavigationTheme() {
  const colorScheme = useColorScheme();
  const colors = colorScheme === 'dark' ? darkColors : lightColors;
  const baseTheme = colorScheme === 'dark' ? DarkTheme : DefaultTheme;

  return {
    ...baseTheme,
    colors: {
      ...baseTheme.colors,
      primary: colors.primary,
      background: colors.background,
      card: colors.card,
      text: colors.foreground,
      border: colors.border,
      notification: colors.destructive,
    },
  };
}
