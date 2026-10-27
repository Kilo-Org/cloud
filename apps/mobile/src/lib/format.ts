import {
  dateTimeFormat,
  deviceDecimalSeparator,
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
const DECIMAL_DIGIT = /\p{Nd}/u;

/**
 * Fold every Unicode decimal digit to ASCII. A keypad's digits follow its own
 * script, not the active app language: an Arabic keyboard types `٢٥` while the
 * `ar` locale formats with Latin digits. Unicode encodes each decimal digit set
 * as ten consecutive code points in ascending order, but adjacent sets share no
 * separator (the mathematical alphabets form one 50-code-point run), so a
 * digit's value is its offset from the start of its run modulo ten.
 */
export function foldDecimalDigits(value: string): string {
  return value.replaceAll(/\p{Nd}/gu, digit => {
    const codePoint = digit.codePointAt(0) ?? 0;
    let start = codePoint;
    while (DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) {
      start -= 1;
    }
    return String((codePoint - start) % 10);
  });
}

/** The separators and group sizes one locale's number formatter writes. */
type NumberGrammar = Readonly<{
  /** The group character, or `null` when the reading refuses grouping. */
  group: string | null;
  decimal: string;
  minus: string;
  firstSize: number;
  lastSize: number;
}>;

/** The grammar of the numbers `locale` writes, read from its own formatter. */
function numberGrammar(locale: string): NumberGrammar {
  const format = numberFormat(locale, { useGrouping: true });
  const parts = format.formatToParts(-12_345.6);
  const part = (type: Intl.NumberFormatPartTypes, fallback: string) =>
    parts.find(item => item.type === type)?.value.replaceAll(BIDI_MARK, '') ?? fallback;
  // The integer group sizes this locale writes: `[3]` for most, `[3, 2]` for
  // the Indian numbering system (hi, bn, gu, …), read from the formatter so the
  // grammar follows the same data that writes the numbers.
  const groupSizes = format
    .formatToParts(1_234_567_890)
    .filter(item => item.type === 'integer')
    .map(item => item.value.replaceAll(BIDI_MARK, '').length);
  const lastSize = groupSizes.at(-1) ?? 1;
  return {
    group: part('group', ','),
    decimal: part('decimal', '.'),
    minus: part('minusSign', '-'),
    firstSize: groupSizes.at(-2) ?? lastSize,
    lastSize,
  };
}

const escapeForRegExp = (value: string): string =>
  value.replaceAll(REGEXP_SPECIAL_CHARACTERS, String.raw`\$&`);

/**
 * The value `text` reads as under one grammar, or `null` when its separators do
 * not sit where that grammar writes them. The returned literal is ASCII so
 * callers can compare magnitudes.
 */
function readNumberText(text: string, grammar: NumberGrammar): string | null {
  const decimalChar = escapeForRegExp(grammar.decimal);
  let integerPart = String.raw`\d+`;
  if (grammar.group !== null) {
    const groupChar = escapeForRegExp(grammar.group);
    integerPart = `(?:\\d+|\\d{1,${grammar.firstSize}}(?:${groupChar}\\d{${grammar.firstSize}})*${groupChar}\\d{${grammar.lastSize}})`;
  }
  const shape = new RegExp(`^[+-]?(?:${integerPart}(?:${decimalChar}\\d*)?|${decimalChar}\\d+)$`);
  if (!shape.test(text)) {
    return null;
  }
  const ungrouped = grammar.group === null ? text : text.split(grammar.group).join('');
  return ungrouped.split(grammar.decimal).join('.');
}

/**
 * A number typed in the active locale as a plain ASCII decimal literal, or
 * `null` when the input is not one. Callers that compare magnitudes use this
 * form: a literal too large for a JS number stays a digit string instead of
 * collapsing into the same `null` a non-number produces.
 *
 * The language's own separators, digit shapes and group sizes decide what a
 * valid input is: at most one decimal separator, group separators only in the
 * positions that language writes, and none inside the fraction. A value that
 * does not match returns null.
 *
 * Ungrouped integers of any length are accepted, and grouping is optional: a
 * typed `1.234` has valid group positions even where the formatter leaves
 * four-digit numbers ungrouped.
 *
 * `deviceDecimal` is the decimal separator of the device's own number keyboard,
 * which on both platforms follows the device locale rather than the app
 * language: a German app language on a English (US) device offers only `.`
 * on `decimal-pad`. That reading is accepted when the language grammar cannot
 * read the input, and refused when both readings fit and disagree — `1.234` is
 * a thousand in German and 1.234 from a dot keypad, so the field cannot tell
 * which one the person meant.
 */
export function normalizeLocalizedNumber(
  value: string,
  locale: string,
  deviceDecimal: string | null = deviceDecimalSeparator()
): string | null {
  const grammar = numberGrammar(locale);
  let text = foldDecimalDigits(value.trim().replaceAll(BIDI_MARK, ''));
  if (grammar.group !== null && /^[\s\u00A0\u202F]+$/u.test(grammar.group)) {
    text = text.replaceAll(SPACE_VARIANTS, grammar.group);
  }
  if (grammar.minus !== '-') {
    text = text.split(grammar.minus).join('-');
  }
  const languageReading = readNumberText(text, grammar);
  const deviceReading =
    deviceDecimal === null || deviceDecimal === grammar.decimal
      ? null
      : readNumberText(text, {
          ...grammar,
          // One character cannot be both, so a device separator that is also the
          // language's group character leaves that reading with no grouping.
          group: grammar.group === deviceDecimal ? null : grammar.group,
          decimal: deviceDecimal,
        });
  if (languageReading === null) {
    return deviceReading;
  }
  if (deviceReading === null || deviceReading === languageReading) {
    return languageReading;
  }
  return null;
}

/** The literal `normalizeLocalizedNumber` accepts, read as a finite number. */
export function parseLocalizedNumber(
  value: string,
  locale: string,
  deviceDecimal: string | null = deviceDecimalSeparator()
): number | null {
  const normalized = normalizeLocalizedNumber(value, locale, deviceDecimal);
  if (normalized === null) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
