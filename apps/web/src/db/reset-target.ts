/**
 * Decides which connection `db:empty-database` empties.
 *
 * The reset runs through the `script` launcher, so `IS_SCRIPT` is set and the shared drizzle module
 * connects to `POSTGRES_SCRIPT_URL`. The step that follows the reset in the development guides is
 * `pnpm drizzle migrate`, which reads `POSTGRES_URL`. Emptying one database and then migrating
 * another leaves the developer with an empty database and no error, so the two must name the same
 * database before the reset runs.
 *
 * The comparison uses the same parse the pool uses, so a URL written with a different case, an
 * escape, or no path compares equal to the database it names, while a URL naming another database
 * is still refused.
 *
 * This module holds no side effect: `./require-reset-target` applies the decision, and the tests
 * read it here.
 */

import { postgresConnectionTarget } from '@kilocode/db';

/**
 * A connection target that two URLs must share for the reset and the migrate step to agree.
 *
 * The database name is part of the target, because two databases on one host are still two
 * databases.
 */
function connectionTarget(value: string): string | null {
  try {
    const { host, port, database } = postgresConnectionTarget(value);
    return [host, port, database].join('\u0000');
  } catch {
    return null;
  }
}

export type ResetTarget =
  /** The reset may proceed against `scriptUrl`. */
  | { kind: 'use'; scriptUrl: string }
  /** The reset must not run; `reason` names the problem for the operator. */
  | { kind: 'refuse'; reason: string };

/**
 * Resolves the two connection variables into the reset's target.
 *
 * An unset `POSTGRES_SCRIPT_URL` inherits `POSTGRES_URL`, so a checkout that predates the variable
 * empties the same database it emptied before. When both are set they must name the same database:
 * a mismatch is refused rather than resolved in either direction, because either choice would
 * empty a database the following migrate step does not recreate.
 */
export function resolveResetTarget(appUrl?: string, scriptUrl?: string): ResetTarget {
  if (!scriptUrl) {
    return appUrl ? { kind: 'use', scriptUrl: appUrl } : { kind: 'refuse', reason: 'both-unset' };
  }
  if (!appUrl) {
    return { kind: 'use', scriptUrl };
  }
  const appTarget = connectionTarget(appUrl);
  const scriptTarget = connectionTarget(scriptUrl);
  if (appTarget === null || scriptTarget === null) {
    return { kind: 'refuse', reason: 'unparseable' };
  }
  if (appTarget !== scriptTarget) {
    return { kind: 'refuse', reason: 'different-databases' };
  }
  return { kind: 'use', scriptUrl };
}

const REFUSALS: Record<string, string> = {
  'both-unset':
    'Refusing to reset: neither POSTGRES_URL nor POSTGRES_SCRIPT_URL is set. ' +
    'Point one at the database you want to reset.',
  unparseable:
    'Refusing to reset: POSTGRES_URL or POSTGRES_SCRIPT_URL is not a connection URL. ' +
    'Fix the malformed value in your environment file.',
  'different-databases':
    'Refusing to reset: POSTGRES_URL and POSTGRES_SCRIPT_URL name different databases. ' +
    'The reset empties the script connection, and "pnpm drizzle migrate" then recreates the ' +
    'schema on the app connection, so both must name the database you want to reset.',
};

/** The operator-facing text for a refused target. */
export function refusalMessage(target: Extract<ResetTarget, { kind: 'refuse' }>): string {
  return REFUSALS[target.reason];
}
