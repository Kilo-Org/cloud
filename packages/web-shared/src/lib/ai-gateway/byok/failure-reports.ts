/**
 * Bounds repeated reports of the same BYOK key failure. A stored key whose envelope cannot be
 * decrypted would otherwise add a Sentry event to every credential lookup, so each key reports
 * at most once per window in this process.
 */
export const BYOK_FAILURE_REPORT_WINDOW_MS = 10 * 60_000;

/**
 * Cap on remembered keys, so a burst of distinct failing keys cannot grow the map without
 * limit. A forgotten key simply reports again, which the window allows anyway.
 */
export const MAX_TRACKED_FAILURES = 1_000;

const reportedAt = new Map<string, number>();

/** True when `key` has not been reported within the window; records `now` as its report time. */
export function claimFailureReport(key: string, now: number): boolean {
  const reported = reportedAt.get(key);
  if (reported !== undefined && now - reported < BYOK_FAILURE_REPORT_WINDOW_MS) return false;
  // Re-inserting moves the key to the end of the map's insertion order, so the eviction
  // below always forgets the least recently reported key.
  reportedAt.delete(key);
  reportedAt.set(key, now);
  while (reportedAt.size > MAX_TRACKED_FAILURES) {
    const oldest = reportedAt.keys().next();
    if (oldest.done) break;
    reportedAt.delete(oldest.value);
  }
  return true;
}
