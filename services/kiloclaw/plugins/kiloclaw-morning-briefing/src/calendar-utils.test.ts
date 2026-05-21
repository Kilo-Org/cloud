import { describe, expect, it } from 'vitest';
import {
  buildCalendarSectionLines,
  buildCalendarSectionTitle,
  buildCalendarTimeWindow,
  formatAllDayEventLine,
  formatCalendarTldr,
  formatEventTitle,
  formatTimedEventLine,
  isAllDayEvent,
  partitionEventsByDay,
  type CalendarEvent,
} from './calendar-utils';

function event(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    id: overrides.id,
    summary: overrides.summary ?? null,
    start: overrides.start ?? {},
    end: overrides.end ?? {},
  };
}

describe('buildCalendarTimeWindow', () => {
  it('returns timeMin at start of today and timeMax at noon tomorrow', () => {
    // 2026-05-19T15:00:00Z — afternoon in PDT (08:00 PDT)
    const now = new Date('2026-05-19T15:00:00Z');
    const window = buildCalendarTimeWindow(now, 'America/Los_Angeles');
    expect(window.timeMin).toBe('2026-05-19T00:00:00-07:00');
    expect(window.timeMax).toBe('2026-05-20T12:00:00-07:00');
  });

  it('handles UTC timezone with Z offset', () => {
    const now = new Date('2026-05-19T15:00:00Z');
    const window = buildCalendarTimeWindow(now, 'UTC');
    expect(window.timeMin).toBe('2026-05-19T00:00:00Z');
    expect(window.timeMax).toBe('2026-05-20T12:00:00Z');
  });

  it('rolls over correctly when the UTC instant lands on the next local day', () => {
    // 2026-05-19T23:00:00Z is 2026-05-20T07:00 in Asia/Tokyo (+09:00)
    const now = new Date('2026-05-19T23:00:00Z');
    const window = buildCalendarTimeWindow(now, 'Asia/Tokyo');
    expect(window.timeMin).toBe('2026-05-20T00:00:00+09:00');
    expect(window.timeMax).toBe('2026-05-21T12:00:00+09:00');
  });

  it('falls back to UTC when timezone is empty', () => {
    const now = new Date('2026-05-19T15:00:00Z');
    const window = buildCalendarTimeWindow(now, '');
    expect(window.timeMin).toBe('2026-05-19T00:00:00Z');
  });

  it('uses the correct offset for each boundary across DST start', () => {
    // 2026-03-08 starts in PST (-08:00), then switches to PDT (-07:00).
    const now = new Date('2026-03-08T15:00:00Z');
    const window = buildCalendarTimeWindow(now, 'America/Los_Angeles');
    expect(window.timeMin).toBe('2026-03-08T00:00:00-08:00');
    expect(window.timeMax).toBe('2026-03-09T12:00:00-07:00');
  });

  it('uses the correct offset for each boundary across DST end', () => {
    // 2026-11-01 starts in PDT (-07:00), then switches to PST (-08:00).
    const now = new Date('2026-11-01T15:00:00Z');
    const window = buildCalendarTimeWindow(now, 'America/Los_Angeles');
    expect(window.timeMin).toBe('2026-11-01T00:00:00-07:00');
    expect(window.timeMax).toBe('2026-11-02T12:00:00-08:00');
  });
});

describe('formatEventTitle', () => {
  it('returns the trimmed summary when provided', () => {
    expect(formatEventTitle(event({ id: '1', summary: '  Standup  ' }))).toBe('Standup');
  });

  it('falls back to "(no title)" when summary is null or empty', () => {
    expect(formatEventTitle(event({ id: '1', summary: null }))).toBe('(no title)');
    expect(formatEventTitle(event({ id: '2', summary: '   ' }))).toBe('(no title)');
  });
});

