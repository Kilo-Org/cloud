import { shouldPolyfill as shouldPolyfillDurationFormat } from '@formatjs/intl-durationformat/should-polyfill.js';
import { shouldPolyfill as shouldPolyfillListFormat } from '@formatjs/intl-listformat/should-polyfill.js';
import { shouldPolyfill as shouldPolyfillLocale } from '@formatjs/intl-locale/should-polyfill.js';
import { shouldPolyfill as shouldPolyfillNumberFormat } from '@formatjs/intl-numberformat/should-polyfill.js';
import { shouldPolyfill as shouldPolyfillPluralRules } from '@formatjs/intl-pluralrules/should-polyfill.js';
import { shouldPolyfill as shouldPolyfillRelativeTimeFormat } from '@formatjs/intl-relativetimeformat/should-polyfill.js';
import { shouldPolyfill as shouldPolyfillSegmenter } from '@formatjs/intl-segmenter/should-polyfill.js';

import { isSupportedLanguage, type SupportedLanguage } from '@/i18n/languages';
import {
  loadListFormatLocaleData,
  loadNumberFormatLocaleData,
  loadPluralRulesLocaleData,
} from '@/lib/formatjs-locale-data';
import { RELATIVE_TIME_LOCALE_LOADERS } from '@/lib/relative-time-locales';

/**
 * Cached `Intl` formatters.
 *
 * Constructing a formatter is the expensive part; formatting with one is
 * cheap. A session list formats a cost and a relative time per row per render,
 * so a fresh formatter per call showed up as list-scroll jank. The cache is
 * keyed by locale plus options, and 87 languages times a handful of option
 * shapes is a small, bounded set.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();
const listFormats = new Map<string, Intl.ListFormat>();
const durationFormats = new Map<string, Intl.DurationFormat>();
const collators = new Map<string, Intl.Collator>();
const segmenters = new Map<string, Intl.Segmenter>();
let usesNumberFormatPolyfill = false;
let usesPluralRulesPolyfill = false;
let usesListFormatPolyfill = false;
let usesRelativeTimePolyfill = false;
let usesDurationFormatPolyfill = false;
let usesSegmenterPolyfill = false;
let usesLocalePolyfill = false;

/**
 * The tag every formatter is built with.
 *
 * A bare tag can resolve to data the catalog does not use. `pt` resolves to
 * Brazilian data while the `pt` catalog is European Portuguese, and `sr`
 * resolves to Cyrillic while the `sr` catalog is written in Latin — a Serbian
 * user would read Latin copy beside a Cyrillic month name. Name the script or
 * the region so every Intl surface agrees with the catalog.
 */
function localeOrEnglish(locale: string): string {
  if (!locale) {
    return 'en';
  }
  if (locale === 'pt') {
    return 'pt-PT';
  }
  return locale === 'sr' ? 'sr-Latn' : locale;
}

function localeDataLanguage(locale: string): SupportedLanguage {
  if (isSupportedLanguage(locale)) {
    return locale;
  }
  const base = locale.split('-')[0] ?? 'en';
  return isSupportedLanguage(base) ? base : 'en';
}

function ensureLocale(): void {
  if (!usesLocalePolyfill && shouldPolyfillLocale()) {
    require('@formatjs/intl-locale/polyfill-force.js');
    usesLocalePolyfill = true;
  }
}

// Hermes ships without Intl.PluralRules, and the NumberFormat and
// RelativeTimeFormat polyfills construct one.
function ensurePluralRules(language: SupportedLanguage): void {
  if (!usesPluralRulesPolyfill && shouldPolyfillPluralRules(language)) {
    require('@formatjs/intl-pluralrules/polyfill-force.js');
    usesPluralRulesPolyfill = true;
  }
  if (usesPluralRulesPolyfill) {
    ensureLocale();
    loadPluralRulesLocaleData(language);
  }
}

function ensureNumberFormat(locale: string): void {
  const language = localeDataLanguage(locale);
  ensurePluralRules(language);
  if (!usesNumberFormatPolyfill && shouldPolyfillNumberFormat(locale)) {
    require('@formatjs/intl-numberformat/polyfill-force.js');
    usesNumberFormatPolyfill = true;
  }
  if (usesNumberFormatPolyfill) {
    ensureLocale();
    loadNumberFormatLocaleData(language);
  }
}

