/**
 * Bounds repeated reports of the same BYOK key failure. A stored key whose envelope cannot be
 * decrypted would otherwise add a Sentry event to every credential lookup, so each key reports
 * at most once per window in this process.
 */
export const BYOK_FAILURE_REPORT_WINDOW_MS = 10 * 60_000;

const reportedAt = new Map<string, number>();

/** True when `key` has not been reported within the window; records `now` as its report time. */
export function claimFailureReport(key: string, now: number): boolean {
  for (const [reportedKey, at] of reportedAt) {
    if (now - at >= BYOK_FAILURE_REPORT_WINDOW_MS) reportedAt.delete(reportedKey);
  }
  if (reportedAt.has(key)) return false;
  reportedAt.set(key, now);
  return true;
}
