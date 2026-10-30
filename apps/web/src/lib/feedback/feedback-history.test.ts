import { formatFeedbackTimestamp, toIsoTimestamp } from './feedback-history';

const now = new Date('2026-02-10T12:00:00.000Z');

describe('formatFeedbackTimestamp', () => {
  it('renders a relative time with a suffix', () => {
    expect(formatFeedbackTimestamp('2026-02-01T12:00:00.000Z', now)).toBe('9 days ago');
  });

  it('accepts legacy Postgres timestamptz text', () => {
    expect(formatFeedbackTimestamp('2026-02-01 12:00:00.000+00', now)).toBe('9 days ago');
  });

  it('returns an empty string for missing or invalid input', () => {
    expect(formatFeedbackTimestamp(null, now)).toBe('');
    expect(formatFeedbackTimestamp('', now)).toBe('');
    expect(formatFeedbackTimestamp('not-a-date', now)).toBe('');
    expect(formatFeedbackTimestamp('2026-02-01T00:00:00', now)).toBe('');
  });
});

describe('toIsoTimestamp', () => {
  it('normalizes Postgres timestamptz text to UTC ISO', () => {
    expect(toIsoTimestamp('2026-01-01 00:00:00.000+00')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects input with no UTC offset', () => {
    expect(toIsoTimestamp('2026-01-01T00:00:00')).toBeNull();
    expect(toIsoTimestamp('2026-01-01 00:00:00.000')).toBeNull();
  });

  it('rejects a bare z/Z that is not at the end (offset must be anchored)', () => {
    // The old alternation `[zZ]|[+-]\d{2}:?\d{2}$` matched a z anywhere in the
    // string, so "2026-01-01T00:00:00zfoo" wrongly passed the offset guard.
    expect(toIsoTimestamp('2026-01-01T00:00:00zfoo')).toBeNull();
    expect(toIsoTimestamp('2026-01-01T00:00:00Zfoo')).toBeNull();
  });

  it('returns null for missing or invalid input', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp('')).toBeNull();
    expect(toIsoTimestamp('not-a-date')).toBeNull();
  });
});
