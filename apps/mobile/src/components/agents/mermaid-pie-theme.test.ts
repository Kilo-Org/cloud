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

/**
 * The smallest CIE76 ΔE, in CIELAB (D65), any two of the twelve fills may sit
 * apart.
 *
 * Mermaid paints `pie1..pie12` in slice order, so a pie with fewer than twelve
 * slices drops the tail of the ramp and a reader has to tell the remaining
 * wedges apart with nothing else to go on.
 *
 * The distance is CIE76 ΔE in CIELAB, the plain Euclidean distance between two
 * colours' L\*a\*b\* coordinates. WCAG contrast cannot stand in for it: WCAG
 * measures relative luminance alone, so two fills with different hues and
 * similar lightness score about 1.00:1 while reading as clearly different
 * colours, and two fills of the same hue can score well over 1.00:1 while
 * reading as one. On the ramp below, `pie2` `#CCC5AF` against `pie8` `#A3CBD2`
 * scores 1.01:1 contrast at ΔE 22.3: the luminance metric calls that pair
 * identical, which is exactly the defect the ramp is checked for.
 *
 * The floor sits one ΔE under the 16 the ramp documents in
 * `mermaid-pie-fills.ts`: close enough that an edit taking a pair into the
 * 13–15 band fails here rather than quietly breaking that promise, and far
 * enough under the shipped ramp's measured 16.5 minimum that rounding a hex
 * value does not trip it.
 */
const MIN_PAIR_LAB_DISTANCE = 15;

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

/** One channel pair of a `#rrggbb` colour as a 0–255 integer.
 *
 * Reads its own pair and rejects anything that is not two hex digits, so a
 * malformed colour throws here instead of reaching the HSL maths as `NaN` and
 * making every comparison below quietly false. */
function hexChannel(value: string, offset: number): number {
  const pair = value.slice(offset, offset + 2);
  if (!/^[0-9a-f]{2}$/i.test(pair)) {
    throw new Error(`expected a #rrggbb colour, got "#${value}"`);
  }
  return Number.parseInt(pair, 16);
}

/** The HSL of a `#rrggbb` colour, with hue in degrees and saturation and
 * lightness as fractions of one. */
function hexToHsl(hex: string): { hue: number; saturation: number; lightness: number } {
  const value = hex.replace('#', '');
  const r = hexChannel(value, 0) / 255;
  const g = hexChannel(value, 2) / 255;
  const b = hexChannel(value, 4) / 255;
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

/** The sRGB transfer function's inverse: one 0–255 channel as linear light. */
function channelToLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** CIELAB's cube-root curve, with its linear segment for dark inputs. */
function labCurve(value: number): number {
  return value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
}

/** The CIELAB (D65) coordinates of a `#rrggbb` colour.
 *
 * sRGB channels are linearised, mixed by the sRGB → XYZ matrix with the D65
 * white point (Xn 0.95047, Yn 1, Zn 1.08883), then mapped through CIELAB's
 * cube-root curve. `lightness` is L\*, `a` is the green-to-red axis and `b` the
 * blue-to-yellow one. The channels come from `hexChannel`, so a malformed
 * colour throws rather than producing `NaN` coordinates that would compare as
 * equal to everything. */
function hexToLab(hex: string): { lightness: number; a: number; b: number } {
  const value = hex.replace('#', '');
  const red = channelToLinear(hexChannel(value, 0));
  const green = channelToLinear(hexChannel(value, 2));
  const blue = channelToLinear(hexChannel(value, 4));
  const x = red * 0.4124564 + green * 0.3575761 + blue * 0.1804375;
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
  const z = red * 0.0193339 + green * 0.119192 + blue * 0.9503041;
  const fx = labCurve(x / 0.95047);
  const fy = labCurve(y / 1);
  const fz = labCurve(z / 1.08883);
  return {
    lightness: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/** The CIE76 colour difference between two `#rrggbb` colours: the Euclidean
 * distance between their CIELAB coordinates, where about 2.3 is a just
 * noticeable difference and anything under about 10 reads as the same colour
 * on two large adjacent areas. */
function labDistance(first: string, second: string): number {
  const firstLab = hexToLab(first);
  const secondLab = hexToLab(second);
  return Math.hypot(
    firstLab.lightness - secondLab.lightness,
    firstLab.a - secondLab.a,
    firstLab.b - secondLab.b
  );
}

/** The dark fill at `index`, with the read checked.
 *
 * `noUncheckedIndexedAccess` makes every indexed read possibly missing, and a
 * test that quietly skipped a missing slice would pass on a shorter ramp than
 * the one mermaid paints, so a missing entry throws instead. */
function darkFillAt(index: number): string {
  const fill = DARK_PIE_FILLS[index];
  if (fill === undefined) {
    throw new Error(`the dark ramp has no fill at index ${index}`);
  }
  return fill;
}

/**
 * Every unordered pair of ramp indices, which is the 66 pairs a twelve slice
 * pie can paint.
 */
function allIndexPairs(): (readonly [number, number])[] {
  const pairs: (readonly [number, number])[] = [];
  for (let first = 0; first < DARK_PIE_FILLS.length; first += 1) {
    for (let second = first + 1; second < DARK_PIE_FILLS.length; second += 1) {
      pairs.push([first, second]);
    }
  }
  return pairs;
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
    const darkFills = [...DARK_PIE_FILLS];
    for (const [index, lightFill] of LIGHT_PIE_FILLS.entries()) {
      const fill = darkFills[index];
      if (fill === undefined) {
        throw new Error(`no dark fill at index ${index} for light fill ${lightFill}`);
      }
      const darkHue = hexToHsl(fill).hue;
      const lightHue = hexToHsl(lightFill).hue;
      const distance = hueDistance(darkHue, lightHue);
      expect(
        distance,
        `${fill} (hue ${darkHue.toFixed(1)}°) stands in for ${lightFill} (hue ${lightHue.toFixed(1)}°), ${distance.toFixed(1)}° away`
      ).toBeLessThanOrEqual(MAX_HUE_DRIFT);
    }
  });

  it('keeps every pair of fills perceptually apart', () => {
    // A pie has no axis or scale to fall back on: a wedge's colour is the only
    // thing that says which slice it is, and a six-slice chart paints just
    // `pie1..pie6`. WCAG contrast cannot make this call, because it measures
    // luminance alone: `pie2` `#CCC5AF` against `pie8` `#A3CBD2` scores
    // 1.01:1 there while being 22.3 ΔE apart. CIE76 ΔE in CIELAB is the
    // distance a reader sees.
    for (const [first, second] of allIndexPairs()) {
      const firstFill = darkFillAt(first);
      const secondFill = darkFillAt(second);
      const distance = labDistance(firstFill, secondFill);
      expect(
        distance,
        `pie${first + 1} ${firstFill} and pie${second + 1} ${secondFill} are only ${distance.toFixed(1)} ΔE apart, below the ${MIN_PAIR_LAB_DISTANCE} ΔE perceptual floor`
      ).toBeGreaterThanOrEqual(MIN_PAIR_LAB_DISTANCE);
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
