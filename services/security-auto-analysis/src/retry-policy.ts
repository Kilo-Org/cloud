/**
 * Retry backoff for a queued analysis start. Both entrypoints share it so a
 * manual start that requeues waits on the same schedule the scheduler uses for
 * the same queue row.
 */
export function nextRetryAt(attemptCount: number): Date {
  const baseDelayMs = 15_000 * 2 ** Math.max(0, attemptCount);
  const cappedDelayMs = Math.min(15 * 60 * 1000, baseDelayMs);
  const jitterMs = Math.round(cappedDelayMs * Math.random() * 0.2);
  return new Date(Date.now() + cappedDelayMs + jitterMs);
}
