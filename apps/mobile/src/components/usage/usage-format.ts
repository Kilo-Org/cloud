import { fromMicrodollars } from '@kilocode/app-shared/utils';

import { formatPrefixedMoney } from '@/lib/format';

/**
 * A cost in the shape its own scale reads: the warehouse stores microdollars
 * and web's usage dashboard shows dollars, so the same conversion keeps the two
 * surfaces telling the same number.
 */
export function formatUsageCost(value: number, locale: string): string {
  return formatPrefixedMoney(fromMicrodollars(value), locale);
}

/**
 * Turns a dimension key into a label. The warehouse stores slug-ish feature and
 * mode names (`code-review`, `smoke_mode`), and web's dashboard title-cases them
 * for display.
 */
export function humanizeDimension(value: string): string {
  if (!value) {
    return value;
  }
  return value
    .replaceAll(/[-_]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}
