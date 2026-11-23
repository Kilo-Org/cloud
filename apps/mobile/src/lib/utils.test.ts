import { afterEach, describe, expect, it, vi } from 'vitest';

import { relativeTime, timeAgo } from './utils';

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

  it('derives the label from the passed clock so a tick can advance it', () => {
    const created = new Date('2026-08-23T11:59:30Z');

    expect(timeAgo(created, 'en', Date.parse('2026-08-23T12:00:00Z'))).toBe('Just now');
    expect(timeAgo(created, 'en', Date.parse('2026-08-23T12:00:29Z'))).toBe('Just now');
    expect(timeAgo(created, 'en', Date.parse('2026-08-23T12:00:30Z'))).toBe('1 minute ago');
    expect(timeAgo(created, 'en', Date.parse('2026-08-23T12:05:30Z'))).toBe('6 minutes ago');
  });

  it('reads a future instant forward, for a scheduled wake', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));

    expect(relativeTime(new Date('2026-08-23T12:05:00Z'), 'en')).toBe('in 5 minutes');
    expect(relativeTime(new Date('2026-08-23T14:00:00Z'), 'en')).toBe('in 2 hours');
    expect(relativeTime(new Date('2026-08-23T12:00:30Z'), 'en')).toBe('Just now');
  });

  it('reads an event stamped after a trailing clock sample as now, never as ahead', () => {
    const sampled = Date.parse('2026-08-23T14:34:00Z');
    const answered = new Date('2026-08-23T14:35:05Z');

    expect(timeAgo(answered, 'en', sampled)).toBe('Just now');
    expect(timeAgo(new Date('2026-08-23T16:00:00Z'), 'en', sampled)).toBe('Just now');
  });

  it('omits an invalid timestamp instead of formatting a relative time', () => {
    expect(timeAgo(new Date(Number.NaN))).toBe('');
  });
});
