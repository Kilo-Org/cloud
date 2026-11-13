import { describe, expect, it } from 'vitest';

import { DARK_TERMINAL_THEME, LIGHT_TERMINAL_THEME, terminalThemeFor } from './terminal-theme';

function required(value: string | undefined, name: string): string {
  if (value === undefined) {
    throw new Error(`${name} is not set on the theme`);
  }
  return value;
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const channels = [0, 2, 4].map(offset => {
    const value = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const [red = 0, green = 0, blue = 0] = channels;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const one = luminance(foreground);
  const other = luminance(background);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

const AA = 4.5;

const PALETTES = [
  ['light', LIGHT_TERMINAL_THEME],
  ['dark', DARK_TERMINAL_THEME],
] as const;

describe('terminal palettes', () => {
  it.each(PALETTES)('paints all sixteen ANSI colours at AA on the %s background', (_scheme, theme) => {
    const background = required(theme.background, 'background');
    const ansi = theme.ansi ?? [];
    expect(ansi).toHaveLength(16);
    for (const colour of ansi) {
      expect(contrast(colour, background)).toBeGreaterThanOrEqual(AA);
    }
    expect(contrast(required(theme.foreground, 'foreground'), background)).toBeGreaterThanOrEqual(AA);
  });

  it('picks the palette for the scheme', () => {
    expect(terminalThemeFor(false)).toBe(LIGHT_TERMINAL_THEME);
    expect(terminalThemeFor(true)).toBe(DARK_TERMINAL_THEME);
  });
});
