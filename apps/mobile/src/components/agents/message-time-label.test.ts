import { describe, expect, it } from 'vitest';

import { formatTranscriptTimeLabel } from './message-time-label';

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
