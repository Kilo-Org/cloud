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

/**
 * A driver and the line every write on it stands in.
 *
 * Every adapter is async, so each `await` inside a transaction lets another
 * caller's statement in — and a session and its subagent share one connection by
 * design. SQLite cannot start a transaction inside a transaction: the second
 * `BEGIN` throws, its `ROLLBACK` takes the first writer's rows with it, and the
 * first then commits nothing. A plain write that lands inside somebody else's
 * transaction is undone with it the same way. So the writes queue.
 *
 * Reads stay out of the line. A session holds itself while it writes, so no read
 * asks for the rows being written, and a load has no reason to wait behind them.
 */
interface Connection {
  readonly driver: SqlDriver;
  readonly write: <A>(work: () => Promise<A>) => Promise<A>;
}

const connectionOf = (driver: SqlDriver): Connection => {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    driver,
    write: <A>(work: () => Promise<A>): Promise<A> => {
      const next = tail.then(work, work);
      /* The line goes on after a write that failed, and the failure belongs to
         the caller who asked for it rather than to the next one waiting. */
      tail = Promise.allSettled([next]);
      return next;
    },
  };
};

/** Runs the work as one unit, so a process that dies part way leaves nothing half done. */
const transact = (connection: Connection, run: () => Promise<void>): Promise<void> =>
  connection.write(async () => {
    await connection.driver('BEGIN', [], 'run');
    try {
      await run();
      await connection.driver('COMMIT', [], 'run');
    } catch (error) {
      await connection.driver('ROLLBACK', [], 'run');
      throw error;
    }
  });

export type { Connection, SqlDriver, SqlValue };
export { connectionOf, transact };
