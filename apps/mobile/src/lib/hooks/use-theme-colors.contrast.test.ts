import { describe, expect, it, vi } from 'vitest';

import { darkColors, lightColors } from '@/lib/hooks/use-theme-colors';

vi.mock('react-native', () => ({ useColorScheme: () => 'light' }));
vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));

// These are the actual static hex values shipped in
// `src/lib/hooks/use-theme-colors.ts`. The contrast assertions below fail if
// the shipped pair regresses below 4.5:1, so any drift in the hook itself
// breaks the build.
//
// `src/global.css` must stay in lockstep with the hook; the CSS file is not
// read here because vitest's `?raw` does not process .css files in this node
// environment and `node:fs` is lint-banned.

const MIN_TEXT_RATIO = 4.5;

type Rgb = readonly [number, number, number];

function expandHex(hex: string): Rgb {
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

// WCAG 2.x relative luminance. The 0.039_28 / 12.92 thresholds and the
// gamma offset 0.055 come straight from the WCAG 2.x spec and must not
// be tuned to "improve" the ratio.
function lineariseChannel(c: number): number {
  const s = c / 255;
  if (s <= 0.039_28) {
    return s / 12.92;
  }
  return ((s + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(rgb: Rgb): number {
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

// Blend an 8-digit hex (RRGGBBAA) over an opaque background. NativeWind v5
// cannot decompose theme colors, so `global.css` ships pre-baked alpha tiles
// like `--good-tile-bg: <hex>1a`; the diff text actually renders on the
// resulting tinted surface, so assertions must use this composite, not the
// raw token.
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

describe('muted-foreground token contrast (WCAG AA text)', () => {
  it('light theme: >= 4.5:1 against background and card', () => {
    const surfaces = { background: lightColors.background, card: lightColors.card } as const;
    for (const [name, surface] of Object.entries(surfaces)) {
      const ratio = contrastRatio(lightColors.mutedForeground, surface);
      expect(ratio, `muted-foreground vs ${name} (light)`).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });

  it('dark theme: >= 4.5:1 against background and card', () => {
    const surfaces = { background: darkColors.background, card: darkColors.card } as const;
    for (const [name, surface] of Object.entries(surfaces)) {
      const ratio = contrastRatio(darkColors.mutedForeground, surface);
      expect(ratio, `muted-foreground vs ${name} (dark)`).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });
});

describe('status token contrast on light surfaces (WCAG AA text)', () => {
  // Status tokens are read as text on the app background (screens) and on
  // `secondary` (status chips/cards). `global.css` keeps `--good` /
  // `--warn` / `--destructive` / `--info` in lockstep with these TS values.
  const statusTokens = {
    good: lightColors.good,
    warn: lightColors.warn,
    destructive: lightColors.destructive,
    info: lightColors.info,
  } as const;
  const surfaces = {
    background: lightColors.background,
    secondary: lightColors.secondary,
  } as const;

  it('light theme: >= 4.5:1 for every status token on background and secondary', () => {
    for (const [token, color] of Object.entries(statusTokens)) {
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        const ratio = contrastRatio(color, surface);
        expect(ratio, `${token} vs ${surfaceName} (light)`).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
      }
    }
  });

  it('composite helper follows the global.css tile convention', () => {
    // The tile tokens in global.css are the status hex with a `1a` (10%)
    // alpha suffix, e.g. `--good-tile-bg: #24784a1a`. Asserting the derived
    // composite keeps the diff-token assertions in syntax-colors.test.ts on
    // the same surfaces the renderer actually paints.
    expect(compositeHex(`${lightColors.good}1a`, lightColors.background)).toBe('#e5ede4');
    expect(compositeHex(`${lightColors.destructive}1a`, lightColors.background)).toBe('#f3e8e2');
  });
});
