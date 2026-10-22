import {
  dateTimeFormat,
  durationFormat,
  listFormat,
  numberFormat,
  segmenter,
} from '@/lib/intl-cache';

/**
 * Mobile money/date formatters. Unlike the shared `formatDollars`/`formatCents`
 * helpers (which pin `en-US`), these take an explicit locale so the active
 * app language drives the output. FormatJS fills the constructors Hermes omits.
 */

/**
 * USD in the active language, with the currency symbol that language's own
 * data writes: most languages render `$`, and the ones that disambiguate the
 * dollar currency render `US$`, `$US`, `USD` or their own abbreviation. The
 * symbol therefore follows the same CLDR data as the non-USD branch of
 * `formatMoneyFromCents`.
 */
export function formatUsd(
  amount: number,
  locale: string,
  options: Intl.NumberFormatOptions = {}
): string {
  return numberFormat(locale, {
    ...options,
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

export function formatMoney(amount: number, locale: string): string {
  return formatUsd(amount, locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Currency with an explicit fraction-digit count. Session cost surfaces need
 * four decimals below half a cent and two above; the shared `formatMoney`
 * always pins two.
 */
export function formatCurrency(amount: number, locale: string, fractionDigits: number): string {
  return formatUsd(amount, locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** Amounts below this render as a zero currency value at four fraction digits (50 µ$). */
export const CURRENCY_ZERO_THRESHOLD = 50 / 1_000_000;

export function formatMoneyFromCents(amount: number, locale: string, currency = 'USD'): string {
  const normalizedCurrency = currency.toUpperCase();
  if (normalizedCurrency === 'USD') {
    return formatUsd(amount / 100, locale);
  }
  return numberFormat(locale, {
    style: 'currency',
    currency: normalizedCurrency,
  }).format(amount / 100);
}

export function formatDate(
  date: Date,
  locale: string,
  options: Intl.DateTimeFormatOptions = {}
): string {
  return dateTimeFormat(locale, options).format(date);
}

export function formatCalendarDate(value: string, locale: string): string {
  return dateTimeFormat(locale, { timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`));
}

export function formatNumber(
  value: number,
  locale: string,
  options: Intl.NumberFormatOptions = {}
): string {
  return numberFormat(locale, options).format(value);
}

export function formatPercent(value: number, locale: string): string {
  return numberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value / 100);
}

export function formatList(values: readonly string[], locale: string): string {
  return listFormat(locale, { style: 'long', type: 'conjunction' }).format(values);
}

export function formatDuration(seconds: number, locale: string): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  return durationFormat(locale, { style: 'short' }).format({
    hours,
    minutes,
    seconds: wholeSeconds % 60,
  });
}

export function formatFileSize(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return formatNumber(value, locale, {
    style: 'unit',
    unit: units[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 2,
  });
}

export function firstGrapheme(value: string, locale: string): string {
  return (
    segmenter(locale, { granularity: 'grapheme' }).segment(value)[Symbol.iterator]().next().value
      ?.segment ?? ''
  );
}

/** Characters with no bearing on a number's value but present in locale output. */
const BIDI_MARK = /[\u061C\u200E\u200F]/g;
/** The space characters a locale or a keyboard may use for a space-sized group separator. */
const SPACE_VARIANTS = /[ \u00A0\u202F]/gu;
/** Characters a locale's separator could contain that mean something in a RegExp body. */
const REGEXP_SPECIAL_CHARACTERS = /[.*+?^${}()|[\]\\]/g;

/**
 * Parse a number the person typed in the active language.
 *
 * The language's own separators, digit shapes and group sizes decide what a
 * valid input is: at most one decimal separator, group separators only in the
 * positions that language writes, and none inside the fraction. A value that
 * does not match returns null.
 *
 * Ungrouped integers of any length are accepted, and grouping is optional: a
 * typed `1.234` has valid group positions even where the formatter leaves
 * four-digit numbers ungrouped.
 */
export function parseLocalizedNumber(value: string, locale: string): number | null {
  const format = numberFormat(locale, { useGrouping: true });
  const parts = format.formatToParts(-12_345.6);
  const part = (type: Intl.NumberFormatPartTypes, fallback: string) =>
    parts.find(item => item.type === type)?.value.replaceAll(BIDI_MARK, '') ?? fallback;
  const group = part('group', ',');
  const decimal = part('decimal', '.');
  const minus = part('minusSign', '-');
  // The integer group sizes this locale writes: `[3]` for most, `[3, 2]` for
  // the Indian numbering system (hi, bn, gu, …), read from the formatter so the
  // grammar follows the same data that writes the numbers.
  const groupSizes = format
    .formatToParts(1_234_567_890)
    .filter(item => item.type === 'integer')
    .map(item => item.value.replaceAll(BIDI_MARK, '').length);
  const lastSize = groupSizes.at(-1) ?? 1;
  const firstSize = groupSizes.at(-2) ?? lastSize;
  const digits = new Map(
    Array.from({ length: 10 }, (_, digit) => [
      numberFormat(locale, { useGrouping: false }).format(digit),
      String(digit),
    ])
  );
  let normalized = value.trim().replaceAll(BIDI_MARK, '');
  for (const [local, ascii] of digits) {
    normalized = normalized.split(local).join(ascii);
  }
  if (/^[\s\u00A0\u202F]+$/u.test(group)) {
    normalized = normalized.replaceAll(SPACE_VARIANTS, group);
  }
  if (minus !== '-') {
    normalized = normalized.split(minus).join('-');
  }
  const groupChar = group.replaceAll(REGEXP_SPECIAL_CHARACTERS, String.raw`\$&`);
  const grouped = `\\d{1,${firstSize}}(?:${groupChar}\\d{${firstSize}})*${groupChar}\\d{${lastSize}}`;
  const integerPart = `(?:\\d+|${grouped})`;
  const decimalChar = decimal.replaceAll(REGEXP_SPECIAL_CHARACTERS, String.raw`\$&`);
  const shape = new RegExp(`^[+-]?(?:${integerPart}(?:${decimalChar}\\d*)?|${decimalChar}\\d+)$`);
  if (!shape.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized.split(group).join('').split(decimal).join('.'));
  return Number.isFinite(parsed) ? parsed : null;
}
