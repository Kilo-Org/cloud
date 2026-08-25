import { shouldPolyfill as shouldPolyfillRelativeTimeFormat } from '@formatjs/intl-relativetimeformat/should-polyfill.js';

import { isSupportedLanguage } from '@/i18n/languages';
import { RELATIVE_TIME_LOCALE_LOADERS } from '@/lib/relative-time-locales';

/**
 * Cached `Intl` formatters.
 *
 * Constructing a formatter is the expensive part; formatting with one is
 * cheap. A session list formats a cost and a relative time per row per render,
 * so a fresh formatter per call showed up as list-scroll jank. The cache is
 * keyed by locale plus options, and 86 languages times a handful of option
 * shapes is a small, bounded set.
 */
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateTimeFormats = new Map<string, Intl.DateTimeFormat>();
const relativeTimeFormats = new Map<string, Intl.RelativeTimeFormat>();
let usesRelativeTimePolyfill = false;

function ensureRelativeTimeFormat(locale: string): void {
  const language = isSupportedLanguage(locale) ? locale : 'en';
  if (!usesRelativeTimePolyfill && shouldPolyfillRelativeTimeFormat(language)) {
    require('@formatjs/intl-relativetimeformat/polyfill-force.js');
    usesRelativeTimePolyfill = true;
  }
  if (!usesRelativeTimePolyfill) {
    return;
  }
  RELATIVE_TIME_LOCALE_LOADERS[language]();
}

export function numberFormat(
  locale: Intl.LocalesArgument,
  options: Intl.NumberFormatOptions
): Intl.NumberFormat {
  const key = `${JSON.stringify(locale)}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

export function dateTimeFormat(
  locale: Intl.LocalesArgument,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${JSON.stringify(locale)}|${JSON.stringify(options)}`;
  let format = dateTimeFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, options);
    dateTimeFormats.set(key, format);
  }
  return format;
}

export function relativeTimeFormat(
  locale: string,
  options: Intl.RelativeTimeFormatOptions
): Intl.RelativeTimeFormat {
  ensureRelativeTimeFormat(locale);
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = relativeTimeFormats.get(key);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, options);
    relativeTimeFormats.set(key, format);
  }
  return format;
}
