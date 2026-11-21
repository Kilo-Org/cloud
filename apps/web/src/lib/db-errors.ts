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

/**
 * Returns the name of the unique index that `error` violated, or `null` when
 * the error is not a unique-constraint violation or names no index.
 *
 * Drizzle wraps the driver error in a `DrizzleQueryError` and the driver keeps
 * the index name on its own error object, so `.constraint` sits behind the same
 * `.cause` chain the SQLSTATE needs. Callers branch on one index to give a
 * precise reason and keep a generic sentence for every other 23505.
 */
export function getUniqueViolationConstraint(error: unknown): string | null {
  if (!isUniqueViolation(error)) return null;

  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (current === null || typeof current !== 'object') return null;
    if ('constraint' in current && typeof current.constraint === 'string') {
      return current.constraint;
    }
    current = 'cause' in current ? current.cause : null;
  }
  return null;
}

/**
 * Unique indexes a create can hit on `agent_environment_profiles` for one
 * owner's profile name. Any other 23505 on a create is not a name clash.
 */
export type ProfileNameUniqueConstraint =
  | 'UQ_agent_env_profiles_org_name'
  | 'UQ_agent_env_profiles_user_name';

const PROFILE_NAME_UNIQUE_CONSTRAINTS: Record<ProfileNameUniqueConstraint, true> = {
  UQ_agent_env_profiles_org_name: true,
  UQ_agent_env_profiles_user_name: true,
};

/** True when a violated index is one of the profile-name unique indexes. */
export function isProfileNameUniqueConstraint(
  constraint: string | null
): constraint is ProfileNameUniqueConstraint {
  return constraint !== null && Object.hasOwn(PROFILE_NAME_UNIQUE_CONSTRAINTS, constraint);
}
