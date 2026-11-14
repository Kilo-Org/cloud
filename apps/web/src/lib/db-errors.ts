const MAX_CAUSE_DEPTH = 5;
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * Returns the PostgreSQL SQLSTATE code for `error`, or `null` when the error is
 * not (and does not wrap) a database error.
 *
 * Drizzle wraps the driver error in a `DrizzleQueryError`, so the code is not
 * always at a fixed depth; the `.cause` chain is walked up to
 * `MAX_CAUSE_DEPTH`. The five-character `[0-9A-Z]` shape disambiguates a
 * SQLSTATE from unrelated `code` fields (e.g. Node's `ENOTFOUND`).
 */
export function getPostgresErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== 'object') return null;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && SQLSTATE_PATTERN.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause;
  }
  return null;
}

/**
 * SQLSTATE codes that signal a transient lock or timeout failure, for which the
 * same transaction can be retried: deadlock detected (40P01), lock not available
 * (55P03) and query canceled, including statement timeout (57014).
 */
export const RETRYABLE_TRANSACTION_SQLSTATES: ReadonlySet<string> = new Set([
  '40P01',
  '55P03',
  '57014',
]);

/** True when `error` is a PostgreSQL unique-constraint violation (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === '23505';
}
