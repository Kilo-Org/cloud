import { afterEach, describe, expect, it, vi } from 'vitest';

import { dateTimeFormat, numberFormat, relativeTimeFormat } from './intl-cache';

describe('intl-cache', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns one formatter per locale and options pair', () => {
    const options = { style: 'currency', currency: 'USD' } as const;
    expect(numberFormat('de', options)).toBe(numberFormat('de', options));
    expect(numberFormat('de', options)).not.toBe(numberFormat('fr', options));
    expect(numberFormat('de', options)).not.toBe(
      numberFormat('de', { style: 'currency', currency: 'EUR' })
    );
  });

  it('caches date and relative-time formatters the same way', () => {
    expect(dateTimeFormat('ja', { dateStyle: 'medium' })).toBe(
      dateTimeFormat('ja', { dateStyle: 'medium' })
    );
    expect(relativeTimeFormat('pl', { numeric: 'auto' })).toBe(
      relativeTimeFormat('pl', { numeric: 'auto' })
    );
  });

  it('formats in the locale it was asked for', () => {
    expect(dateTimeFormat('en', { weekday: 'long' }).format(new Date('2026-08-24T12:00:00Z'))).toBe(
      'Monday'
    );
  });

  it('loads localized relative time when Hermes omits the constructor', () => {
    const nativeIntl = Intl;
    vi.stubGlobal('Intl', {
      Collator: nativeIntl.Collator,
      DateTimeFormat: nativeIntl.DateTimeFormat,
      getCanonicalLocales: nativeIntl.getCanonicalLocales,
      Locale: nativeIntl.Locale,
      NumberFormat: nativeIntl.NumberFormat,
      PluralRules: nativeIntl.PluralRules,
    });

    expect(relativeTimeFormat('de', { numeric: 'auto' }).format(-5, 'minute')).toBe(
      'vor 5 Minuten'
    );
  });
});
