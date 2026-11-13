import { describe, expect, it } from 'vitest';

import { TERMINAL_BACKGROUND, TERMINAL_THEME } from './terminal-theme';

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

function lightness(hex: string): number {
  const value = luminance(hex);
  return value > 0.008856 ? 116 * value ** (1 / 3) - 16 : 903.3 * value;
}

function contrast(foreground: string, background: string): number {
  const one = luminance(foreground);
  const other = luminance(background);
  return (Math.max(one, other) + 0.05) / (Math.min(one, other) + 0.05);
}

const AA = 4.5;
const BRIGHT_DISTANCE = 15;

const ansi = TERMINAL_THEME.ansi ?? [];

function slot(index: number): string {
  return required(ansi[index], `ansi[${index}]`);
}

describe('terminal theme', () => {
  it('draws the default text and every colour at AA on the terminal background', () => {
    expect(ansi).toHaveLength(16);
    expect(contrast(required(TERMINAL_THEME.background, 'background'), TERMINAL_BACKGROUND)).toBe(
      1
    );
    expect(
      contrast(required(TERMINAL_THEME.foreground, 'foreground'), TERMINAL_BACKGROUND)
    ).toBeGreaterThanOrEqual(AA);
    // Slot 0 is the background family and slot 15 the light end; every slot a
    // tool paints as text, including the dim neutral, clears AA.
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect(contrast(slot(index), TERMINAL_BACKGROUND), `ansi[${index}]`).toBeGreaterThanOrEqual(
        AA
      );
    }
  });

  it('keeps slot 0 near the background and slot 15 at the light end', () => {
    expect(lightness(slot(0))).toBeLessThan(20);
    expect(lightness(slot(15))).toBeGreaterThan(90);
  });

  it('reads slot 0 on the six colour slots it is painted over', () => {
    // tmux's status bar, htop's key column and a diff badge all draw the dark
    // slot as text over a colour, so that pair is the one that has to hold.
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(contrast(slot(0), slot(index)), `ansi[0] on ansi[${index}]`).toBeGreaterThanOrEqual(
        AA
      );
    }
  });

  it('separates each bright from its normal by 15 L*', () => {
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(
        lightness(slot(index + 8)) - lightness(slot(index)),
        `ansi[${index + 8}] against ansi[${index}]`
      ).toBeGreaterThanOrEqual(BRIGHT_DISTANCE);
    }
  });

  it('cannot also read the light end on a colour slot, and does not pretend to', () => {
    // AA on a near-black background needs luminance >= 0.195, while white text
    // on that colour at AA needs <= 0.183, so no palette can satisfy both. The
    // light end is measured only for the contrast it does reach.
    for (const index of [1, 2, 3, 4, 5, 6]) {
      expect(contrast(slot(15), slot(index)), `ansi[15] on ansi[${index}]`).toBeGreaterThanOrEqual(
        1.8
      );
    }
  });
});
