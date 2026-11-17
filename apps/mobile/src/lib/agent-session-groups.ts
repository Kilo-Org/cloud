import { i18n } from '@/i18n';
import { calendarDayIndex } from '@/lib/device-calendar-day';
import { dateTimeFormat, deviceTimeZone } from '@/lib/intl-cache';
import {
  type AgentSessionSortBy,
  getAgentSessionTimestamp,
  parseAgentSessionSortBy,
} from './agent-session-sort';
import { parseTimestamp } from '@/lib/utils';

type SessionTimestamps = { created_at: string; updated_at: string };

export type AgentSessionDateGroup<T extends SessionTimestamps> = {
  label: string;
  sessions: T[];
};

/** A weekday section covers the previous seven days at most. */
const WEEKDAY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function getWeekdayName(date: Date, timeZone: string): string {
  // The active language, not en-US: a day heading in the session list must
  // read in the language the rest of the list reads in. The zone is explicit
  // for the same reason the day index is: `Date`'s local getters keep the zone
  // the runtime started in, and a heading must name the day the device shows.
  return dateTimeFormat(i18n.language, { weekday: 'long', timeZone }).format(date);
}

/**
 * Bucket sessions into the existing Today / Yesterday / weekday / Older
 * sections, sorted newest-first by the selected timestamp. The input array
 * is never mutated — callers can hand in the tRPC query result directly.
 *
 * Each session's selected timestamp is parsed exactly once, before sorting:
 * the sort, the section boundary checks and the in-section order all read
 * that one millisecond value, so the work stays linear in the retained
 * history instead of growing with the comparison count.
 *
 * Server-side ordering is authoritative for cross-page consistency, but
 * every section boundary check uses the same timestamp the row's relative
 * meta label will display, so a session can never end up in a section that
 * contradicts the timestamp it shows.
 *
 * `now` and `timeZone` decide the calendar. Both are inputs, not reads: the
 * caller passes the ticked clock and the zone `Intl` resolves now, so opening
 * the list before a zone change or a midnight cannot freeze its sections in
 * the calendar the process started in.
 */
export function groupAgentSessionsByDate<T extends SessionTimestamps>(
  sessions: T[],
  sortBy: AgentSessionSortBy,
  options: { now?: Date; timeZone?: string } = {}
): AgentSessionDateGroup<T>[] {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? deviceTimeZone();
  // Defensive: tolerate callers (e.g. older call sites) that pass an unknown
  // string here, the same way parseAgentSessionSortBy would have.
  const resolvedSort = parseAgentSessionSortBy(sortBy);
  // Parse each selected timestamp once and pair it with its session, so the
  // sort comparator below is a numeric subtraction and the bucketing loop
  // reads the same value instead of parsing again. Hermes' string dates and
  // the date-only branch of `parseTimestamp` make a parse the expensive part.
  const decorated = sessions.map(session => ({
    session,
    ms: parseTimestamp(getAgentSessionTimestamp(session, resolvedSort)).getTime(),
  }));
  // eslint-disable-next-line unicorn/no-array-sort -- Hermes does not implement Array.prototype.toSorted; `decorated` is a local copy, so the caller's array is untouched
  decorated.sort((a, b) => b.ms - a.ms);

  const nowMs = now.getTime();
  const todayIndex = calendarDayIndex(now, timeZone);
  const todayLabel = i18n.t('chat.conversationList.today');
  const yesterdayLabel = i18n.t('chat.conversationList.yesterday');
  const olderLabel = i18n.t('chat.conversationList.older');

  const buckets = new Map<string, T[]>();
  const bucketOrder: string[] = [];

  function addToBucket(label: string, session: T) {
    const existing = buckets.get(label);
    if (existing) {
      existing.push(session);
    } else {
      buckets.set(label, [session]);
      bucketOrder.push(label);
    }
  }

  for (const { session, ms } of decorated) {
    const date = new Date(ms);
    const dayIndex = calendarDayIndex(date, timeZone);

    // A row dated after today, and a calendar the formatter could not read,
    // both leave the two nameable sections alone: the elapsed window below
    // decides, exactly as it did before the sections read the calendar. A
    // future row keeps its own weekday heading, and a row with no readable
    // date cannot be claimed as today's or yesterday's.
    if (dayIndex === todayIndex) {
      addToBucket(todayLabel, session);
    } else if (dayIndex === todayIndex - 1) {
      addToBucket(yesterdayLabel, session);
    } else if (nowMs - ms <= WEEKDAY_WINDOW_MS) {
      addToBucket(getWeekdayName(date, timeZone), session);
    } else {
      addToBucket(olderLabel, session);
    }
  }

  // Every bucket is filled in `decorated` order, which is already newest-first
  // by the selected timestamp, so no bucket needs a second sort.

  return bucketOrder.map(label => ({
    label,
    sessions: buckets.get(label) ?? [],
  }));
}
