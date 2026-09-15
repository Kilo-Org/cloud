import { assert } from 'typia';
import { transact, type Connection, type SqlDriver } from './driver.js';
import { migrations } from './migrations.js';

/**
 * Applying the migrations the bundle carries.
 *
 * The SQL is inlined rather than read from disk: React Native has no filesystem
 * to read it from, and Drizzle's answer there is a bundler plugin, which a
 * package must not force on the people who install it. `pnpm check:migrations`
 * is what keeps the inlined copy honest.
 */

/**
 * How many migrations this database has had, held in SQLite's own
 * `user_version`. It costs no table of our own and no query on the read path.
 */
const versionOf = async (driver: SqlDriver): Promise<number> => {
  const { rows } = await driver('PRAGMA user_version', [], 'get');
  return assert<readonly number[]>(rows)[0] ?? 0;
};

/**
 * Runs the statements in order. A migration that reorders is a migration that
 * fails, so these cannot be a `Promise.all`. It recurses rather than loops
 * because `no-await-in-loop` reads a sequential loop as a missed chance to run
 * in parallel, which here is the whole point.
 */
const runAll = async (driver: SqlDriver, statements: readonly string[]): Promise<void> => {
  const [first, ...rest] = statements;
  if (first === undefined) {
    return;
  }
  await driver(first, [], 'run');
  await runAll(driver, rest);
};

/**
 * Applies every migration the database has not seen, then records how far it
 * got. The version is written into the statement rather than bound, because
 * SQLite allows no parameter in a pragma. The value is this array's length,
 * never anything a caller supplies.
 */
const applyPending = async (driver: SqlDriver, applied: number): Promise<void> => {
  await runAll(driver, migrations.slice(applied).flat());
  await driver(`PRAGMA user_version = ${String(migrations.length)}`, [], 'run');
};

/** Migrates in one unit, so the version and the schema always agree. */
const migrate = async (connection: Connection): Promise<void> => {
  const { driver } = connection;
  const applied = await versionOf(driver);
  if (applied >= migrations.length) {
    return;
  }
  await transact(connection, () => applyPending(driver, applied));
};

export { migrate };
