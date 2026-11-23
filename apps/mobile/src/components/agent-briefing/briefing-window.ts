import { formatDate } from '@/lib/format';
import { deviceTimeZone } from '@/lib/intl-cache';
import { parseTimestamp } from '@/lib/utils';

const BRIEFING_DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

/** A briefing instant's text and the zone that text was written in. */
type BriefingTimestamp = {
  readonly text: string;
  readonly timeZone: string;
};

/**
 * A briefing instant on the report's clock. The night window and every source
 * timestamp belong to the reader's configured briefing time zone, not the
 * device's: a 22:00-08:00 schedule reads as that window on every device.
 * An unknown zone (preferences not loaded or offline with no snapshot) keeps
 * the device zone, which is what the screen rendered before the zone was read.
 * A zone the runtime cannot resolve falls back the same way, so a report still
 * renders.
 *
 * The returned zone is the one the text was actually formatted in, so a caption
 * beside the text names that zone instead of repeating the requested one: a
 * zone the runtime refused would otherwise be printed over a device-zone clock.
 */
export function formatBriefingTimestamp(
  value: string,
  locale: string,
  timeZone: string | undefined
): BriefingTimestamp {
  const date = parseTimestamp(value);
  if (timeZone) {
    try {
      return { text: formatDate(date, locale, { ...BRIEFING_DATE_TIME, timeZone }), timeZone };
    } catch {
      // `Intl` rejects a zone name it does not know; the device zone is the fallback.
    }
  }
  return {
    text: formatDate(date, locale, BRIEFING_DATE_TIME),
    timeZone: deviceTimeZone(),
  };
}