function ensureListFormat(locale: string): void {
  const language = localeDataLanguage(locale);
  if (!usesListFormatPolyfill && shouldPolyfillListFormat(locale)) {
    require('@formatjs/intl-listformat/polyfill-force.js');
    usesListFormatPolyfill = true;
  }
  if (usesListFormatPolyfill) {
    ensureLocale();
    loadListFormatLocaleData(language);
  }
}

function ensureRelativeTimeFormat(locale: string): void {
  const language = localeDataLanguage(locale);
  ensureNumberFormat(locale);
  if (!usesRelativeTimePolyfill && shouldPolyfillRelativeTimeFormat(language)) {
    require('@formatjs/intl-relativetimeformat/polyfill-force.js');
    usesRelativeTimePolyfill = true;
  }
  if (!usesRelativeTimePolyfill) {
    return;
  }
  ensureLocale();
  RELATIVE_TIME_LOCALE_LOADERS[language]();
}

export function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const activeLocale = localeOrEnglish(locale);
  ensureNumberFormat(activeLocale);
  const key = `${JSON.stringify(activeLocale)}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(activeLocale, options);
    numberFormats.set(key, format);
  }
  return format;
}

export function dateTimeFormat(
  /** Omitted only to read the device's own resolved options, e.g. its time zone. */
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  // Through `localeOrEnglish` like every other formatter: this used to carry
  // its own `pt` special case and so missed the `sr` one added beside it.
  const activeLocale = locale === undefined ? undefined : localeOrEnglish(locale);
  const key = `${JSON.stringify(activeLocale)}|${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(activeLocale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

export function relativeTimeFormat(
  locale: string,
  options: Intl.RelativeTimeFormatOptions
): Intl.RelativeTimeFormat {
  const activeLocale = localeOrEnglish(locale);
  ensureRelativeTimeFormat(activeLocale);
  const key = `${activeLocale}|${JSON.stringify(options)}`;
  let format = relativeTimeFormats.get(key);
  if (!format) {
    format = new Intl.RelativeTimeFormat(activeLocale, options);
    relativeTimeFormats.set(key, format);
  }
  return format;
}

export function listFormat(locale: string, options: Intl.ListFormatOptions): Intl.ListFormat {
  const activeLocale = localeOrEnglish(locale);
  ensureListFormat(activeLocale);
  const key = `${activeLocale}|${JSON.stringify(options)}`;
  let format = listFormats.get(key);
  if (!format) {
    format = new Intl.ListFormat(activeLocale, options);
    listFormats.set(key, format);
  }
  return format;
}

export function durationFormat(
  locale: string,
  options: Intl.DurationFormatOptions
): Intl.DurationFormat {
  const activeLocale = localeOrEnglish(locale);
  ensureNumberFormat(activeLocale);
  ensureListFormat(activeLocale);
  if (!usesDurationFormatPolyfill && shouldPolyfillDurationFormat()) {
    require('@formatjs/intl-durationformat/polyfill-force.js');
    usesDurationFormatPolyfill = true;
  }
  const key = `${activeLocale}|${JSON.stringify(options)}`;
  let format = durationFormats.get(key);
  if (!format) {
    format = new Intl.DurationFormat(activeLocale, options);
    durationFormats.set(key, format);
  }
  return format;
}

export function collator(locale: string, options: Intl.CollatorOptions = {}): Intl.Collator {
  const activeLocale = localeOrEnglish(locale);
  const key = `${activeLocale}|${JSON.stringify(options)}`;
  let format = collators.get(key);
  if (!format) {
    format = new Intl.Collator(activeLocale, options);
    collators.set(key, format);
  }
  return format;
}

export function segmenter(locale: string, options: Intl.SegmenterOptions): Intl.Segmenter {
  const activeLocale = localeOrEnglish(locale);
  if (!usesSegmenterPolyfill && shouldPolyfillSegmenter()) {
    require('@formatjs/intl-segmenter/polyfill-force.js');
    usesSegmenterPolyfill = true;
  }
  const key = `${activeLocale}|${JSON.stringify(options)}`;
  let format = segmenters.get(key);
  if (!format) {
    format = new Intl.Segmenter(activeLocale, options);
    segmenters.set(key, format);
  }
  return format;
}

export function prewarmIntl(locale: string): void {
  try {
    numberFormat(locale, {});
    listFormat(locale, { type: 'conjunction' });
    relativeTimeFormat(locale, { numeric: 'auto' });
    durationFormat(locale, { style: 'short' });
    segmenter(locale, { granularity: 'grapheme' });
  } catch {
    // A prewarm is only a cache fill. Every formatter is built again on demand
    // at the real call site, so a failure must not block the app.
  }
}