describe('isAllDayEvent', () => {
  it('returns true for events with a date but no dateTime', () => {
    expect(
      isAllDayEvent(event({ id: '1', start: { date: '2026-05-19' }, end: { date: '2026-05-20' } }))
    ).toBe(true);
  });

  it('returns false for events with a dateTime', () => {
    expect(
      isAllDayEvent(
        event({
          id: '1',
          start: { dateTime: '2026-05-19T09:00:00-07:00' },
          end: { dateTime: '2026-05-19T10:00:00-07:00' },
        })
      )
    ).toBe(false);
  });
});

describe('formatTimedEventLine', () => {
  it('formats HH:MM-HH:MM title in the user timezone', () => {
    const e = event({
      id: '1',
      summary: '1:1 with Sarah',
      start: { dateTime: '2026-05-19T16:00:00Z' },
      end: { dateTime: '2026-05-19T17:00:00Z' },
    });
    expect(formatTimedEventLine(e, 'America/Los_Angeles')).toBe('- 09:00-10:00 1:1 with Sarah');
  });

  it('falls back to title-only when dateTime is missing', () => {
    const e = event({ id: '1', summary: 'Weird event' });
    expect(formatTimedEventLine(e, 'UTC')).toBe('- Weird event');
  });
});

describe('formatAllDayEventLine', () => {
  it('prefixes with "All day:"', () => {
    expect(
      formatAllDayEventLine(
        event({ id: '1', summary: 'Team offsite', start: { date: '2026-05-19' } })
      )
    ).toBe('- All day: Team offsite');
  });
});

describe('partitionEventsByDay', () => {
  const now = new Date('2026-05-19T15:00:00Z'); // 2026-05-19 in LA
  const tz = 'America/Los_Angeles';

  it('groups events into today vs tomorrow, timed vs all-day', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a',
        summary: 'Today timed B',
        start: { dateTime: '2026-05-19T21:00:00Z' }, // 14:00 LA
        end: { dateTime: '2026-05-19T22:00:00Z' },
      }),
      event({
        id: 'b',
        summary: 'Today timed A',
        start: { dateTime: '2026-05-19T17:00:00Z' }, // 10:00 LA
        end: { dateTime: '2026-05-19T18:00:00Z' },
      }),
      event({ id: 'c', summary: 'Today all-day', start: { date: '2026-05-19' } }),
      event({
        id: 'd',
        summary: 'Tomorrow timed',
        start: { dateTime: '2026-05-20T15:00:00Z' }, // 08:00 LA next day
        end: { dateTime: '2026-05-20T16:00:00Z' },
      }),
      event({ id: 'e', summary: 'Tomorrow all-day', start: { date: '2026-05-20' } }),
      event({
        id: 'f',
        summary: 'Stray two days out',
        start: { dateTime: '2026-05-21T15:00:00Z' },
        end: { dateTime: '2026-05-21T16:00:00Z' },
      }),
    ];

    const partitioned = partitionEventsByDay(events, now, tz);
    expect(partitioned.todayTimed.map(e => e.id)).toEqual(['b', 'a']); // sorted by start
    expect(partitioned.todayAllDay.map(e => e.id)).toEqual(['c']);
    expect(partitioned.tomorrowTimed.map(e => e.id)).toEqual(['d']);
    expect(partitioned.tomorrowAllDay.map(e => e.id)).toEqual(['e']);
    // 'f' is two days out — dropped.
  });

  it('includes all-day events that overlap today or tomorrow even when they started earlier', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a',
        summary: 'Conference',
        start: { date: '2026-05-18' },
        end: { date: '2026-05-21' },
      }),
      event({
        id: 'b',
        summary: 'Ended yesterday',
        start: { date: '2026-05-18' },
        end: { date: '2026-05-19' },
      }),
    ];

    const partitioned = partitionEventsByDay(events, now, tz);
    expect(partitioned.todayAllDay.map(e => e.id)).toEqual(['a']);
    expect(partitioned.tomorrowAllDay.map(e => e.id)).toEqual(['a']);
  });

  it('sorts timed events by instant when dateTime offsets differ', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a',
        summary: 'LA breakfast',
        start: { dateTime: '2026-05-19T07:00:00-07:00' },
        end: { dateTime: '2026-05-19T07:30:00-07:00' },
      }),
      event({
        id: 'b',
        summary: 'NY check-in',
        start: { dateTime: '2026-05-19T09:00:00-04:00' },
        end: { dateTime: '2026-05-19T09:30:00-04:00' },
      }),
    ];

    const partitioned = partitionEventsByDay(events, now, tz);
    expect(partitioned.todayTimed.map(e => e.id)).toEqual(['b', 'a']);
  });
});

