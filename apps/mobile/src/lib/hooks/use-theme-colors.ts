import { useColorScheme } from 'react-native';

// These values must stay in sync with src/global.css design tokens.
// They exist as raw strings because React Navigation header/tab options
// and Lucide icons require plain color values (not Tailwind classes).
const lightColors = {
  background: '#FBFAF5',
  foreground: '#14130F',
  primary: '#4F5A10',
  primaryForeground: '#FFFFFF',
  secondary: '#F0EEE6',
  secondaryForeground: '#14130F',
  muted: '#F0EEE6',
  mutedForeground: '#7A756B',
  destructive: '#C25647',
  border: 'rgba(20, 15, 10, 0.09)',
  card: '#FFFFFF',

  // Focus-only
  ink2: '#3C382F',
  mutedSoft: '#A9A39A',
  hairSoft: 'rgba(20, 15, 10, 0.05)',
  accentSoft: '#E8F27A',
  accentSoftForeground: '#1A1A10',
  good: '#2F9A5F',
  warn: '#B27214',

  // Per-agent hues (full-opacity only — tile bg/border live in CSS tokens)
  agentYuki: '#6B4FD6',
  agentWorkclaw: '#4F5A10',
  agentCloud: '#2F9A5F',
  agentKilocode: '#B27214',
  agentCoral: '#C25647',
  agentSky: '#2C7FB0',
} as const;

const darkColors = {
  background: '#0E0E10',
  foreground: '#F2F0EB',
  primary: '#E8F27A',
  primaryForeground: '#1A1A10',
  secondary: '#1F1F24',
  secondaryForeground: '#F2F0EB',
  muted: '#1F1F24',
  mutedForeground: '#8A8680',
  destructive: '#F28B7A',
  border: 'rgba(255, 255, 255, 0.07)',
  card: '#17171A',

  // Focus-only
  ink2: '#C4C1B8',
  mutedSoft: '#56544F',
  hairSoft: 'rgba(255, 255, 255, 0.04)',
  accentSoft: '#E8F27A',
  accentSoftForeground: '#1A1A10',
  good: '#5FCB8E',
  warn: '#F2B05F',

  // Per-agent hues
  agentYuki: '#A78BFA',
  agentWorkclaw: '#E8F27A',
  agentCloud: '#5FCB8E',
  agentKilocode: '#F2B05F',
  agentCoral: '#F28B7A',
  agentSky: '#6BB5E0',
} as const;

export type ThemeColors = { readonly [K in keyof typeof lightColors]: string };

export function useThemeColors(): ThemeColors {
  const colorScheme = useColorScheme();
  return colorScheme === 'dark' ? darkColors : lightColors;
}
