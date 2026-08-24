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

export function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

export function dateTimeFormat(
  locale: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
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
  const key = `${locale}|${JSON.stringify(options)}`;
  let format = relativeTimeFormats.get(key);
  if (!format) {
    format = new Intl.RelativeTimeFormat(locale, options);
    relativeTimeFormats.set(key, format);
  }
  return format;
}
