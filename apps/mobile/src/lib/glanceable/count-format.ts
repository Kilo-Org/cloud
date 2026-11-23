import { i18n } from '@/i18n';
import { numberFormat } from '@/lib/intl-cache';

/**
 * One count formatter for every glanceable surface.
 *
 * The widget extension has no number formatter: a pushed content state carries
 * raw numbers, so the app bakes the digits, the grouping separator and this
 * count format into the layout. Both platforms read the same formatter, so an
 * accessible label and the drawn row beside it never disagree about a number.
 */
export type GlanceableCountFormat = (value: number) => string;

/**
 * Draw a count in the active language's own digits and grouping.
 *
 * The widget process has no formatter, so the layout stringifies its counts
 * from this one, and the spoken label reads the same values.
 */
export function formatGlanceableCount(value: number): string {
  return numberFormat(i18n.language, { useGrouping: true }).format(value);
}

/**
 * The active language's ten digits, or an empty string when it writes them the
 * way the layout already does.
 *
 * The layout stringifies its counts itself, because a pushed content state
 * carries raw numbers and the widget process has no formatter, so an Arabic
 * row drew "1" beside a wait SwiftUI had formatted as "٢٦ د". Baking the digits
 * lets the layout map its own — one table, every surface, push included.
 */
export function glanceableDigits(): string {
  const formatter = numberFormat(i18n.language, { useGrouping: false });
  const digits = Array.from({ length: 10 }, (_, digit) => formatter.format(digit)).join('');
  return digits === '0123456789' ? '' : digits;
}

/**
 * The active language's thousands separator, or an empty string when it has
 * none or writes more than one character there. The widget process has no
 * formatter, so the Home layout groups its own counts with this ("1,234",
 * "1.234", "١٬٢٣٤").
 */
export function glanceableGroupSeparator(): string {
  const grouped = numberFormat(i18n.language, { useGrouping: true }).format(10_000);
  const separator = grouped.slice(2, -3);
  return separator.length === 1 ? separator : '';
}
