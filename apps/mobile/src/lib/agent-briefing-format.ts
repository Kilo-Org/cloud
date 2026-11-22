import { formatPrefixedMoney } from '@/lib/format';
import { segmenter } from '@/lib/intl-cache';

/** Half of the smallest USD unit: below this, two decimals would read as zero. */
const SUB_CENT_USD = 0.005;
const SMALLEST_DISPLAYED_USD = 0.01;

const ELLIPSIS = '…';

/**
 * How many user-perceived characters of a brief preview the card's spoken name
 * carries.
 *
 * The card's summary row is two lines of `text-sm` at its width, which holds
 * about this many characters. A name bounded here stays the length of the
 * preview the card shows instead of growing with the summary the card cuts.
 */
export const BRIEFING_PREVIEW_MAX_GRAPHEMES = 100;

export function briefingMoney(microdollars: number, language: string): string {
  const amount = microdollars / 1_000_000;
  if (amount > 0 && amount < SUB_CENT_USD) {
    return `< ${formatPrefixedMoney(SMALLEST_DISPLAYED_USD, language)}`;
  }
  return formatPrefixedMoney(amount, language);
}

/**
 * A brief's preview reduced to what its card shows of it: whitespace runs (line
 * breaks included) collapse to single spaces, the ends are trimmed, and a
 * preview longer than {@link BRIEFING_PREVIEW_MAX_GRAPHEMES} is cut short at
 * that budget with a trailing ellipsis, so a name read aloud stays about two
 * lines of the card's row.
 *
 * A cut must never split a character the reader sees as one, so the boundary is
 * segmented in the app's language rather than counted in code units: counted
 * that way, a family emoji or a Devanagari syllable with its vowel sign would
 * come apart into pieces nobody reads as characters. The segmenter is iterated
 * only as far as the budget, so a long summary costs the budget rather than its
 * own length.
 */
export function briefingPreviewExcerpt(text: string, locale: string): string {
  const oneLine = text.replaceAll(/\s+/gu, ' ').trim();
  // A string no longer than the budget in code units holds no more characters
  // than that, so the common short preview never reaches the segmenter.
  if (oneLine.length <= BRIEFING_PREVIEW_MAX_GRAPHEMES) {
    return oneLine;
  }
  const head = firstGraphemes(oneLine, BRIEFING_PREVIEW_MAX_GRAPHEMES, locale);
  if (!head.more) {
    return oneLine;
  }
  const cut = firstGraphemes(oneLine, BRIEFING_PREVIEW_MAX_GRAPHEMES - 1, locale).text;
  return `${cut.trimEnd()}${ELLIPSIS}`;
}

/**
 * The first `count` user-perceived characters of `value`, and whether the value
 * holds more.
 */
function firstGraphemes(value: string, count: number, locale: string) {
  let text = '';
  let seen = 0;
  for (const { segment } of segmenter(locale, { granularity: 'grapheme' }).segment(value)) {
    if (seen === count) {
      return { text, more: true };
    }
    text += segment;
    seen += 1;
  }
  return { text, more: false };
}
