/**
 * Decides which connection `db:empty-database` empties, before the shared drizzle module reads it.
 *
 * The reset runs through the `script` launcher, so `IS_SCRIPT` is set and drizzle connects to
 * `POSTGRES_SCRIPT_URL`. The step that follows the reset in the development guides is
 * `pnpm drizzle migrate`, which reads `POSTGRES_URL`. Emptying one database and then migrating
 * another leaves the developer with an empty database and no error, so this module settles the
 * script connection before a pool exists.
 *
 * Import order matters: it must be imported after `./load-env` and before anything that imports
 * `@kilocode/web-shared/lib/drizzle`, because module evaluation follows import order.
 */

/** A connection target that two URLs must share for the reset and the migrate step to agree. */
function connectionTarget(value: string): string | null {
  try {
    const url = new URL(value);
    // The database name is part of the target: two databases on one host are still two databases.
    return [url.hostname, url.port, url.pathname].join('\u0000');
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

const target = resolveResetTarget(process.env.POSTGRES_URL, process.env.POSTGRES_SCRIPT_URL);

if (target.kind === 'refuse') {
  console.error(REFUSALS[target.reason]);
  process.exit(1);
}

process.env.POSTGRES_SCRIPT_URL = target.scriptUrl;
