import { describe, expect, it } from 'vitest';

import { formatBriefingTimestamp } from './briefing-window';

// 22:00 on 18 October 2026 in Asia/Kolkata (UTC+5:30) and the 08:00 cutoff that
// follows it across midnight.
const NIGHT_START_AT = '2026-10-18T16:30:00.000Z';
const CUTOFF_AT = '2026-10-19T02:30:00.000Z';

const deviceZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
const deviceWallClock = (value: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value)
  );

describe('formatBriefingTimestamp', () => {
  // The literals are the proof that the passed zone drives the output: no runner
  // clock reads 10:00 PM for this instant, so only the Kolkata zone can produce it.
  it('renders the night window in the briefing zone and names that zone', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', 'Asia/Kolkata')).toEqual({
      text: 'Oct 18, 2026, 10:00 PM',
      timeZone: 'Asia/Kolkata',
    });
    expect(formatBriefingTimestamp(CUTOFF_AT, 'en', 'Asia/Kolkata')).toEqual({
      text: 'Oct 19, 2026, 8:00 AM',
      timeZone: 'Asia/Kolkata',
    });
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', undefined)).toEqual({
      text: deviceWallClock(NIGHT_START_AT),
      timeZone: deviceZone,
    });
  });

  it('renders the same instants on another zone clock and names that zone', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', 'Europe/Belgrade')).toEqual({
      text: 'Oct 18, 2026, 6:30 PM',
      timeZone: 'Europe/Belgrade',
    });
    expect(formatBriefingTimestamp(CUTOFF_AT, 'en', 'Europe/Belgrade')).toEqual({
      text: 'Oct 19, 2026, 4:30 AM',
      timeZone: 'Europe/Belgrade',
    });
  });

  it('keeps the device zone when the briefing zone is unknown', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', undefined)).toEqual({
      text: deviceWallClock(NIGHT_START_AT),
      timeZone: deviceZone,
    });
    expect(formatBriefingTimestamp(CUTOFF_AT, 'en', undefined)).toEqual({
      text: deviceWallClock(CUTOFF_AT),
      timeZone: deviceZone,
    });
  });

  it('keeps the device wall clock for an explicit device zone', () => {
    expect(formatBriefingTimestamp(CUTOFF_AT, 'en', deviceZone)).toEqual(
      formatBriefingTimestamp(CUTOFF_AT, 'en', undefined)
    );
  });

  it('names the device zone for a zone the runtime cannot resolve', () => {
    expect(formatBriefingTimestamp(NIGHT_START_AT, 'en', 'Asia/Nowhere')).toEqual({
      text: deviceWallClock(NIGHT_START_AT),
      timeZone: deviceZone,
    });
  });
});
