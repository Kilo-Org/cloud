import { formatFeedbackTimestamp, parseFeedbackTimestamp } from './feedback-history';

const now = new Date('2026-02-10T12:00:00.000Z');

describe('parseFeedbackTimestamp', () => {
  it('parses a Postgres timestamptz string as UTC', () => {
    const parsed = parseFeedbackTimestamp('2026-02-01 09:30:00.000+00');
    expect(parsed?.toISOString()).toBe('2026-02-01T09:30:00.000Z');
  });

  it('returns null for empty or invalid input', () => {
    expect(parseFeedbackTimestamp('')).toBeNull();
    expect(parseFeedbackTimestamp('not-a-date')).toBeNull();
  });
});

describe('formatFeedbackTimestamp', () => {
  it('renders a relative time with a suffix', () => {
    expect(formatFeedbackTimestamp('2026-02-01 12:00:00.000+00', now)).toBe('9 days ago');
  });

  it('returns an empty string when the timestamp is invalid', () => {
    expect(formatFeedbackTimestamp('not-a-date', now)).toBe('');
  });
});
