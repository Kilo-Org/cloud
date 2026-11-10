import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dateTimeFormat,
  durationFormat,
  listFormat,
  numberFormat,
  prewarmIntl,
  relativeTimeFormat,
  segmenter,
} from './intl-cache';

/** Stands in for a formatter Hermes does not provide. */
function failingFormat(): never {
  throw new Error('boom');
}

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

  it('formats in the new device time zone after the zone moves', () => {
    const instant = new Date('2026-11-04T01:10:00.000Z');
    const options = { hour: 'numeric', minute: '2-digit' } as const;
    const originalZone = process.env.TZ;
    const restoreZone = () => {
      if (originalZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalZone;
      }
    };
    vi.useFakeTimers();
    try {
      process.env.TZ = 'UTC';
      vi.advanceTimersByTime(2000);
      expect(dateTimeFormat('en', options).format(instant)).toBe('1:10 AM');

      // The device zone moved, and enough time passed for the cache to notice.
      process.env.TZ = 'Pacific/Auckland';
      vi.advanceTimersByTime(2000);
      expect(dateTimeFormat('en', options).format(instant)).toBe('2:10 PM');

      restoreZone();
      vi.advanceTimersByTime(2000);
      // Whatever zone the test host runs in: a formatter built now agrees with
      // the zone the process is back in, not with the zone it left.
      expect(dateTimeFormat('en', options).format(instant)).toBe(
        new Intl.DateTimeFormat('en', options).format(instant)
      );
    } finally {
      restoreZone();
      vi.useRealTimers();
    }
  });

  it('keeps a formatter it rebuilt inside the check interval', () => {
    const options = { weekday: 'long' } as const;
    const originalZone = process.env.TZ;
    vi.useFakeTimers();
    try {
      process.env.TZ = 'UTC';
      vi.advanceTimersByTime(2000);
      const first = dateTimeFormat('en', options);
      vi.advanceTimersByTime(200);
      expect(dateTimeFormat('en', options)).toBe(first);
    } finally {
      if (originalZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalZone;
      }
      vi.useRealTimers();
    }
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

    // First, deliberately: a tag no `@formatjs` locale list carries — the
    // others are `zh-Hans`, `zh-Hant`, `ht` and `pt-BR`. `shouldPolyfill`
    // cannot match one by lookup, so it falls through to the CLDR best-fit
    // matcher, which constructs `Intl.Locale`. This is the call that used to
    // throw, before any other had installed that polyfill.
    expect(numberFormat('mi', {}).format(1234.5)).toMatch(/1/);
    expect(relativeTimeFormat('de', { numeric: 'auto' }).format(-5, 'minute')).toBe(
      'vor 5 Minuten'
    );
    expect(numberFormat('de', {}).format(1234.5)).toContain('1.234,5');
    expect(listFormat('de', { type: 'conjunction' }).format(['A', 'B'])).toBe('A und B');
    expect(durationFormat('en', { style: 'short' }).format({ hours: 1 })).toContain('1');
    expect([...segmenter('en', { granularity: 'grapheme' }).segment('👨‍👩‍👧‍👦X')]).toHaveLength(2);
    expect(Intl.Locale).toBeTypeOf('function');
  });

  it('prewarmIntl does not throw when a formatter constructor fails', () => {
    vi.stubGlobal('Intl', { ...Intl, DurationFormat: failingFormat });

    // A locale no other test warms, so the caches cannot hide the failure.
    expect(() => {
      prewarmIntl('sv');
    }).not.toThrow();
  });
});
