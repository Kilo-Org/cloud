import { describe, expect, it } from 'vitest';

import { parseTimestamp } from './utils';

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
