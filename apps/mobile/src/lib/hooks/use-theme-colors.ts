import { useColorScheme } from 'react-native';

// These values must stay in sync with src/global.css design tokens.
// They exist as raw strings because React Navigation header/tab options
// require plain color values (not Tailwind classes).
const lightColors = {
  background: 'hsl(0, 0%, 100%)',
  foreground: 'hsl(0, 0%, 3.9%)',
  primary: 'hsl(0, 0%, 9%)',
  primaryForeground: 'hsl(0, 0%, 98%)',
  secondary: 'hsl(0, 0%, 96.1%)',
  secondaryForeground: 'hsl(0, 0%, 9%)',
  muted: 'hsl(0, 0%, 96.1%)',
  mutedForeground: 'hsl(0, 0%, 45.1%)',
  destructive: 'hsl(0, 84.2%, 60.2%)',
  border: 'hsl(0, 0%, 89.8%)',
  card: 'hsl(0, 0%, 100%)',
} as const;

const darkColors = {
  background: 'hsl(0, 0%, 3.9%)',
  foreground: 'hsl(0, 0%, 98%)',
  primary: 'hsl(0, 0%, 98%)',
  primaryForeground: 'hsl(0, 0%, 9%)',
  secondary: 'hsl(0, 0%, 14.9%)',
  secondaryForeground: 'hsl(0, 0%, 98%)',
  muted: 'hsl(0, 0%, 14.9%)',
  mutedForeground: 'hsl(0, 0%, 63.9%)',
  destructive: 'hsl(0, 70.9%, 59.4%)',
  border: 'hsl(0, 0%, 14.9%)',
  card: 'hsl(0, 0%, 3.9%)',
} as const;

export function useThemeColors() {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark' ? darkColors : lightColors;
}
