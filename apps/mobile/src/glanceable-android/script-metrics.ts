import { eastAsianWidth } from 'get-east-asian-width';

/**
 * Line metrics of the fonts Android actually draws the Home widget in, in em
 * per unit of font size, measured from the hhea table of the emulator's own
 * `/system/fonts`. A TextView draws a line in the box of the font its first
 * fallback picks, so a script whose characters leave Roboto needs that font's
 * box and ascent instead of Roboto's.
 */

/** Roboto's ascent plus font padding above the baseline, per unit of font size. */
export const BASELINE = 1.056;

/** Roboto's line box: the shortest box a line gets. */
export const LATIN_LINE = 1.32;

/**
 * The box the shipping layouts were calibrated to for Arabic-Indic and Brahmic
 * scripts (the range the old `TALL_SCRIPT` test covered). A script in that
 * range never drops below it, even where its own font measures a shorter box:
 * a box that ships today must never shrink.
 */
const TALL_LINE = 1.62;

/** Android's font padding, added on top of a fallback font's own ascent. */
const PADDING = 0.128;

type FontMetrics = { ascent: number; box: number };

/** Every script without a measured fallback font draws in Roboto. */
const ROBOTO: FontMetrics = { ascent: BASELINE, box: LATIN_LINE };

type ScriptMetrics = FontMetrics & { match: RegExp };

/**
 * One script whose fallback font was measured: `metrics` are that font's hhea
 * ascent and box. Android draws a line with its font padding added above the
 * baseline, so the ascent gains `PADDING` and the box gains the same `PADDING`:
 * the descent below the baseline stays the font's own, and the box cannot cut
 * into a glyph's tail. `tall` marks a script the old 1.62em box covered, whose
 * shipping box is therefore floored there: a box that ships today never
 * shrinks.
 */
function script(
  match: RegExp,
  metrics: { ascent: number; box: number; tall?: boolean }
): ScriptMetrics {
  const floor = metrics.tall === true ? TALL_LINE : LATIN_LINE;
  return {
    ascent: metrics.ascent + PADDING,
    box: Math.max(metrics.box + PADDING, floor),
    match,
  };
}

/**
 * One script with no measured fallback font: it keeps the box the layouts were
 * calibrated to, exactly, and draws in Roboto. `TALL_LINE` is a design constant
 * rather than a font measurement, so no font padding is added to it: padding
 * here would grow a box that ships today by a value no font asked for.
 */
function calibrated(match: RegExp): ScriptMetrics {
  return { ascent: BASELINE, box: TALL_LINE, match };
}

/**
 * The scripts whose characters leave Roboto, one font each. A script in the old
 * 1.62em range keeps that floor; a script whose own box is taller takes it.
 */
const SCRIPTS: readonly ScriptMetrics[] = [
  script(/\p{Script=Armenian}/u, { ascent: 1.068, box: 1.36 }),
  script(/\p{Script=Arabic}/u, { ascent: 1.069, box: 1.703, tall: true }),
  script(/\p{Script=Bengali}/u, { ascent: 0.917, box: 1.325, tall: true }),
  script(/\p{Script=Bopomofo}/u, { ascent: 1.16, box: 1.448 }),
  script(/\p{Script=Devanagari}/u, { ascent: 0.896, box: 1.304, tall: true }),
  script(/\p{Script=Ethiopic}/u, { ascent: 1.069, box: 1.362 }),
  script(/\p{Script=Georgian}/u, { ascent: 1.068, box: 1.36 }),
  script(/\p{Script=Gujarati}/u, { ascent: 0.896, box: 1.305, tall: true }),
  script(/\p{Script=Gurmukhi}/u, { ascent: 0.896, box: 1.304, tall: true }),
  script(/\p{Script=Han}/u, { ascent: 1.16, box: 1.448 }),
  script(/\p{Script=Hangul}/u, { ascent: 1.16, box: 1.448 }),
  script(/\p{Script=Hebrew}/u, { ascent: 1.069, box: 1.362 }),
  script(/\p{Script=Hiragana}/u, { ascent: 1.16, box: 1.448 }),
  script(/\p{Script=Kannada}/u, { ascent: 0.809, box: 1.349, tall: true }),
  script(/\p{Script=Katakana}/u, { ascent: 1.16, box: 1.448 }),
  script(/\p{Script=Khmer}/u, { ascent: 1.069, box: 1.862 }),
  script(/\p{Script=Lao}/u, { ascent: 1.183, box: 1.645 }),
  script(/\p{Script=Malayalam}/u, { ascent: 0.864, box: 1.247, tall: true }),
  script(/\p{Script=Myanmar}/u, { ascent: 1.324, box: 2.184 }),
  script(/\p{Script=Oriya}/u, { ascent: 0.917, box: 1.4, tall: true }),
  script(/\p{Script=Sinhala}/u, { ascent: 1.011, box: 1.304, tall: true }),
  script(/\p{Script=Tamil}/u, { ascent: 0.87, box: 1.24, tall: true }),
  script(/\p{Script=Telugu}/u, { ascent: 0.869, box: 1.352, tall: true }),
  script(/\p{Script=Thaana}/u, { ascent: 1.069, box: 1.6, tall: true }),
  script(/\p{Script=Thai}/u, { ascent: 1.116, box: 1.372 }),
  script(/\p{Script=Yi}/u, { ascent: 1.16, box: 1.448 }),
  // These scripts fell inside the old 1.62em range, but their fallback fonts
  // were never measured: they keep that calibrated box and Roboto's ascent,
  // with no padding added to a box no font measured.
  calibrated(/\p{Script=Mandaic}/u),
  calibrated(/\p{Script=Nko}/u),
  calibrated(/\p{Script=Samaritan}/u),
  calibrated(/\p{Script=Syriac}/u),
];

/** No measured fallback font starts below Armenian, so Latin, Greek and Cyrillic skip the search. */
const FIRST_FALLBACK = 0x05_30;

/** The font Android draws one character in. */
function metricsOf(char: string): FontMetrics {
  if ((char.codePointAt(0) ?? 0) < FIRST_FALLBACK) {
    return ROBOTO;
  }
  for (const metrics of SCRIPTS) {
    if (metrics.match.test(char)) {
      return metrics;
    }
  }
  return ROBOTO;
}

/** The line box a TextView draws `value` in, in em. */
function boxOf(value: string): number {
  let box = LATIN_LINE;
  for (const char of value) {
    const metrics = metricsOf(char);
    if (metrics.box > box) {
      box = metrics.box;
    }
  }
  return box;
}

/** The ascent above the line's baseline, in em. */
function ascentOf(value: string): number {
  let tallest = BASELINE;
  for (const char of value) {
    const metrics = metricsOf(char);
    if (metrics.ascent > tallest) {
      tallest = metrics.ascent;
    }
  }
  return tallest;
}

/** The line box one line of `value` draws in at `size`: the tallest among its characters. */
export function lineBox(value: string, size: number): number {
  return Math.ceil(size * boxOf(value));
}

/** The ascent of one line of `value` at `size`; Latin-only text keeps Roboto's. */
export function ascent(value: string, size: number): number {
  return size * ascentOf(value);
}

/**
 * Whether one character takes a full em: East Asian Width `W` or `F`, which
 * covers the CJK scripts, the wide punctuation and fullwidth forms, the
 * supplementary-plane ideographs and every emoji.
 */
export function wideAdvance(char: string): boolean {
  return eastAsianWidth(char.codePointAt(0) ?? 0) === 2;
}
