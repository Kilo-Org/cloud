import { fromMicrodollars } from '@kilocode/app-shared/utils';

import { formatPrefixedMoney, formatPrefixedUsd } from '@/lib/format';

/**
 * A cost in the shape its own scale reads: the warehouse stores microdollars
 * and web's usage dashboard shows dollars, so the same conversion keeps the two
 * surfaces telling the same number.
 */
export function formatUsageCost(value: number, locale: string): string {
  return formatPrefixedMoney(fromMicrodollars(value), locale);
}

/**
 * A per-request average, which is usually a fraction of a cent: web formats
 * this one field with four fraction digits (`formatMicrodollars(value, 4)`), so
 * four digits keep a real $0.0043 from reading as no cost. The symbol leads like
 * every other amount on the screen.
 */
export function formatUsageCostPrecise(value: number, locale: string): string {
  return formatPrefixedUsd(fromMicrodollars(value), locale, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  });
}

/**
 * Turns a dimension key into a label. The warehouse stores slug-ish feature and
 * mode names (`code-review`, `smoke_mode`), and web's dashboard title-cases them
 * for display. Casing follows the reader's language: a Turkish `i` upper-cases
 * to `İ`, which a bare `toUpperCase()` would get wrong.
 */
export function humanizeDimension(value: string, locale: string): string {
  if (!value) {
    return value;
  }
  return value
    .replaceAll(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toLocaleUpperCase(locale) + word.slice(1).toLocaleLowerCase(locale))
    .join(' ');
}
