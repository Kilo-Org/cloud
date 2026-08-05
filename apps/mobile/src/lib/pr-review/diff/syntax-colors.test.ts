import { describe, expect, it, vi } from 'vitest';

import { lightColors } from '@/lib/hooks/use-theme-colors';

import { DEFAULT_TOKEN_COLOR, MUTED_COLOR, TOKEN_DARK_LIGHT, tokenColorFor } from './syntax-colors';

vi.mock('react-native', () => ({ useColorScheme: () => 'light' }));
vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));

// WCAG 2.x helpers. The diff renderer paints token colors as inline text
// style on top of the tinted tile surfaces defined in `global.css`
// (`--good-tile-bg` / `--danger-tile-bg` = the status hue at 10% alpha over
// the theme background), so every light token must clear 4.5:1 on the
// composite surfaces, not just on the plain background. The tile hues come
// from `use-theme-colors.ts`, which `global.css` mirrors.
const MIN_TEXT_RATIO = 4.5;

function expandHex(hex: string): readonly [number, number, number] {
  const value = hex.startsWith('#') ? hex.slice(1) : hex;
  if (value.length !== 6) {
    throw new Error(`expected 6-digit hex, got ${hex}`);
  }
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ] as const;
}

function lineariseChannel(c: number): number {
  const s = c / 255;
  if (s <= 0.039_28) {
    return s / 12.92;
  }
  return ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: readonly [number, number, number]): number {
  const [r, g, b] = rgb;
  return 0.2126 * lineariseChannel(r) + 0.7152 * lineariseChannel(g) + 0.0722 * lineariseChannel(b);
}

function contrastRatio(foreground: string, background: string): number {
  const fgL = relativeLuminance(expandHex(foreground));
  const bgL = relativeLuminance(expandHex(background));
  const lighter = Math.max(fgL, bgL);
  const darker = Math.min(fgL, bgL);
  return (lighter + 0.05) / (darker + 0.05);
}

// Blend an 8-digit hex (RRGGBBAA) over an opaque background, matching how
// `global.css` pre-bakes alpha into the `*-tile-bg` tokens.
function compositeHex(tile: string, background: string): string {
  const alpha = Number.parseInt(tile.slice(7, 9), 16) / 255;
  const [r, g, b] = expandHex(tile.slice(0, 7));
  const [bgR, bgG, bgB] = expandHex(background);
  const channels = [
    Math.round(r * alpha + bgR * (1 - alpha)),
    Math.round(g * alpha + bgG * (1 - alpha)),
    Math.round(b * alpha + bgB * (1 - alpha)),
  ];
  return `#${channels.map(channel => channel.toString(16).padStart(2, '0')).join('')}`;
}

describe('tokenColorFor', () => {
  it('returns the light color for a known class in light mode', () => {
    expect(tokenColorFor('keyword', false)).toBe('#7B2CBF');
  });

  it('returns the dark color for a known class in dark mode', () => {
    expect(tokenColorFor('keyword', true)).toBe('#D8B4FE');
  });

  it('falls back to the default color for an unknown class', () => {
    expect(tokenColorFor('unknown-token', false)).toBe(DEFAULT_TOKEN_COLOR.light);
    expect(tokenColorFor('unknown-token', true)).toBe(DEFAULT_TOKEN_COLOR.dark);
  });

  it('falls back to the default color when className is null', () => {
    expect(tokenColorFor(null, false)).toBe(DEFAULT_TOKEN_COLOR.light);
    expect(tokenColorFor(null, true)).toBe(DEFAULT_TOKEN_COLOR.dark);
  });
});

describe('light token contrast on tinted diff surfaces (WCAG AA text)', () => {
  // Surfaces match `global.css`: plain background, the added-line tile
  // (`--good-tile-bg`) and the deleted-line tile (`--danger-tile-bg`).
  const surfaces = {
    plain: lightColors.background,
    goodTile: compositeHex(`${lightColors.good}1a`, lightColors.background),
    dangerTile: compositeHex(`${lightColors.destructive}1a`, lightColors.background),
  } as const;

  const lightTokens: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(TOKEN_DARK_LIGHT).map(([name, pair]) => [name, pair.light])
    ),
    default: DEFAULT_TOKEN_COLOR.light,
    muted: MUTED_COLOR.light,
  };

  it('every light token clears 4.5:1 on plain, good-tile, and danger-tile', () => {
    for (const [token, color] of Object.entries(lightTokens)) {
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        const ratio = contrastRatio(color, surface);
        expect(ratio, `${token} (${color}) vs ${surfaceName} (light)`).toBeGreaterThanOrEqual(
          MIN_TEXT_RATIO
        );
      }
    }
  });
});
