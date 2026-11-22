import { describe, expect, it } from 'vitest';

import {
  DARK_PIE_FILLS,
  DARK_PIE_SECTION_INK,
  DARK_PIE_STROKE_COLOR,
  darkPieThemeVariables,
} from './mermaid-pie-theme';
import { pieThemeVariables } from './mermaid-pie-fills';
import { darkColors } from '@/lib/hooks/theme-colors.generated';
import { compositeOver, relativeLuminance } from '@/lib/pr-review/diff/syntax-colors';

/** The dark diagram page the fills are painted on: the same composition
 * `markdown-palette` makes for a dark diagram. Derived from the tokens rather
 * than restated, so a change to `background` or `card` fails here instead of
 * leaving the module painting a page that no longer exists. */
const DARK_DIAGRAM_PAGE = compositeOver(darkColors.background, darkColors.card);

const MIN_TEXT_RATIO = 4.5;

/**
 * Mermaid's default (light) pie palette, measured rather than assumed: the
 * vendored `mermaid-11.12.0.min.txt` bundle was rendered through the app's own
 * host page with `dark: false` and no `themeVariables` overrides, on a twelve
 * slice pie whose values descend 12..1 (mermaid paints the largest slice first,
 * so slice order matches `pie1..pie12`), and every `path.pieCircle` fill was
 * read back in order, `hsl(...)` fills resolved to their RGB. `pie1` and `pie2`
 * are mermaid's `primaryColor` and `secondaryColor`; the rest are the hues its
 * default theme rotates out of them.
 *
 * This is the reference the dark ramp must keep naming: its own hues, muted.
 */
const LIGHT_PIE_FILLS = [
  '#ECECFF',
  '#FFFFDE',
  '#B5FF20',
  '#B9B9FF',
  '#FFFF45',
  '#D7FF86',
  '#FF86FF',
  '#20FFFF',
  '#FF2020',
  '#FF20FF',
  '#20FF90',
  '#FF5353',
] as const;

/**
 * How far a dark fill's hue may sit from the light fill it stands in for, in
 * degrees on the colour wheel. Wide enough for a muted tint to read as the same
 * family, narrow enough that the two modes cannot drift into different hues.
 */
const MAX_HUE_DRIFT = 20;

/** The muted band every dark fill has to sit in: a low saturation so no slice
 * is a signal colour, and a lightness window shared by the whole ramp so no
 * slice is brighter than its neighbours. */
const MAX_SATURATION = 0.35;
const MIN_LIGHTNESS = 0.6;
const MAX_LIGHTNESS = 0.8;

/** The spread the whole ramp may cover inside that window, in HSL lightness
 * points. Pinned so a future edit cannot brighten one slice without the rest. */
const MAX_LIGHTNESS_SPREAD = 0.14;

/** WCAG 2.x contrast of two colours the shipped luminance helper parses. */
function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) {
    throw new Error(`contrastRatio needs two parseable hex colors: ${foreground}, ${background}`);
  }
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The HSL of a `#rrggbb` colour, with hue in degrees and saturation and
 * lightness as fractions of one. */
function hexToHsl(hex: string): { hue: number; saturation: number; lightness: number } {
  const value = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map(offset =>
    Number.parseInt(value.slice(offset, offset + 2), 16)
  );
  const [r, g, b] = [red / 255, green / 255, blue / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) {
    return { hue: 0, saturation: 0, lightness };
  }
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let sextant = 0;
  if (max === r) {
    sextant = ((g - b) / delta) % 6;
  } else if (max === g) {
    sextant = (b - r) / delta + 2;
  } else {
    sextant = (r - g) / delta + 4;
  }
  const hue = (((sextant * 60) % 360) + 360) % 360;
  return { hue, saturation, lightness };
}

/** The shorter way round the colour wheel between two hues, in degrees. */
function hueDistance(first: number, second: number): number {
  const raw = Math.abs(first - second) % 360;
  return raw > 180 ? 360 - raw : raw;
}

