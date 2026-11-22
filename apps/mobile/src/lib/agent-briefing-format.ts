import { boundedOneLineExcerpt, formatPrefixedMoney } from '@/lib/format';

/** Half of the smallest USD unit: below this, two decimals would read as zero. */
const SUB_CENT_USD = 0.005;
const SMALLEST_DISPLAYED_USD = 0.01;

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
 * A brief's preview reduced to what its card shows of it, so a name read aloud
 * stays about two lines of the card's row: at most
 * {@link BRIEFING_PREVIEW_MAX_GRAPHEMES} user-perceived characters on one line,
 * cut at that budget with a trailing ellipsis when the preview is longer.
 */
export function briefingPreviewExcerpt(text: string, locale: string): string {
  return boundedOneLineExcerpt(text, BRIEFING_PREVIEW_MAX_GRAPHEMES, locale);
}
