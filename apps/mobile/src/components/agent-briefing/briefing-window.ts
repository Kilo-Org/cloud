import { formatDate } from '@/lib/format';
import { parseTimestamp } from '@/lib/utils';

const BRIEFING_DATE_TIME: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

/**
 * A briefing instant on the report's clock. The night window and every source
 * timestamp belong to the reader's configured briefing time zone, not the
 * device's: a 22:00-08:00 schedule reads as that window on every device.
 * An unknown zone (preferences not loaded or offline with no snapshot) keeps
 * the device zone, which is what the screen rendered before the zone was read.
 * A zone the runtime cannot resolve falls back the same way, so a report still
 * renders.
 */
export function formatBriefingTimestamp(
  value: string,
  locale: string,
  timeZone: string | undefined
): string {
  const date = parseTimestamp(value);
  if (timeZone) {
    try {
      return formatDate(date, locale, { ...BRIEFING_DATE_TIME, timeZone });
    } catch {
      // `Intl` rejects a zone name it does not know; the device zone is the fallback.
    }
  }
  return formatDate(date, locale, BRIEFING_DATE_TIME);
}
