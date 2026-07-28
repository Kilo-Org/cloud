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
