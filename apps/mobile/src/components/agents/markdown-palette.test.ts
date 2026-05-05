import { describe, expect, it } from 'vitest';

import { getPalette } from './markdown-palette';
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
  border: 'rgba(20, 15, 10, 0.09)',
  card: '#FFFFFF',
  ink2: '#3C382F',
  mutedSoft: '#A9A39A',
  hairSoft: 'rgba(20, 15, 10, 0.05)',
  accentSoft: '#E8F27A',
  accentSoftForeground: '#1A1A10',
  good: '#2F9A5F',
  warn: '#B27214',
  agentYuki: '#6B4FD6',
  agentWorkclaw: '#4F5A10',
  agentCloud: '#2F9A5F',
  agentKilocode: '#B27214',
  agentCoral: '#C25647',
  agentSky: '#2C7FB0',
} satisfies ThemeColors;

describe('markdown palette', () => {
  it('uses the primary foreground for user-authored chat bubbles', () => {
    const palette = getPalette('user', {
      ...colors,
      primaryForeground: '#1A1A10',
    });

    expect(palette.textColor).toBe('#1A1A10');
  });
});
