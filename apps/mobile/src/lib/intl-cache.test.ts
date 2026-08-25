import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dateTimeFormat,
  durationFormat,
  listFormat,
  numberFormat,
  relativeTimeFormat,
  segmenter,
} from './intl-cache';

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

  it('polyfills the constructors that Hermes omits', () => {
    const nativeIntl = Intl;
    vi.stubGlobal('Intl', {
      Collator: nativeIntl.Collator,
      DateTimeFormat: nativeIntl.DateTimeFormat,
      getCanonicalLocales: nativeIntl.getCanonicalLocales,
      NumberFormat: nativeIntl.NumberFormat,
      PluralRules: nativeIntl.PluralRules,
    });

    expect(relativeTimeFormat('de', { numeric: 'auto' }).format(-5, 'minute')).toBe(
      'vor 5 Minuten'
    );
    expect(numberFormat('de', {}).format(1234.5)).toContain('1.234,5');
    expect(listFormat('de', { type: 'conjunction' }).format(['A', 'B'])).toBe('A und B');
    expect(durationFormat('en', { style: 'short' }).format({ hours: 1 })).toContain('1');
    expect([...segmenter('en', { granularity: 'grapheme' }).segment('👨‍👩‍👧‍👦X')]).toHaveLength(2);
    expect(Intl.Locale).toBeTypeOf('function');
  });
});
