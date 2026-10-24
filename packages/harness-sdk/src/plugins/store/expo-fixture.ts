import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type ExpoDatabase, type ExpoStatement } from './expo.js';
import type { SqlDriver, SqlValue } from './driver.js';

/**
 * Expo's SQLite is a native module, so it cannot run here. What can run is the
 * adapter: a database of the same shape, backed by Node's SQLite, proves that
 * the raw rows land in the right columns, that a prepared statement is reused,
 * and that none is left open when the store is released.
 *
 * The shapes cannot drift apart unnoticed. `layerExpoStore` takes Expo's own
 * `SQLiteDatabase`, so the compiler checks a real database against the same
 * interface this double implements.
 *
 * The double also keeps the two rules the native module keeps, because they are
 * what the adapter exists to respect: one cursor per prepared statement, so a
 * run refuses a result an earlier run was still reading, and one connection, so
 * a write that runs while a read holds its cursor is recorded rather than
 * answered with rows that moved underneath it.
 *
 * A test can also park a read after its run, which is the exact window the
 * adapter's connection gate exists to keep a write out of.
 */
interface StandIn {
  readonly database: ExpoDatabase;
  /** Statements prepared and not finalized. */
  readonly open: () => number;
  /** How many statements were prepared for the SQL texts holding this text. */
  readonly prepared: (holding: string) => number;
  /** Whether a write ran while a read was between its run and its rows. */
  readonly wroteDuringRead: () => boolean;
  /** Holds the next read after its run until the returned release is called. */
  readonly parkReads: () => { readonly reached: Promise<void>; readonly release: () => void };
}

/** A latch that stops the next read between its run and its rows. */
interface Parking {
  armed: boolean;
  reached?: () => void;
  until?: Promise<void>;
}

/** What the double shares with every statement it prepares. */
interface Backing {
  readonly sqlite: DatabaseSync;
  readonly counting: {
    readonly live: { count: number };
    readonly perText: Map<string, number>;
  };
  readonly connection: {
    reading: number;
    wrote: boolean;
  };
  readonly parking: Parking;
}

/**
 * Hands a read's result back now, or after the latch opens when a test armed
 * it: the window between a run and its rows is what the gate exists for.
 */
const releaseOf = <A>(parking: Parking, result: A): Promise<A> => {
  if (!parking.armed) {
    return Promise.resolve(result);
  }
  parking.armed = false;
  parking.reached?.();
  return (parking.until ?? Promise.resolve()).then(() => result);
};

/** One statement's cursor, which a later run of the same statement takes over. */
interface Cursor {
  generation: number;
}

/** A write: it steps the statement once and has no rows to hand back. */
const runOf =
  (connection: Backing['connection'], cursor: Cursor, statement: StatementSync) =>
  (params: SqlValue[]): Promise<void> => {
    if (connection.reading > 0) {
      connection.wrote = true;
    }
    cursor.generation += 1;
    statement.run(...params);
    return Promise.resolve();
  };

/** One run's place in its statement: the cursor it took and the rows it holds. */
interface Reading {
  readonly cursor: Cursor;
  readonly mine: number;
  readonly first: IteratorResult<Record<string, unknown>>;
  readonly rows: IterableIterator<Record<string, unknown>>;
}

/** Every row a run has, refusing a result an earlier run of it took over. */
const rowsOf = (
  connection: Backing['connection'],
  reading: Reading
): { readonly getAllAsync: () => Promise<unknown[][]> } => ({
  getAllAsync: () => {
    connection.reading -= 1;
    const { cursor, mine, first, rows } = reading;
    if (mine !== cursor.generation) {
      return Promise.reject(
        new Error('this result is no longer readable because the statement ran again')
      );
    }
    const read: unknown[][] = [];
    if (first.done !== true) {
      read.push(Object.values(first.value));
    }
    for (let row = rows.next(); row.done !== true; row = rows.next()) {
      read.push(Object.values(row.value));
    }
    return Promise.resolve(read);
  },
});

/** A read: it runs, and hands back the result a test may hold at the latch. */
const readOf =
  (backing: Backing, cursor: Cursor, statement: StatementSync) =>
  (params: SqlValue[]): Promise<{ readonly getAllAsync: () => Promise<unknown[][]> }> => {
    cursor.generation += 1;
    const mine = cursor.generation;
    backing.connection.reading += 1;
    const rows = statement.iterate(...params);
    const first = rows.next();
    return releaseOf(backing.parking, rowsOf(backing.connection, { cursor, mine, first, rows }));
  };

/**
 * One prepared statement, with the two rules expo-sqlite holds it to: a run
 * takes over the cursor its predecessor was reading, and a write is recorded
 * when it lands between a read's run and its rows.
 */
const statementOf = (backing: Backing, source: string): ExpoStatement => {
  const { sqlite, counting } = backing;
  const statement = sqlite.prepare(source);
  counting.live.count += 1;
  counting.perText.set(source, (counting.perText.get(source) ?? 0) + 1);
  const cursor: Cursor = { generation: 0 };
  return {
    executeAsync: runOf(backing.connection, cursor, statement),
    executeForRawResultAsync: readOf(backing, cursor, statement),
    finalizeAsync: () => {
      counting.live.count -= 1;
      return Promise.resolve();
    },
  };
};

/** A one-column table with one row, for the driver-level tests. */
const probeTable = async (driver: SqlDriver): Promise<void> => {
  await driver('CREATE TABLE probe (a integer)', [], 'run');
  await driver('INSERT INTO probe VALUES (1)', [], 'run');
};

/** What a test wants the double to start with. */
interface StandInOptions {
  /** A one-column table holding one row, for a test that measures something else. */
  readonly probe?: boolean;
}

const standIn = (options: StandInOptions = {}): StandIn => {
  const parking: Parking = { armed: false };
  const sqlite = new DatabaseSync(':memory:');
  if (options.probe === true) {
    sqlite.exec('CREATE TABLE probe (a integer); INSERT INTO probe VALUES (1);');
  }
  const backing: Backing = {
    sqlite,
    counting: { live: { count: 0 }, perText: new Map() },
    connection: { reading: 0, wrote: false },
    parking,
  };
  const { counting, connection } = backing;

  return {
    database: {
      prepareAsync: (source: string) => Promise.resolve(statementOf(backing, source)),
    },
    open: () => counting.live.count,
    prepared: holding =>
      [...counting.perText].reduce(
        (sum, [source, count]) => (source.includes(holding) ? sum + count : sum),
        0
      ),
    wroteDuringRead: () => connection.wrote,
    parkReads: () => {
      const reached = Promise.withResolvers<void>();
      const open = Promise.withResolvers<void>();
      parking.armed = true;
      parking.reached = reached.resolve;
      parking.until = open.promise;
      return { reached: reached.promise, release: open.resolve };
    },
  };
};

export { probeTable, standIn };
export type { StandIn, StandInOptions };
