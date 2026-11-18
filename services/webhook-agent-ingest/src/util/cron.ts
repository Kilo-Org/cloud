import { Cron } from 'croner';

/**
 * Compute the next occurrence of a cron expression strictly after `after`
 * (defaults to now). Passing the previously targeted occurrence as `after`
 * guarantees the result advances to the following occurrence even if this
 * is called before that previous occurrence's wall-clock time has passed
 * (e.g. an alarm that fired a few seconds early).
 */
export function computeNextCronTime(
  expression: string,
  timezone: string,
  after?: Date
): Date | null {
  try {
    const job = new Cron(expression, { timezone });
    return job.nextRun(after) ?? null;
  } catch {
    return null;
  }
}

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

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
