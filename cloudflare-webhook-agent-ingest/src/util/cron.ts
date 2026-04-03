import { Cron } from 'croner';

/**
 * Compute the next occurrence of a cron expression after now.
 */
export function computeNextCronTime(expression: string, timezone: string): Date | null {
  try {
    const job = new Cron(expression, { timezone });
    return job.nextRun() ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate a cron expression. Returns { valid: true } or { valid: false, error: string }.
 */
export function validateCronExpression(
  expression: string
): { valid: true } | { valid: false; error: string } {
  try {
    new Cron(expression);
    return { valid: true };
  } catch (e) {
    return { valid: false, error: e instanceof Error ? e.message : 'Invalid cron expression' };
  }
}

/**
 * Check that the minimum interval between consecutive runs is at least `minMs` milliseconds.
 * Default minimum is 60000ms (1 minute).
 */
export function enforcesMinimumInterval(
  expression: string,
  timezone: string,
  minMs: number = 60_000
): boolean {
  try {
    const job = new Cron(expression, { timezone });
    const first = job.nextRun();
    if (!first) return false;
    const second = job.nextRun(first);
    if (!second) return false;
    return second.getTime() - first.getTime() >= minMs;
  } catch {
    return false;
  }
}

/**
 * Check if a string is a valid IANA timezone identifier.
 */
export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
