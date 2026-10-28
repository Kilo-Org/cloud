const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Wraps `log` so it runs at most once per interval per instance. Each logged
 * entry reports how many calls were suppressed since the previous one, so the
 * total volume can still be estimated.
 */
export function throttledLog(
  log: (details: Record<string, unknown>) => void,
  intervalMs = DEFAULT_INTERVAL_MS,
  now: () => number = Date.now
): (details: Record<string, unknown>) => void {
  let lastLoggedAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;
  return details => {
    const time = now();
    if (time - lastLoggedAt < intervalMs) {
      suppressed++;
      return;
    }
    log({ ...details, suppressedSinceLastLog: suppressed });
    lastLoggedAt = time;
    suppressed = 0;
  };
}
