import { formatFeedbackTimestamp } from './feedback-history';

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
