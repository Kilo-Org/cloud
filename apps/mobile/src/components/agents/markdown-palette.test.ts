import { describe, expect, it } from 'vitest';

import { getMarkdownStyles, getPalette } from './markdown-palette';
import { type ThemeColors } from '@/lib/hooks/use-theme-colors';

const colors = {
  background: '#FBFAF5',
  foreground: '#14130F',
  primary: '#4F5A10',
  primaryForeground: '#FFFFFF',
  secondary: '#F0EEE6',
  secondaryForeground: '#14130F',
  muted: '#F0EEE6',
  mutedForeground: '#7A756B',
  destructive: '#C25647',
  destructiveForeground: '#FFFFFF',
  border: 'rgba(20, 15, 10, 0.09)',
  card: '#FFFFFF',
  ink2: '#3C382F',
  mutedSoft: '#A9A39A',
  hairSoft: 'rgba(20, 15, 10, 0.05)',
  accentSoft: '#E8F27A',
  accentSoftForeground: '#1A1A10',
  good: '#2F9A5F',
  warn: '#B27214',
  warnForeground: '#FFFFFF',
  info: '#2563EB',
  agentYuki: '#6B4FD6',
  agentWorkclaw: '#4F5A10',
  agentCloud: '#2F9A5F',
  agentKilocode: '#B27214',
  agentCoral: '#C25647',
  agentSky: '#2C7FB0',
} satisfies ThemeColors;

describe('markdown palette', () => {
  it('uses accent-soft-foreground for agent chat user bubbles (bg-accent-soft)', () => {
    const palette = getPalette('user', colors);

    expect(palette.textColor).toBe(colors.accentSoftForeground);
  });

  it('uses primary-foreground for kilo-chat user bubbles (bg-primary)', () => {
    const palette = getPalette('kilo-chat-user', colors);

    expect(palette.textColor).toBe(colors.primaryForeground);
  });

  it('keeps list marker boxes free of a top margin so markers align with the first line', () => {
    for (const variant of ['assistant', 'user', 'kilo-chat-user'] as const) {
      const styles = getMarkdownStyles(getPalette(variant, colors));

      // react-native-marked applies `list` to each item's marker box View;
      // any top margin pushes the marker below the first text line.
      expect(styles.list).toEqual({ marginBottom: 4 });
    }
  });
});
