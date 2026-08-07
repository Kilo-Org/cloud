const TIME_ONLY = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** The Date for a transcript timestamp, or null when it is absent or unusable. */
function toTranscriptDate(created: number | undefined | null): Date | null {
  if (created === undefined || created === null || !Number.isFinite(created) || created <= 0) {
    return null;
  }
  const date = new Date(created);
  // A finite but out-of-range epoch (e.g. Number.MAX_VALUE) yields an Invalid Date,
  // and Intl.DateTimeFormat.format throws on one.
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whether a timestamp can be rendered at all. The builder and the marker share this rule. */
export function isValidTranscriptTime(created: number | undefined | null): boolean {
  return toTranscriptDate(created) !== null;
}

/** Whether two epoch-ms instants fall on the same local calendar day. */
export function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

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
  const date = toTranscriptDate(created);
  if (date === null) {
    return null;
  }
  return isSameLocalDay(date.getTime(), now) ? TIME_ONLY.format(date) : DATE_TIME.format(date);
}

/**
 * Label for a transcript time marker.
 *
 * `dayChanged` is true when the marker opens a different local calendar day than the
 * previous marker's run. Such a marker always carries the date, even when it falls
 * today: the date is the information the marker exists to deliver. Every other marker
 * keeps the message-label rule — today shows the time, an older day shows date and time.
 */
export function formatTranscriptMarkerLabel(
  created: number | undefined | null,
  now: number,
  dayChanged: boolean
): string | null {
  const date = toTranscriptDate(created);
  if (date === null) {
    return null;
  }
  if (dayChanged) {
    return DATE_TIME.format(date);
  }
  return formatTranscriptTimeLabel(created, now);
}
