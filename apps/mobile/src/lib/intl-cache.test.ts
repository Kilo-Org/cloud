import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dateTimeFormat,
  deviceTimeZone,
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

/**
 * Stub the device zone the way a device that moved reports it: the production
 * probe builds a fresh `Intl.DateTimeFormat` with no zone and reads the zone it
 * resolved, so the stub answers `getZone()` for every formatter that pins none.
 */
function stubDeviceZone(getZone: () => string): void {
  const realIntl = Intl;
  // `Intl`'s properties are not enumerable, so a copy loses the constructors
  // the polyfill path reads: inherit the whole object instead.
  const stub: typeof Intl = Object.create(realIntl);
  Object.defineProperty(stub, 'DateTimeFormat', {
    value: function DateTimeFormat(
      locales?: string | string[],
      options?: Intl.DateTimeFormatOptions
    ): Intl.DateTimeFormat {
      return new realIntl.DateTimeFormat(locales, {
        ...options,
        timeZone: options?.timeZone ?? getZone(),
      });
    },
  });
  vi.stubGlobal('Intl', stub);
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

  it('reports the device zone through the same probe that drops the cache', () => {
    expect(deviceTimeZone()).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('formats in the locale it was asked for', () => {
    expect(dateTimeFormat('en', { weekday: 'long' }).format(new Date('2026-08-24T12:00:00Z'))).toBe(
      'Monday'
    );
  });

  it('formats in the new device time zone after the zone moves', () => {
    const instant = new Date('2026-11-04T01:10:00.000Z');
    const options = { hour: 'numeric', minute: '2-digit' } as const;
    let zone = 'UTC';
    stubDeviceZone(() => zone);
    vi.useFakeTimers();
    try {
      // Enough time for the probe to re-check the zone earlier tests cached.
      vi.advanceTimersByTime(2000);
      const utcFormatter = dateTimeFormat('en', options);
      expect(utcFormatter.format(instant)).toBe('1:10 AM');

      // The device zone moved, and enough time passed for the cache to notice.
      zone = 'Pacific/Auckland';
      vi.advanceTimersByTime(2000);
      const movedFormatter = dateTimeFormat('en', options);
      expect(movedFormatter).not.toBe(utcFormatter);
      expect(movedFormatter.format(instant)).toBe('2:10 PM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a formatter it rebuilt inside the check interval', () => {
    const options = { weekday: 'long' } as const;
    let zone = 'UTC';
    stubDeviceZone(() => zone);
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(2000);
      const first = dateTimeFormat('en', options);
      // The zone moved, but inside the check interval the probe does not look
      // again, so the cache keeps the formatter it already built.
      zone = 'Pacific/Auckland';
      vi.advanceTimersByTime(200);
      expect(dateTimeFormat('en', options)).toBe(first);
    } finally {
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
