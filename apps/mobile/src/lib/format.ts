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

export function formatUsd(
  amount: number,
  locale: string,
  options: Intl.NumberFormatOptions = {}
): string {
  return numberFormat(locale, {
    ...options,
    style: 'currency',
    currency: 'USD',
  })
    .formatToParts(amount)
    .map(part => (part.type === 'currency' ? '$' : part.value))
    .join('');
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

export function formatDate(date: Date, locale: string): string {
  return dateTimeFormat(locale, {}).format(date);
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

export function parseLocalizedNumber(value: string, locale: string): number | null {
  const parts = numberFormat(locale, { useGrouping: true }).formatToParts(-12_345.6);
  const part = (type: Intl.NumberFormatPartTypes, fallback: string) =>
    parts.find(item => item.type === type)?.value ?? fallback;
  const group = part('group', ',');
  const decimal = part('decimal', '.');
  const minus = part('minusSign', '-');
  const digits = new Map(
    Array.from({ length: 10 }, (_, digit) => [
      numberFormat(locale, { useGrouping: false }).format(digit),
      String(digit),
    ])
  );
  let normalized = value.trim().replaceAll(/[\u061C\u200E\u200F]/g, '');
  for (const [local, ascii] of digits) {
    normalized = normalized.split(local).join(ascii);
  }
  if (/^[\s\u00A0\u202F]+$/u.test(group)) {
    normalized = normalized.replaceAll(/[ \u00A0\u202F]/gu, group);
  }
  normalized = normalized.split(group).join('').split(decimal).join('.').split(minus).join('-');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
