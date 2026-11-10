import { i18n } from '@/i18n';
import { relativeTimeFormat } from '@/lib/intl-cache';
import { parseTimestamp, timeAgo } from '@/lib/utils';

const DAY_MS = 24 * 60 * 60 * 1000;
/** `timeAgo`'s `day` bucket starts here; its `month` bucket starts at 30 days. */
const DAY_UNIT_SECONDS = 24 * 60 * 60;
const MONTH_UNIT_SECONDS = 30 * DAY_UNIT_SECONDS;

/**
 * Whole local calendar days from `from`'s date to `to`'s date, positive when
 * `to` is later. Counts midnights rather than elapsed milliseconds, so a day
 * that lost or gained an hour still counts as one day.
 */
export function calendarDaysBetween(from: Date, to: Date): number {
  const fromMidnight = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const toMidnight = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((toMidnight.getTime() - fromMidnight.getTime()) / DAY_MS);
}

/**
 * The day word of a relative label, read from the calendar instead of a rolling
 * 24-hour window.
 *
 * `timeAgo` answers "how long ago", so it calls everything 24-48 hours old
 * "yesterday". That is false once today's clock has moved past the session's
 * own: read on Tuesday 20:52, a session from Sunday 21:00 is 47 hours old, so a
 * row would say "yesterday" while the heading above it says Sunday. A surface
 * that groups rows by calendar day passes its elapsed-time label here and gets
 * the day bucket replaced by the calendar distance.
 *
 * Minutes and hours stay elapsed-time facts, and a label `timeAgo` resolved to
 * the month or year unit is returned unchanged. `elapsedLabel` must already be
 * cased for display; the replacement is cased the same way.
 */
export function calendarDayLabel(date: Date, nowMs: number, elapsedLabel: string): string {
  const elapsedSeconds = Math.floor((nowMs - date.getTime()) / 1000);
  const magnitude = Math.abs(elapsedSeconds);
  if (magnitude < DAY_UNIT_SECONDS || magnitude >= MONTH_UNIT_SECONDS) {
    return elapsedLabel;
  }
  const days = calendarDaysBetween(date, new Date(nowMs));
  return relativeTimeFormat(i18n.language, { numeric: 'auto' })
    .format(-days, 'day')
    .toLocaleUpperCase(i18n.language);
}

/**
 * The relative label of a row that sits under a date heading: `formatMeta`'s
 * label with its day word taken from the calendar. Empty when the timestamp
 * does not parse, so the caller shows nothing rather than an invalid date.
 */
export function calendarDayRelativeLabel(
  timestamp: string | null | undefined,
  nowMs?: number
): string {
  const date = parseTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const now = nowMs ?? Date.now();
  return calendarDayLabel(
    date,
    now,
    timeAgo(date, undefined, now).toLocaleUpperCase(i18n.language)
  );
}
