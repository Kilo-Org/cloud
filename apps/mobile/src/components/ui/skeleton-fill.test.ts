import { describe, expect, it } from 'vitest';

import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

// The placeholder fill is the one loading colour with a per-palette step: light
// keeps the muted neutral every skeleton has painted, and the dark block lifts
// it because `--muted` sits 1.18:1 off the near-black page there. The design
// review of the live-session transcript caught that collision — the skeleton
// bubbles read as a blank list — so the step is pinned here.
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

// WCAG 2.x relative luminance; the constants come from the spec and must not be
// tuned to "improve" the ratio.
function lineariseChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.039_28 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = expandHex(hex);
    return (
      0.2126 * lineariseChannel(r) + 0.7152 * lineariseChannel(g) + 0.0722 * lineariseChannel(b)
    );
  };
  const fg = luminance(foreground);
  const bg = luminance(background);
  return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
}

// A placeholder is a large soft block, not text: it needs to be seen, not read.
// 1.45:1 off the page is the floor that lifted the transcript bubbles out of
// the black without turning them into message surfaces; the shipped step
// measures 1.51:1 off the page and 1.29:1 off a card.
const MIN_DARK_PAGE_RATIO = 1.45;
const MIN_DARK_CARD_RATIO = 1.25;

describe('skeleton placeholder fill', () => {
  it('paints the light placeholder on the muted neutral, unchanged', () => {
    expect(lightColors.skeletonFill).toBe(lightColors.muted);
  });

  it('keeps the dark placeholder above the page and above a card', () => {
    expect(contrastRatio(darkColors.skeletonFill, darkColors.background)).toBeGreaterThanOrEqual(
      MIN_DARK_PAGE_RATIO
    );
    expect(contrastRatio(darkColors.skeletonFill, darkColors.secondary)).toBeGreaterThanOrEqual(
      MIN_DARK_CARD_RATIO
    );
  });

  it('records the collision the dark step exists to clear', () => {
    expect(contrastRatio(darkColors.muted, darkColors.background)).toBeLessThan(
      MIN_DARK_PAGE_RATIO
    );
  });
});