describe('buildCalendarSectionLines', () => {
  const now = new Date('2026-05-19T15:00:00Z');
  const tz = 'America/Los_Angeles';

  it('renders today + tomorrow morning sections', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a',
        summary: 'Standup',
        start: { dateTime: '2026-05-19T16:00:00Z' }, // 09:00 LA
        end: { dateTime: '2026-05-19T16:30:00Z' },
      }),
      event({
        id: 'b',
        summary: 'Coffee with Alex',
        start: { dateTime: '2026-05-20T15:00:00Z' }, // 08:00 LA next day
        end: { dateTime: '2026-05-20T16:00:00Z' },
      }),
      event({ id: 'c', summary: 'Team offsite', start: { date: '2026-05-19' } }),
    ];

    const lines = buildCalendarSectionLines(events, now, tz);
    expect(lines).toEqual([
      '- 09:00-09:30 Standup',
      '- All day: Team offsite',
      '',
      'Tomorrow morning',
      '- 08:00-09:00 Coffee with Alex',
    ]);
  });

  it('emits a single italic "no events" line when calendar is empty', () => {
    expect(buildCalendarSectionLines([], now, tz)).toEqual([
      '_No events on your calendar for today or tomorrow morning._',
    ]);
  });

  it('shows "No events today." when only tomorrow has events', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'b',
        summary: 'Coffee',
        start: { dateTime: '2026-05-20T15:00:00Z' },
        end: { dateTime: '2026-05-20T16:00:00Z' },
      }),
    ];
    expect(buildCalendarSectionLines(events, now, tz)).toEqual([
      'No events today.',
      '',
      'Tomorrow morning',
      '- 08:00-09:00 Coffee',
    ]);
  });

  it('omits the "Tomorrow morning" subsection when tomorrow is empty', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a',
        summary: 'Standup',
        start: { dateTime: '2026-05-19T16:00:00Z' },
        end: { dateTime: '2026-05-19T16:30:00Z' },
      }),
    ];
    expect(buildCalendarSectionLines(events, now, tz)).toEqual(['- 09:00-09:30 Standup']);
  });
});

describe('buildCalendarSectionTitle', () => {
  it('formats "🗓 {email} daily calendar"', () => {
    expect(buildCalendarSectionTitle('storms@kilocode.ai')).toBe(
      '🗓 storms@kilocode.ai daily calendar'
    );
  });
});

describe('formatCalendarTldr', () => {
  const now = new Date('2026-05-19T15:00:00Z');
  const tz = 'America/Los_Angeles';

  it("counts only today's events", () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a',
        summary: 'Standup',
        start: { dateTime: '2026-05-19T16:00:00Z' },
        end: { dateTime: '2026-05-19T16:30:00Z' },
      }),
      event({ id: 'b', summary: 'Today all-day', start: { date: '2026-05-19' } }),
      event({
        id: 'c',
        summary: 'Tomorrow',
        start: { dateTime: '2026-05-20T15:00:00Z' },
        end: { dateTime: '2026-05-20T16:00:00Z' },
      }),
    ];
    expect(formatCalendarTldr(events, now, tz)).toBe('2 events today');
  });

  it('uses the singular form for one event', () => {
    const events: CalendarEvent[] = [
      event({
        id: 'a',
        summary: 'Standup',
        start: { dateTime: '2026-05-19T16:00:00Z' },
        end: { dateTime: '2026-05-19T16:30:00Z' },
      }),
    ];
    expect(formatCalendarTldr(events, now, tz)).toBe('1 event today');
  });

  it('returns an empty string when today is clear', () => {
    expect(formatCalendarTldr([], now, tz)).toBe('');
  });
});
