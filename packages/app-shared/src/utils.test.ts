import { describe, expect, it, vi } from 'vitest';

import { getDirectoryName, getFilename, parseTimestamp, timestampMs } from './utils';

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

describe('getFilename', () => {
  it('returns the last path segment', () => {
    expect(getFilename('/workspace/project/report.pdf')).toBe('report.pdf');
    expect(getFilename('a/b/c')).toBe('c');
  });

  it('returns the input when there is no slash', () => {
    expect(getFilename('plain-name')).toBe('plain-name');
  });

  it('falls back to the input when the segment is empty', () => {
    expect(getFilename('')).toBe('');
    expect(getFilename('a/b/')).toBe('a/b/');
  });
});

describe('getDirectoryName', () => {
  it('returns the last directory name', () => {
    expect(getDirectoryName('a/b/c')).toBe('c');
    expect(getDirectoryName('/workspace/app')).toBe('app');
  });

  it('treats a trailing slash as naming its directory', () => {
    expect(getDirectoryName('a/b/')).toBe('b');
  });

  it('renders an empty path as the current directory', () => {
    expect(getDirectoryName('')).toBe('.');
  });
});
