import { afterEach, describe, expect, it, vi } from 'vitest';

import { timeAgo } from './utils';

describe('timeAgo', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses the passed locale for the relative-time words', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    const fiveMinutesAgo = new Date('2026-08-23T11:55:00Z');

    expect(timeAgo(fiveMinutesAgo, 'en')).toBe('5 minutes ago');
    expect(timeAgo(fiveMinutesAgo, 'de')).toBe('vor 5 Minuten');
  });

  it('returns the catalog just-now string for sub-minute ages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    const thirtySecondsAgo = new Date('2026-08-23T11:59:30Z');

    expect(timeAgo(thirtySecondsAgo, 'en')).toBe('Just now');
  });
});
