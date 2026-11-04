import { numberFormat } from '@/lib/intl-cache';

/** Half of the smallest USD unit: below this, two decimals would read as zero. */
const SUB_CENT_USD = 0.005;
const SMALLEST_DISPLAYED_USD = 0.01;

export function briefingMoney(microdollars: number, language: string): string {
  const amount = microdollars / 1_000_000;
  const format = numberFormat(language, { style: 'currency', currency: 'USD' });
  if (amount > 0 && amount < SUB_CENT_USD) {
    return `< ${format.format(SMALLEST_DISPLAYED_USD)}`;
  }
  return format.format(amount);
}
