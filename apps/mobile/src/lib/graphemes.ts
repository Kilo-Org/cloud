import { i18n } from '@/i18n';
import { segmenter } from '@/lib/intl-cache';

/**
 * How many code units `firstGraphemes` segments before it reads a longer prefix.
 * Small enough that the polyfill's per-step copy stays cheap, and large enough
 * that an ordinary label is read in one pass.
 */
const PROBE_STEP = 256;

/** How many code units the probe allows one user-perceived character before it stops growing. */
const MAX_CLUSTER_UNITS = 64;

/**
 * The first `count` user-perceived characters of `value`, and whether the value
 * holds more.
 *
 * Cutting by code unit could end a label on half a surrogate pair; cutting by
 * code point could still split a character this reader sees as one, such as a
 * family emoji or a Devanagari syllable with its vowel sign.
 *
 * A tool label is arbitrary input, so the segmenter never sees the whole value.
 * Hermes has no `Intl.Segmenter`; `@formatjs/intl-segmenter` steps by copying
 * the rest of the string it was given, so segmenting a long command line would
 * cost its length per character. The probe starts short and grows only while it
 * ends before `count` whole characters, and it stops at `count *
 * MAX_CLUSTER_UNITS` code units (never below `PROBE_STEP`). A value holding
 * fewer characters than `count` therefore never reads more than that many code
 * units, and comes back as the whole characters before the cut plus the
 * ellipsis, instead of being read whole in steps whose copies add up to its
 * length squared.
 *
 * A cluster that touches the probe's edge may be cut by the probe itself, so
 * the segment ending at that edge is not read as a character: it is only whole
 * when the probe reached the end of the value. One cluster longer than the
 * ceiling leaves no whole character before the cut, so `text` is empty and
 * `more` is true: the label is the ellipsis alone.
 */
export function firstGraphemes(value: string, count: number) {
  const limit = Math.min(value.length, Math.max(PROBE_STEP, count * MAX_CLUSTER_UNITS));
  let probe = Math.min(limit, Math.max(PROBE_STEP, count * 2));
  for (;;) {
    const truncated = probe < value.length;
    let text = '';
    let seen = 0;
    let index = 0;
    for (const { segment } of segmenter(i18n.language, { granularity: 'grapheme' }).segment(
      value.slice(0, probe)
    )) {
      const next = index + segment.length;
      if (truncated && next === probe) {
        break;
      }
      index = next;
      if (seen === count) {
        return { text, more: true };
      }
      text += segment;
      seen += 1;
    }
    if (!truncated) {
      return { text, more: false };
    }
    if (probe === limit) {
      return { text, more: true };
    }
    probe = Math.min(limit, probe * 4);
  }
}

/**
 * How many code units before the budget a cut looks for its character boundary.
 * A cluster longer than this at the cut falls back to a code-point boundary.
 */
const CUT_WINDOW = 1024;

/** The first and last regional-indicator code points, U+1F1E6 and U+1F1FF. */
const REGIONAL_INDICATOR_FIRST = 127_462;
const REGIONAL_INDICATOR_LAST = 127_487;

/** Whether the code point ending at `end` is a regional indicator (a flag half). */
function isRegionalIndicatorEndingAt(value: string, end: number): boolean {
  if (end < 2) {
    return false;
  }
  const code = value.codePointAt(end - 2);
  return code !== undefined && code >= REGIONAL_INDICATOR_FIRST && code <= REGIONAL_INDICATOR_LAST;
}

/**
 * The longest prefix of `value` that is at most `maxCodeUnits` UTF-16 code
 * units long and ends on a whole user-perceived character.
 *
 * The budget stays in code units because it is a display and memory bound, not
 * a label width: a multi-megabyte tool payload must cost the cap to lay out.
 * The cut, though, lands on a cluster boundary — a lone surrogate or half a ZWJ
 * sequence renders as a replacement glyph.
 *
 * Only a window around the budget is segmented, never the whole value, because
 * `@formatjs/intl-segmenter` steps by copying the rest of the string it was
 * given. Two rules keep the window honest: a segment that ends at the window's
 * start is not a boundary of the value, so it is never counted; and the window
 * opens at the start of a regional-indicator run, because the segmenter pairs
 * indicators from the start of their run and a window opened inside one would
 * pair the wrong two.
 *
 * The run-start walk is bounded by the same window, so a cut costs the same
 * whatever the payload. A run of more than 256 flags in a row is longer than
 * that bound; a cut inside one backs off to the window's own start, which is
 * never inside a surrogate pair, and may sit between two indicators.
 */
export function graphemePrefixWithin(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) {
    return value;
  }
  let start = Math.max(0, maxCodeUnits - CUT_WINDOW);
  if (start > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(start - 1))) {
    start -= 1;
  }
  const anchorLimit = Math.max(0, start - CUT_WINDOW);
  while (start > anchorLimit && isRegionalIndicatorEndingAt(value, start)) {
    start -= 2;
  }
  // The walk stopped at its bound while still inside a run, so this start's own
  // pairing is unknown: cut there rather than report a boundary that may split
  // a pair. Nothing is segmented, because no boundary of this window is trusted.
  if (isRegionalIndicatorEndingAt(value, start)) {
    return value.slice(0, start);
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
