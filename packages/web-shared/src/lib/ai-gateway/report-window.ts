/**
 * Bounds repeated reports of one recurring failure in this process. A condition that repeats on
 * every request, such as a stored key that cannot be decrypted, an unreachable cache, or a model
 * whose usage keeps reporting impossible token counts, would otherwise add a Sentry event or a log
 * line per request, so each report key reports at most once per window.
 */
export const REPORT_WINDOW_MS = 10 * 60_000;

/**
 * Cap on remembered keys, so a burst of distinct failing keys cannot grow the map without
 * limit. A forgotten key simply reports again, which the window allows anyway.
 */
export const MAX_TRACKED_REPORT_KEYS = 1_000;

const reportedAt = new Map<string, number>();

/** True when `key` has not been reported within the window; records `now` as its report time. */
export function claimReportWindow(key: string, now: number): boolean {
  const reported = reportedAt.get(key);
  if (reported !== undefined && now - reported < REPORT_WINDOW_MS) return false;
  // Re-inserting moves the key to the end of the map's insertion order, so the eviction
  // below always forgets the least recently reported key.
  reportedAt.delete(key);
  reportedAt.set(key, now);
  while (reportedAt.size > MAX_TRACKED_REPORT_KEYS) {
    const oldest = reportedAt.keys().next();
    if (oldest.done) break;
    reportedAt.delete(oldest.value);
  }
  return true;
}
