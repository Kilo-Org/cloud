import { i18n } from '@/i18n';
import { segmenter } from '@/lib/intl-cache';

/**
 * The first `count` user-perceived characters of `value`, and whether the value
 * holds more.
 *
 * Cutting by code unit could end a label on half a surrogate pair; cutting by
 * code point could still split a character this reader sees as one, such as a
 * family emoji or a Devanagari syllable with its vowel sign. The segmenter is
 * iterated only as far as `count` plus one, so a long message costs the cap
 * rather than its own length.
 */
export function firstGraphemes(value: string, count: number) {
  let text = '';
  let seen = 0;
  for (const { segment } of segmenter(i18n.language, { granularity: 'grapheme' }).segment(value)) {
    if (seen === count) {
      return { text, more: true };
    }
    text += segment;
    seen += 1;
  }
  return { text, more: false };
}

/**
 * How many code units on each side of the budget a cut looks at. A run of more
 * combining marks than this at the cut falls back to a code-point boundary.
 */
const CUT_WINDOW = 1024;

/**
 * The longest prefix of `value` that is at most `maxCodeUnits` UTF-16 code
 * units long and ends on a whole user-perceived character.
 *
 * The budget stays in code units because it is a display and memory bound, not
 * a label width: a multi-megabyte tool payload must cost the cap to lay out.
 * The cut, though, lands on a cluster boundary — a lone surrogate or half a ZWJ
 * sequence renders as a replacement glyph.
 *
 * Only a window this size on each side of the budget is segmented, never the
 * whole value. Hermes has no `Intl.Segmenter`; `@formatjs/intl-segmenter` steps
 * by copying the rest of the string it was given, so segmenting a payload
 * megabytes long would cost its length per cluster. The window cannot split a
 * cluster that fits in it: a cluster reaching past the window start is never
 * counted as ended, and the cut then backs off to that start, moved off half a
 * surrogate pair.
 */
export function graphemePrefixWithin(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) {
    return value;
  }
  let start = Math.max(0, maxCodeUnits - CUT_WINDOW);
  if (start > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(start - 1))) {
    start -= 1;
  }
  const window = value.slice(start, Math.min(value.length, maxCodeUnits + CUT_WINDOW));
  const budget = maxCodeUnits - start;
  let index = 0;
  let count = 0;
  let end = -1;
  for (const { segment } of segmenter(i18n.language, { granularity: 'grapheme' }).segment(window)) {
    index += segment.length;
    count += 1;
    // The first segment of a window that starts mid-value only ends where that
    // window put it, so it is not a boundary of the whole value.
    if ((start === 0 || count > 1) && index <= budget) {
      end = index;
    }
  }
  return value.slice(0, end === -1 ? start : start + end);
}
