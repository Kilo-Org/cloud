import { describe, expect, it, vi } from 'vitest';

import {
  epochMsToIso,
  formatCents,
  formatDollars,
  parseTimestamp,
  timestampMs,
  timestampToIso,
} from './utils';

function inTimeZone<T>(timeZone: string, run: () => T): T {
  vi.stubEnv('TZ', timeZone);
  try {
    return run();
  } finally {
    vi.unstubAllEnvs();
  }
}

function calendarParts(date: Date): number[] {
  return [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()];
}

describe('parseTimestamp', () => {
  it('parses a date-only string as local midnight west of UTC', () => {
    inTimeZone('America/Los_Angeles', () => {
      const date = parseTimestamp('2026-09-26');
      expect(date.toISOString()).toBe('2026-09-26T07:00:00.000Z');
      expect(calendarParts(date)).toEqual([2026, 8, 26, 0]);
      expect(date.toLocaleDateString('en-US')).toBe('9/26/2026');
    });
  });

  it('parses a date-only string as local midnight east of UTC', () => {
    inTimeZone('Asia/Tokyo', () => {
      const date = parseTimestamp('2026-09-26');
      expect(date.toISOString()).toBe('2026-09-25T15:00:00.000Z');
      expect(calendarParts(date)).toEqual([2026, 8, 26, 0]);
      expect(date.toLocaleDateString('en-US')).toBe('9/26/2026');
    });
  });

  it('parses a date-only string as local midnight at UTC', () => {
    inTimeZone('UTC', () => {
      const date = parseTimestamp('2026-09-26');
      expect(date.toISOString()).toBe('2026-09-26T00:00:00.000Z');
      expect(calendarParts(date)).toEqual([2026, 8, 26, 0]);
    });
  });

  it('keeps a four-digit year below 100', () => {
    inTimeZone('UTC', () => {
      expect(calendarParts(parseTimestamp('0099-01-01'))).toEqual([99, 0, 1, 0]);
    });
  });

  it('rejects a day that does not exist in that month', () => {
    expect(parseTimestamp('2026-02-30').getTime()).toBeNaN();
    expect(parseTimestamp('2026-13-01').getTime()).toBeNaN();
  });

  it('parses a PostgreSQL timestamp with a short tz offset', () => {
    expect(parseTimestamp('2026-03-16 15:21:40.957+00').toISOString()).toBe(
      '2026-03-16T15:21:40.957Z'
    );
  });

  it('keeps a timestamp an instant in every timezone', () => {
    const west = inTimeZone('America/Los_Angeles', () =>
      parseTimestamp('2026-03-16 15:21:40.957+00').toISOString()
    );
    const east = inTimeZone('Asia/Tokyo', () =>
      parseTimestamp('2026-03-16 15:21:40.957+00').toISOString()
    );
    expect(west).toBe('2026-03-16T15:21:40.957Z');
    expect(east).toBe('2026-03-16T15:21:40.957Z');
  });

  it('returns an invalid date for a missing timestamp instead of throwing', () => {
    expect(Number.isNaN(parseTimestamp(null).getTime())).toBe(true);
    expect(Number.isNaN(parseTimestamp(undefined).getTime())).toBe(true);
  });
});

describe('timestampMs', () => {
  it('returns the epoch milliseconds of a backend time', () => {
    expect(timestampMs('2026-03-16 15:21:40.957+00')).toBe(Date.UTC(2026, 2, 16, 15, 21, 40, 957));
  });

  it('returns null instead of an invalid instant', () => {
    expect(timestampMs(null)).toBeNull();
    expect(timestampMs(undefined)).toBeNull();
    expect(timestampMs('')).toBeNull();
    expect(timestampMs('2026-02-30')).toBeNull();
    expect(timestampMs('not-a-timestamp')).toBeNull();
  });
});

describe('timestampToIso', () => {
  it('rewrites a backend time as the ISO instant every payload carries', () => {
    expect(timestampToIso('2026-03-16 15:21:40.957+00')).toBe('2026-03-16T15:21:40.957Z');
    expect(timestampToIso('2026-03-16T15:21:40.957Z')).toBe('2026-03-16T15:21:40.957Z');
  });

  it('keeps a date-only value on the same calendar day', () => {
    inTimeZone('America/Los_Angeles', () => {
      // The stored date is a calendar day: the ISO form of its local midnight,
      // not the previous day in UTC.
      expect(timestampToIso('2026-09-26')).toBe('2026-09-26T07:00:00.000Z');
    });
  });

  it('returns null for a missing or unparsable time so the field is absent', () => {
    expect(timestampToIso(null)).toBeNull();
    expect(timestampToIso(undefined)).toBeNull();
    expect(timestampToIso('')).toBeNull();
    expect(timestampToIso('2026-02-30')).toBeNull();
    expect(timestampToIso('not-a-timestamp')).toBeNull();
  });
});

describe('epochMsToIso', () => {
  it('renders an epoch instant as the ISO string with millisecond precision', () => {
    expect(epochMsToIso(Date.UTC(2026, 2, 16, 15, 21, 40, 957))).toBe('2026-03-16T15:21:40.957Z');
  });

  it('drops the sub-millisecond part', () => {
    expect(epochMsToIso(1_772_000_000_123.9)).toBe('2026-02-25T06:13:20.123Z');
  });
});

describe('formatCents', () => {
  it('formats USD with the standard dollar presentation', () => {
    expect(formatCents(12345)).toBe('$123.45');
    expect(formatCents(-5)).toBe('-$0.05');
    expect(formatCents(0)).toBe('$0.00');
  });

  it('formats a non-USD currency from its uppercase code', () => {
    expect(formatCents(12345, 'eur')).toBe('€123.45');
  });

  it('reuses one formatter per currency across calls (same output, cached construction)', () => {
    // The second and later calls format through a memoized Intl.NumberFormat;
    // pinning repeated-call stability catches a cache that returns a formatter
    // built with the wrong currency or options.
    const first = formatCents(999, 'JPY');
    expect(formatCents(999, 'JPY')).toBe(first);
    // JPY has no minor unit, so Intl rounds to whole yen.
    expect(first).toBe('¥10');
    // The USD cache is independent of the JPY cache.
    expect(formatCents(999)).toBe('$9.99');
  });
});

describe('formatDollars', () => {
  it('routes dollars through the same en-US USD presentation as formatCents', () => {
    expect(formatDollars(123.45)).toBe('$123.45');
    expect(formatDollars(0.5)).toBe('$0.50');
    expect(formatDollars(123.456)).toBe('$123.46');
  });
});
