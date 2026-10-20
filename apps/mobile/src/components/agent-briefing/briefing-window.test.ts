import { describe, expect, it } from 'vitest';

import { formatBriefingTimestamp } from './briefing-window';

// 22:00 on 18 October 2026 in Asia/Kolkata (UTC+5:30) and the 08:00 cutoff that
// follows it across midnight.
const NIGHT_START_AT = '2026-10-18T16:30:00.000Z';
const CUTOFF_AT = '2026-10-19T02:30:00.000Z';

const deviceZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
// A zone the runner is not in, so an explicit zone can only win by being passed through.
const otherZone = deviceZone === 'Asia/Kolkata' ? 'America/Los_Angeles' : 'Asia/Kolkata';

describe('formatBriefingTimestamp', () => {
  it('renders the night window in the briefing zone', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', 'Asia/Kolkata')).toBe(
      'Oct 18, 2026, 10:00 PM'
    );
    expect(formatBriefingTimestamp(CUTOFF_AT, 'en', 'Asia/Kolkata')).toBe('Oct 19, 2026, 8:00 AM');
  });

  it('renders the same instants in another zone as that zone clock', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', 'Europe/Belgrade')).toBe(
      'Oct 18, 2026, 6:30 PM'
    );
    expect(formatBriefingTimestamp(CUTOFF_AT, 'en', 'Europe/Belgrade')).toBe(
      'Oct 19, 2026, 4:30 AM'
    );
  });

  it('follows an explicit zone even when the device sits in another one', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', otherZone)).not.toBe(
      formatBriefingTimestamp(NIGHT_START_AT, 'en', undefined)
    );
  });

  it('keeps the device zone when the briefing zone is unknown', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', undefined)).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(NIGHT_START_AT)
      )
    );
  });

  it('keeps the device wall clock for an explicit device zone', () => {
    expect(formatBriefingTimestamp(CUTOFF_AT, 'en', deviceZone)).toBe(
      formatBriefingTimestamp(CUTOFF_AT, 'en', undefined)
    );
  });
});
