import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatGlanceableClock } from './count-format';

const settings = vi.hoisted(() => ({
  language: 'en-US',
  uses24hourClock: false as boolean | null,
}));
vi.mock('@/i18n', () => ({
  i18n: {
    get language() {
      return settings.language;
    },
  },
}));
vi.mock('expo-localization', () => ({
  getCalendars: () => [{ uses24hourClock: settings.uses24hourClock }],
}));
vi.mock('@/lib/utils', () => ({ parseTimestamp: (at: string) => new Date(at), timeAgo: () => '' }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 9, 12, 0));
  settings.language = 'en-US';
  settings.uses24hourClock = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Home wake and checked clock formatting', () => {
  it('honors the device 24-hour setting even when the app language normally uses 12-hour time', () => {
    settings.uses24hourClock = true;
    expect(formatGlanceableClock(new Date(2026, 9, 9, 18, 30).toISOString())).toBe('18:30');
    expect(formatGlanceableClock(new Date(2026, 9, 9, 0, 30).toISOString())).toBe('00:30');
  });

  it('honors the device 12-hour setting even when the app language normally uses 24-hour time', () => {
    settings.language = 'de';
    expect(formatGlanceableClock(new Date(2026, 9, 9, 18, 30).toISOString())).toMatch(/6:30.*PM/u);
  });

  it('uses language defaults only when the native clock preference is unavailable', () => {
    settings.language = 'de';
    settings.uses24hourClock = null;
    expect(formatGlanceableClock(new Date(2026, 9, 9, 18, 30).toISOString())).toBe('18:30');
  });

  it('includes a local calendar day for non-today wakes and old checked timestamps', () => {
    settings.uses24hourClock = true;
    const tomorrow = new Date(2026, 9, 10, 18, 30);
    const yesterday = new Date(2026, 9, 8, 18, 30);
    expect(formatGlanceableClock(tomorrow.toISOString())).toBe(
      new Intl.DateTimeFormat('en-US', {
        dateStyle: 'short',
        timeStyle: 'short',
        hourCycle: 'h23',
      }).format(tomorrow)
    );
    expect(formatGlanceableClock(yesterday.toISOString())).toBe(
      new Intl.DateTimeFormat('en-US', {
        dateStyle: 'short',
        timeStyle: 'short',
        hourCycle: 'h23',
      }).format(yesterday)
    );
    expect(formatGlanceableClock(tomorrow.toISOString())).not.toBe('18:30');
  });

  it('reads changes to the device clock setting on the next headless redraw', () => {
    const at = new Date(2026, 9, 9, 18, 30).toISOString();
    expect(formatGlanceableClock(at)).toMatch(/6:30.*PM/u);
    settings.uses24hourClock = true;
    expect(formatGlanceableClock(at)).toBe('18:30');
  });
});
