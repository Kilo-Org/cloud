import { i18n } from '@/i18n';
import { calendarDaysBetween } from '@/lib/device-calendar-day';
import { deviceTimeZone, relativeTimeFormat } from '@/lib/intl-cache';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/** `timeAgo`'s `day` bucket starts here; its `month` bucket starts at 30 days. */
const DAY_UNIT_SECONDS = 24 * 60 * 60;
const MONTH_UNIT_SECONDS = 30 * DAY_UNIT_SECONDS;

/**
 * The relative label of a row that sits under a date heading, with its day word
 * read from the calendar instead of a rolling 24-hour window.
 *
 * `timeAgo` answers "how long ago", so it calls everything 24-48 hours old
 * "yesterday". That is false once today's clock has moved past the session's
 * own: read on Tuesday 20:52, a session from Sunday 21:00 is 47 hours old, so a
 * row would say "yesterday" while the heading above it says Sunday. The day
 * bucket therefore counts calendar days between the two local dates, in the
 * device's zone (`deviceTimeZone`), the same zone the section heading uses.
 * Minutes and hours stay elapsed-time facts, and a label `timeAgo` resolved to
 * the month or year unit is returned unchanged.
 *
 * The label keeps `timeAgo`'s natural casing, so a caller that draws it in
 * capitals and a caller that speaks it share one answer. Empty when the
 * timestamp does not parse, so the caller shows nothing rather than an invalid
 * date.
 */
export function calendarDayRelativeLabel(
  timestamp: string | null | undefined,
  options: { nowMs?: number; timeZone?: string } = {}
): string {
  const nowMs = options.nowMs;
  const timeZone = options.timeZone ?? deviceTimeZone();
  const date = parseTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const now = nowMs ?? Date.now();
  const elapsed = timeAgo(date, undefined, now);
  const magnitude = Math.abs(Math.floor((now - date.getTime()) / 1000));
  if (magnitude < DAY_UNIT_SECONDS || magnitude >= MONTH_UNIT_SECONDS) {
    return elapsed;
  }
  const days = calendarDaysBetween(date, new Date(now), timeZone);
  if (!Number.isFinite(days)) {
    // Nothing readable from the calendar: keep the elapsed-time word rather
    // than hand the formatter a NaN, which throws.
    return elapsed;
  }
  return relativeTimeFormat(i18n.language, { numeric: 'auto' }).format(-days, 'day');
}
