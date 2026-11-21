import { formatPrefixedMoney } from '@/lib/format';

/** Half of the smallest USD unit: below this, two decimals would read as zero. */
const SUB_CENT_USD = 0.005;
const SMALLEST_DISPLAYED_USD = 0.01;

export function briefingMoney(microdollars: number, language: string): string {
  const amount = microdollars / 1_000_000;
  if (amount > 0 && amount < SUB_CENT_USD) {
    return `< ${formatPrefixedMoney(SMALLEST_DISPLAYED_USD, language)}`;
  }
  return formatPrefixedMoney(amount, language);
}
