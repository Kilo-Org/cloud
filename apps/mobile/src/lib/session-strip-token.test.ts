// eslint-disable-next-line import/no-nodejs-modules -- vitest-only theme-token guard, runs in node, never bundled into the app
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/** One parsed sRGB colour: channels 0–255 and an alpha in 0–1. */
type Rgba = { r: number; g: number; b: number; a: number };

const CSS = readFileSync(new URL('../global.css', import.meta.url), 'utf8');

/** Every value a custom property is declared with, in file order (light block first). */
function declarations(name: string): string[] {
  const pattern = new RegExp(`--${name}:\\s*([^;]+);`, 'g');
  return [...CSS.matchAll(pattern)].map(match => (match[1] ?? '').trim().toLowerCase());
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1] ?? '';
    return {
      r: Number.parseInt(digits.slice(0, 2), 16),
      g: Number.parseInt(digits.slice(2, 4), 16),
      b: Number.parseInt(digits.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = '1'] = (rgba[1] ?? '').split(',').map(part => part.trim());
    return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
  }
  throw new Error(`Unsupported colour value in global.css: ${value}`);
}

/** The 8-bit colour a source colour paints over an opaque backplate. */
function composite(source: Rgba, backplate: Rgba): Rgba {
  const mix = (front: number, back: number) => Math.round(source.a * front + (1 - source.a) * back);
  return {
    r: mix(source.r, backplate.r),
    g: mix(source.g, backplate.g),
    b: mix(source.b, backplate.b),
    a: 1,
  };
}

function luminance({ r, g, b }: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left);
  return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

/** One palette's value of a property; index 0 is the light block, 1 the dark block. */
function palette(name: string): [string, string] {
  const values = declarations(name);
  expect(values, `--${name} must be declared in both theme blocks`).toHaveLength(2);
  return [values[0] ?? '', values[1] ?? ''];
}

describe('session row strip token', () => {
  it('keeps the light strip exactly what the row painted before it had a token', () => {
    // The strip always painted `--muted-soft` at 30%, so light mode must still
    // resolve to that same tint: the token now carries the strength, and the
    // row no longer multiplies the colour again.
    const [strip, mutedSoft] = [
      parseColor(palette('session-strip')[0]),
      parseColor(palette('muted-soft')[0]),
    ];
    expect(strip.a).toBeCloseTo(0.3, 5);
    expect({ ...strip, a: 1 }).toEqual({ ...mutedSoft, a: 1 });
  });

  it('stands the dark strip off the page and off the card', () => {
    const strip = parseColor(palette('session-strip')[1]);
    const background = parseColor(palette('background')[1]);
    const card = parseColor(palette('card')[1]);

    expect(contrast(composite(strip, background), background)).toBeGreaterThanOrEqual(3);
    expect(contrast(composite(strip, card), card)).toBeGreaterThanOrEqual(3);
  });

  it('keeps the dark strip quieter than the row ink it groups', () => {
    // The strip marks where a row starts; it must not carry the weight of the
    // eyebrow text beside it or of the accent strips on live rows.
    const strip = parseColor(palette('session-strip')[1]);
    const background = parseColor(palette('background')[1]);
    const mutedInk = parseColor(palette('muted-foreground')[1]);
    const accent = parseColor(palette('agent-sky')[1]);

    expect(contrast(composite(strip, background), background)).toBeLessThan(
      contrast(mutedInk, background)
    );
    expect(contrast(composite(strip, background), background)).toBeLessThan(
      contrast(accent, background)
    );
  });
});
