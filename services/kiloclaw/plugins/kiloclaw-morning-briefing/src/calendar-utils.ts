/**
 * Pure helpers for the Google Calendar source.
 *
 * Kept side-effect free so the unit tests cover the date arithmetic,
 * formatting, and grouping logic without mocking fetch or the broker.
 * `calendar-client.ts` owns the HTTP layer; `index.ts` glues them
 * together inside `collectCalendar`.
 *
 * Time window semantics:
 *   - timeMin: start of today in the user's timezone.
 *   - timeMax: noon of tomorrow in the user's timezone.
 *   We deliberately cut at noon tomorrow so a 7am brief warns about an
 *   8am tomorrow meeting without dumping the whole next day.
 */

const DEFAULT_TIMEZONE = 'UTC';

export interface CalendarEvent {
  id: string;
  summary: string | null;
  start: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
  end: { dateTime?: string | null; date?: string | null; timeZone?: string | null };
}

export interface CalendarTimeWindow {
  timeMin: string;
  timeMax: string;
}

/**
 * Pulls the ISO offset (e.g. `-07:00`) for a given UTC instant in the
 * named IANA zone. Used to construct ISO strings that the Google
 * Calendar API will accept as wall-clock-anchored.
 */
function getTimezoneOffset(date: Date, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    });
    const parts = formatter.formatToParts(date);
    const offsetPart = parts.find(part => part.type === 'timeZoneName');
    if (!offsetPart) return 'Z';
    // longOffset normally renders as "GMT-07:00". For UTC, some ICU
    // implementations emit bare "GMT" (macOS), others emit "GMT+00:00"
    // (Linux). Normalize both to the bare "Z" suffix so the produced
    // ISO string round-trips identically across platforms.
    const match = offsetPart.value.match(/GMT([+-]\d{2}:\d{2})/);
    if (!match) return 'Z';
    return match[1] === '+00:00' || match[1] === '-00:00' ? 'Z' : match[1];
  } catch {
    return 'Z';
  }
}

/**
 * Returns the `YYYY-MM-DD` for the calendar day containing `date` in
 * `timezone`. Mirrors `formatDateKey` in briefing-utils, kept inline
 * to keep this module free of cross-module pulls.
 */
function dateKeyInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = parts.find(p => p.type === 'year')?.value ?? '1970';
  const month = parts.find(p => p.type === 'month')?.value ?? '01';
  const day = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() + days);
  const offsetYear = utc.getUTCFullYear();
  const offsetMonth = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const offsetDay = String(utc.getUTCDate()).padStart(2, '0');
  return `${offsetYear}-${offsetMonth}-${offsetDay}`;
}

export function buildCalendarTimeWindow(now: Date, userTimezone: string): CalendarTimeWindow {
  const tz = userTimezone || DEFAULT_TIMEZONE;
  const todayKey = dateKeyInZone(now, tz);
  const tomorrowKey = addDays(todayKey, 1);
  return {
    timeMin: `${todayKey}T00:00:00${getTimezoneOffsetForWallTime(todayKey, '00:00:00', tz)}`,
    timeMax: `${tomorrowKey}T12:00:00${getTimezoneOffsetForWallTime(tomorrowKey, '12:00:00', tz)}`,
  };
}

function getTimezoneOffsetForWallTime(dateKey: string, time: string, timezone: string): string {
  return getTimezoneOffset(new Date(`${dateKey}T${time}Z`), timezone);
}

