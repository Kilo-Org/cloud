import { numberFormat } from '@/lib/intl-cache';

/** Half of the smallest USD unit: below this, two decimals would read as zero. */
const SUB_CENT_USD = 0.005;
const SMALLEST_DISPLAYED_USD = 0.01;

/**
 * Money shown on a briefing surface: scorecard totals, agent rows, estimates
 * and charges. The currency's own precision, in the active app language, so
 * every one of those agrees; a positive amount too small for that precision
 * reads as below the smallest unit instead of as a rounded zero.
 *
 * A `lowerBound` amount is a floor: callers prefix it with their "at least"
 * copy, so it says the smallest unit is the bound rather than claiming the
 * amount is below it.
 */
export function briefingMoney(
  microdollars: number,
  language: string,
  { lowerBound = false }: { readonly lowerBound?: boolean } = {}
): string {
  const amount = microdollars / 1_000_000;
  const format = numberFormat(language, { style: 'currency', currency: 'USD' });
  if (amount > 0 && amount < SUB_CENT_USD) {
    return lowerBound ? format.format(0) : `< ${format.format(SMALLEST_DISPLAYED_USD)}`;
  }
  return format.format(amount);
}
