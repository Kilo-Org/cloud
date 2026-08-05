const TIME_ONLY = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Format an epoch-ms created timestamp for the message time label.
 * Same local day as `now` → time only; any other local day → date and time.
 * Returns null for absent, invalid, non-positive, or out-of-range epochs
 * without throwing (an Invalid Date makes `Intl.DateTimeFormat.format` throw).
 */
export function formatTranscriptTimeLabel(
  created: number | undefined | null,
  now: number
): string | null {
  if (created === undefined || created === null || !Number.isFinite(created) || created <= 0) {
    return null;
  }
  const createdDate = new Date(created);
  if (Number.isNaN(createdDate.getTime())) {
    return null;
  }
  const nowDate = new Date(now);
  const sameDay =
    createdDate.getFullYear() === nowDate.getFullYear() &&
    createdDate.getMonth() === nowDate.getMonth() &&
    createdDate.getDate() === nowDate.getDate();
  return sameDay ? TIME_ONLY.format(createdDate) : DATE_TIME.format(createdDate);
}
