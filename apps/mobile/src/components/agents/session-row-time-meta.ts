import { i18n } from '@/i18n';
import { calendarDayRelativeLabel } from '@/lib/calendar-day-label';
import { formatClockTime } from '@/lib/format';
import { parseTimestamp, timeAgo } from '@/lib/utils';

/**
 * Time meta for one session row: the label the row draws, the clock time when
 * the relative label was replaced because it restated the row's section, and the
 * label the row speaks.
 */
export type SessionRowTimeMeta = {
  visible: string;
  /** The clock time that replaced the relative label, or `null` when it stands. */
  clock: string | null;
  /** The same label in sentence case, for the row's spoken meta. */
  spoken: string;
};

/**
 * Time meta for a session row that sits under a date section heading.
 *
 * A row with no heading — a Home card, the share sheet — keeps the elapsed-time
 * label every other surface reads (`formatMeta`), so only the rows that sit
 * under a heading change.
 *
 * Under a heading the day word comes from the calendar
 * (`calendarDayRelativeLabel`), so the row can never claim "yesterday" for a
 * session the heading above it files two days back, and in the Yesterday
 * section that word is the heading directly above the row (`YESTERDAY` under
 * `YESTERDAY`), so the row restated its own section. When the two strings match
 * — the same locale-folded text on screen, not a bucket rule — the row shows
 * the clock time of its own timestamp instead. Every other heading (Today, a
 * weekday, Older) never matches the relative label it renders, so those rows
 * keep it.
 *
 * `clock` is the replacement when one was made, so the spoken label says the
 * same clock time instead of repeating the section, and `null` when the
 * relative label stands. `spoken` is the label the row's accessibility label
 * reads, in the sentence case `formatSpokenTimeAgo` produces. `nowMs` is the
 * caller's sampled clock, as in `formatMeta`, and `timeZone` is the zone the
 * section above the row was grouped in, so the two always name the same day.
 */
export function sectionAwareTimeMeta(
  timestamp: string | null | undefined,
  sectionTitle: string | null | undefined,
  options: { nowMs?: number; timeZone?: string } = {}
): SessionRowTimeMeta {
  const date = parseTimestamp(timestamp);
  if (Number.isNaN(date.getTime())) {
    return { visible: '', clock: null, spoken: '' };
  }
  if (!sectionTitle) {
    const elapsed = timeAgo(date, undefined, options.nowMs);
    return {
      visible: elapsed.toLocaleUpperCase(i18n.language),
      clock: null,
      spoken: elapsed,
    };
  }
  const relative = calendarDayRelativeLabel(timestamp, options);
  const stands: SessionRowTimeMeta = {
    visible: relative.toLocaleUpperCase(i18n.language),
    clock: null,
    spoken: relative,
  };
  if (
    relative === '' ||
    relative.toLocaleLowerCase(i18n.language) !==
      sectionTitle.trim().toLocaleLowerCase(i18n.language)
  ) {
    return stands;
  }
  const clock = formatClockTime(date, i18n.language);
  return { visible: clock, clock, spoken: clock };
}