describe('dark pie fills', () => {
  it('paints twelve distinct slices', () => {
    expect(DARK_PIE_FILLS).toHaveLength(12);
    expect(new Set(DARK_PIE_FILLS).size).toBe(12);
  });

  it('clears WCAG AA text contrast on the diagram page', () => {
    for (const fill of DARK_PIE_FILLS) {
      const ratio = contrastRatio(fill, DARK_DIAGRAM_PAGE);
      expect(
        ratio,
        `${fill} on the dark diagram page ${DARK_DIAGRAM_PAGE} is ${ratio.toFixed(2)}:1, below the ${MIN_TEXT_RATIO}:1 text bar`
      ).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });

  it('clears WCAG AA text contrast on the section ink', () => {
    // The percentage text is painted in this ink on the slice, so it is the pair
    // that has to hold, not just the fill against the page.
    for (const fill of DARK_PIE_FILLS) {
      const ratio = contrastRatio(fill, DARK_PIE_SECTION_INK);
      expect(
        ratio,
        `${fill} against the section ink ${DARK_PIE_SECTION_INK} is ${ratio.toFixed(2)}:1, below the ${MIN_TEXT_RATIO}:1 text bar`
      ).toBeGreaterThanOrEqual(MIN_TEXT_RATIO);
    }
  });

  it('takes the page colour for both the ink and the stroke', () => {
    // One surface, two jobs: the ink reads as a cut-out of a light slice, and the
    // stroke parts neighbouring wedges. Neither may drift to a second colour.
    expect(DARK_PIE_SECTION_INK).toBe(DARK_DIAGRAM_PAGE);
    expect(DARK_PIE_STROKE_COLOR).toBe(DARK_DIAGRAM_PAGE);
  });

  it('mutes every fill and keeps the whole ramp in one lightness band', () => {
    // A saturated slice is a signal colour: it pulls the eye off the content and
    // makes the chart read as an alert. The whole ramp stays muted, and no slice
    // is much brighter than another.
    const lightnesses: number[] = [];
    for (const fill of DARK_PIE_FILLS) {
      const { saturation, lightness } = hexToHsl(fill);
      expect(
        saturation,
        `${fill} is ${(saturation * 100).toFixed(1)}% saturated, above the ${(MAX_SATURATION * 100).toFixed(0)}% muted ceiling`
      ).toBeLessThanOrEqual(MAX_SATURATION);
      expect(
        lightness,
        `${fill} has ${(lightness * 100).toFixed(1)}% lightness, outside the ${(MIN_LIGHTNESS * 100).toFixed(0)}–${(MAX_LIGHTNESS * 100).toFixed(0)}% band`
      ).toBeGreaterThanOrEqual(MIN_LIGHTNESS);
      expect(
        lightness,
        `${fill} has ${(lightness * 100).toFixed(1)}% lightness, outside the ${(MIN_LIGHTNESS * 100).toFixed(0)}–${(MAX_LIGHTNESS * 100).toFixed(0)}% band`
      ).toBeLessThanOrEqual(MAX_LIGHTNESS);
      lightnesses.push(lightness);
    }

    const spread = Math.max(...lightnesses) - Math.min(...lightnesses);
    expect(
      spread,
      `the ramp spans ${(spread * 100).toFixed(1)} lightness points; at most ${(MAX_LIGHTNESS_SPREAD * 100).toFixed(0)} keeps the slices even`
    ).toBeLessThanOrEqual(MAX_LIGHTNESS_SPREAD);
  });

  it('keeps each slice in its light-palette hue family', () => {
    // The two modes must name the same series in the same hue family: a reader
    // who knows the last slice is red in light mode has to see red, muted, in
    // dark mode. Only saturation and lightness may change with the page.
    for (const [index, fill] of DARK_PIE_FILLS.entries()) {
      const lightFill = LIGHT_PIE_FILLS[index];
      const darkHue = hexToHsl(fill).hue;
      const lightHue = hexToHsl(lightFill).hue;
      const distance = hueDistance(darkHue, lightHue);
      expect(
        distance,
        `${fill} (hue ${darkHue.toFixed(1)}°) stands in for ${lightFill} (hue ${lightHue.toFixed(1)}°), ${distance.toFixed(1)}° away`
      ).toBeLessThanOrEqual(MAX_HUE_DRIFT);
    }
  });
});

describe('dark pie theme variables', () => {
  it('maps the twelve fills onto pie1..pie12', () => {
    const variables = darkPieThemeVariables();

    for (const [index, fill] of DARK_PIE_FILLS.entries()) {
      expect(variables[`pie${index + 1}`]).toBe(fill);
    }
    expect(Object.keys(variables)).toHaveLength(15);
  });

  it('states the section ink, full opacity and the slice stroke', () => {
    const variables = darkPieThemeVariables();

    expect(variables.pieSectionTextColor).toBe(DARK_PIE_SECTION_INK);
    // Mermaid's own 0.7 opacity would let the page tint every slice.
    expect(variables.pieOpacity).toBe('1');
    expect(variables.pieStrokeColor).toBe(DARK_PIE_STROKE_COLOR);
  });

  it('returns a fresh map per call', () => {
    const first = darkPieThemeVariables();
    const second = darkPieThemeVariables();

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe('pie theme variables', () => {
  it('takes the page colour it is given as both the ink and the stroke', () => {
    // The wrapper above names the dark page from the tokens; this is the builder
    // it delegates to, so a surface threaded through as a literal is the case
    // the web page test relies on.
    const variables = pieThemeVariables('#0E0E10');

    expect(variables.pieSectionTextColor).toBe('#0E0E10');
    expect(variables.pieStrokeColor).toBe('#0E0E10');
    expect(variables.pieOpacity).toBe('1');
    expect(variables.pie1).toBe(DARK_PIE_FILLS[0]);
    expect(variables.pie2).toBe(DARK_PIE_FILLS[1]);
    expect(Object.keys(variables)).toHaveLength(15);
  });
});
