import { describe, expect, it } from 'vitest';

import {
  firstNonEmpty,
  formatCents,
  formatDate,
  formatDollars,
  fromMicrodollars,
  parseTimestamp,
} from './utils';

describe('parseTimestamp', () => {
  it('parses a date-only string as UTC midnight', () => {
    expect(parseTimestamp('2026-09-26').toISOString()).toBe('2026-09-26T00:00:00.000Z');
  });

  it('parses a PostgreSQL timestamp with a short tz offset', () => {
    expect(parseTimestamp('2026-03-16 15:21:40.957+00').toISOString()).toBe(
      '2026-03-16T15:21:40.957Z'
    );
  });
});

describe('firstNonEmpty', () => {
  it('returns the first non-empty value', () => {
    expect(firstNonEmpty(undefined, null, '', 'a', 'b')).toBe('a');
  });

  it('returns empty string when none are set', () => {
    expect(firstNonEmpty(undefined, null, '')).toBe('');
  });
});

describe('fromMicrodollars', () => {
  it('divides by one million', () => {
    expect(fromMicrodollars(1_500_000)).toBe(1.5);
  });
});

describe('formatDollars', () => {
  it('formats as USD currency', () => {
    expect(formatDollars(12.5)).toBe('$12.50');
  });
});

describe('formatCents', () => {
  it('formats cents as USD currency by default', () => {
    expect(formatCents(1250)).toBe('$12.50');
  });

  it('accepts an explicit currency code', () => {
    expect(formatCents(1250, 'eur')).toBe('€12.50');
  });
});

describe('formatDate', () => {
  it('formats a Date as numeric month/day/year', () => {
    // Local-time constructor avoids UTC/local rollover ambiguity across CI timezones.
    expect(formatDate(new Date(2026, 6, 11))).toBe('7/11/2026');
  });

  it('accepts a parsed backend timestamp', () => {
    // Noon UTC keeps the same local calendar day across all realistic CI timezones.
    expect(formatDate(parseTimestamp('2026-01-05 12:00:00+00'))).toBe('1/5/2026');
  });
});
