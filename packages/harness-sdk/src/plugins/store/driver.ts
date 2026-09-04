/**
 * The seam every platform adapter fills: run this SQL with these parameters and
 * give back the rows.
 *
 * That is the whole of it, which is why `node.ts` and `expo.ts` are about twenty
 * lines each and share every query in this folder.
 */

/** What this store binds to a statement. It holds text and numbers, nothing else. */
type SqlValue = string | number | null;

/**
 * Rows come back by position, not by name, which is the shape drizzle maps onto
 * the selected columns.
 */
type SqlDriver = (
  sql: string,
  params: readonly SqlValue[],
  method: 'run' | 'all' | 'values' | 'get'
) => Promise<{ rows: unknown[] }>;

/** Runs the work as one unit, so a process that dies part way leaves nothing half done. */
const transact = async (driver: SqlDriver, run: () => Promise<void>): Promise<void> => {
  await driver('BEGIN', [], 'run');
  try {
    await run();
    await driver('COMMIT', [], 'run');
  } catch (error) {
    await driver('ROLLBACK', [], 'run');
    throw error;
  }
};

export type { SqlDriver, SqlValue };
export { transact };