function formatTime(isoDateTime: string, timezone: string): string {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function eventDayKey(event: CalendarEvent, timezone: string): string {
  if (event.start.date) return event.start.date;
  if (event.start.dateTime) {
    return dateKeyInZone(new Date(event.start.dateTime), timezone || DEFAULT_TIMEZONE);
  }
  return '';
}

export function isAllDayEvent(event: CalendarEvent): boolean {
  return Boolean(event.start.date && !event.start.dateTime);
}

function allDayEventOverlapsDate(event: CalendarEvent, dateKey: string): boolean {
  const startKey = event.start.date;
  if (!startKey) return false;
  const endKey = event.end.date ?? addDays(startKey, 1);
  return startKey <= dateKey && dateKey < endKey;
}

export function formatEventTitle(event: CalendarEvent): string {
  const summary = event.summary?.trim();
  return summary && summary.length > 0 ? summary : '(no title)';
}

export function formatTimedEventLine(event: CalendarEvent, timezone: string): string {
  if (!event.start.dateTime || !event.end.dateTime) {
    return `- ${formatEventTitle(event)}`;
  }
  const start = formatTime(event.start.dateTime, timezone);
  const end = formatTime(event.end.dateTime, timezone);
  return `- ${start}-${end} ${formatEventTitle(event)}`;
}

export function formatAllDayEventLine(event: CalendarEvent): string {
  return `- All day: ${formatEventTitle(event)}`;
}

interface PartitionedEvents {
  todayTimed: CalendarEvent[];
  todayAllDay: CalendarEvent[];
  tomorrowTimed: CalendarEvent[];
  tomorrowAllDay: CalendarEvent[];
}

export function partitionEventsByDay(
  events: CalendarEvent[],
  now: Date,
  timezone: string
): PartitionedEvents {
  const tz = timezone || DEFAULT_TIMEZONE;
  const todayKey = dateKeyInZone(now, tz);
  const tomorrowKey = addDays(todayKey, 1);

  const todayTimed: CalendarEvent[] = [];
  const todayAllDay: CalendarEvent[] = [];
  const tomorrowTimed: CalendarEvent[] = [];
  const tomorrowAllDay: CalendarEvent[] = [];

  for (const event of events) {
    const isAllDay = isAllDayEvent(event);
    if (isAllDay) {
      if (allDayEventOverlapsDate(event, todayKey)) {
        todayAllDay.push(event);
      }
      if (allDayEventOverlapsDate(event, tomorrowKey)) {
        tomorrowAllDay.push(event);
      }
      continue;
    }

    const dayKey = eventDayKey(event, tz);
    if (dayKey === todayKey) {
      todayTimed.push(event);
    } else if (dayKey === tomorrowKey) {
      tomorrowTimed.push(event);
    }
    // Events outside today/tomorrow are dropped — the time window
    // limits API results, this is belt-and-suspenders for stragglers.
  }

  todayTimed.sort(timedEventComparator);
  tomorrowTimed.sort(timedEventComparator);

  return { todayTimed, todayAllDay, tomorrowTimed, tomorrowAllDay };
}

function timedEventComparator(a: CalendarEvent, b: CalendarEvent): number {
  const aStart = a.start.dateTime;
  const bStart = b.start.dateTime;
  const aTime = aStart ? Date.parse(aStart) : Number.POSITIVE_INFINITY;
  const bTime = bStart ? Date.parse(bStart) : Number.POSITIVE_INFINITY;

  if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
    return aTime - bTime;
  }

  return (aStart ?? '').localeCompare(bStart ?? '');
}

export function buildCalendarSectionTitle(accountEmail: string): string {
  return `🗓 ${accountEmail} daily calendar`;
}

/**
 * Short TL;DR fragment: count of events on today's calendar. Returns an
 * empty string when today is clear so the caller can drop it.
 */
export function formatCalendarTldr(events: CalendarEvent[], now: Date, timezone: string): string {
  const { todayTimed, todayAllDay } = partitionEventsByDay(events, now, timezone);
  const count = todayTimed.length + todayAllDay.length;
  if (count <= 0) return '';
  return count === 1 ? '1 event today' : `${count} events today`;
}

export function buildCalendarSectionLines(
  events: CalendarEvent[],
  now: Date,
  timezone: string
): string[] {
  const { todayTimed, todayAllDay, tomorrowTimed, tomorrowAllDay } = partitionEventsByDay(
    events,
    now,
    timezone
  );

  const todayLines: string[] = [
    ...todayTimed.map(event => formatTimedEventLine(event, timezone)),
    ...todayAllDay.map(formatAllDayEventLine),
  ];
  const tomorrowLines: string[] = [
    ...tomorrowTimed.map(event => formatTimedEventLine(event, timezone)),
    ...tomorrowAllDay.map(formatAllDayEventLine),
  ];

  if (todayLines.length === 0 && tomorrowLines.length === 0) {
    return ['_No events on your calendar for today or tomorrow morning._'];
  }

  const lines: string[] = [];
  if (todayLines.length > 0) {
    lines.push(...todayLines);
  } else {
    lines.push('No events today.');
  }

  if (tomorrowLines.length > 0) {
    lines.push('');
    lines.push('Tomorrow morning');
    lines.push(...tomorrowLines);
  }

  return lines;
}
