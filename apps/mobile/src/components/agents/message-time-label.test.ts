import { describe, expect, it } from 'vitest';

import {
  formatTranscriptMarkerLabel,
  formatTranscriptTimeLabel,
  isSameLocalDay,
  isValidTranscriptTime,
} from './message-time-label';

const TIME_ONLY = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * All epochs are built with the local `new Date(y, m, d, h, min)` constructor
 * so the assertions are timezone-stable and never depend on the runner clock.
 */
describe('formatTranscriptTimeLabel', () => {
  it('returns null when the timestamp is absent', () => {
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptTimeLabel(undefined, now)).toBeNull();
    expect(formatTranscriptTimeLabel(null, now)).toBeNull();
  });

  it('returns null when the timestamp is non-positive or non-finite', () => {
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptTimeLabel(0, now)).toBeNull();
    expect(formatTranscriptTimeLabel(-1, now)).toBeNull();
    expect(formatTranscriptTimeLabel(Number.NaN, now)).toBeNull();
    expect(formatTranscriptTimeLabel(Number.POSITIVE_INFINITY, now)).toBeNull();
    expect(formatTranscriptTimeLabel(Number.NEGATIVE_INFINITY, now)).toBeNull();
  });

  it('returns null for an out-of-range finite epoch without throwing', () => {
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptTimeLabel(Number.MAX_VALUE, now)).toBeNull();
  });

  it('formats time only when created is on the same local day as now', () => {
    const created = new Date(2026, 7, 5, 14, 32).getTime();
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptTimeLabel(created, now)).toBe(TIME_ONLY.format(new Date(created)));
  });

  it('formats date and time when created is on another local day', () => {
    const created = new Date(2026, 7, 5, 14, 32).getTime();
    const now = new Date(2026, 7, 6, 9, 1).getTime();
    expect(formatTranscriptTimeLabel(created, now)).toBe(DATE_TIME.format(new Date(created)));
  });

  it('formats date and time when created is in a different year', () => {
    const created = new Date(2025, 11, 31, 23, 59).getTime();
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptTimeLabel(created, now)).toBe(DATE_TIME.format(new Date(created)));
  });
});

describe('isSameLocalDay', () => {
  it('returns true for two instants anywhere on the same local calendar day', () => {
    const dayStart = new Date(2026, 0, 1, 0, 0, 1).getTime();
    const dayEnd = new Date(2026, 0, 1, 23, 59, 59).getTime();
    expect(isSameLocalDay(dayStart, dayEnd)).toBe(true);
  });

  it('returns false for two instants one second across local midnight', () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59, 59).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 0, 0).getTime();
    expect(isSameLocalDay(beforeMidnight, afterMidnight)).toBe(false);
  });
});

describe('isValidTranscriptTime', () => {
  it('rejects absent, non-positive, non-finite, and out-of-range epochs', () => {
    expect(isValidTranscriptTime(undefined)).toBe(false);
    expect(isValidTranscriptTime(null)).toBe(false);
    expect(isValidTranscriptTime(0)).toBe(false);
    expect(isValidTranscriptTime(-1)).toBe(false);
    expect(isValidTranscriptTime(Number.NaN)).toBe(false);
    expect(isValidTranscriptTime(Number.MAX_VALUE)).toBe(false);
  });

  it('accepts a current epoch', () => {
    expect(isValidTranscriptTime(Date.now())).toBe(true);
  });
});

describe('formatTranscriptMarkerLabel', () => {
  it('always shows the date for a day-change marker even when the day is today', () => {
    const created = new Date(2026, 7, 5, 14, 32).getTime();
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptMarkerLabel(created, now, true)).toBe(
      DATE_TIME.format(new Date(created))
    );
  });

  it('keeps the message-label rule when the day did not change', () => {
    const created = new Date(2026, 7, 5, 14, 32).getTime();
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptMarkerLabel(created, now, false)).toBe(
      formatTranscriptTimeLabel(created, now)
    );
  });

  it('returns null for an out-of-range epoch with either flag', () => {
    const now = new Date(2026, 7, 5, 9, 1).getTime();
    expect(formatTranscriptMarkerLabel(Number.MAX_VALUE, now, true)).toBeNull();
    expect(formatTranscriptMarkerLabel(Number.MAX_VALUE, now, false)).toBeNull();
  });
});
