import { DatabaseSync } from 'node:sqlite';
import { type ExpoDatabase, type ExpoStatement } from './expo.js';
import type { SqlValue } from './driver.js';

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

/**
 * One prepared statement, with the two rules expo-sqlite holds it to.
 *
 * A statement is a single object literal here, so the two shape rules count its
 * members rather than the steps of anything it does.
 */
// eslint-disable-next-line max-lines-per-function, max-statements
const statementOf = (backing: Backing, source: string): ExpoStatement => {
  const { sqlite, counting, connection, parking } = backing;
  const statement = sqlite.prepare(source);
  counting.live.count += 1;
  counting.perText.set(source, (counting.perText.get(source) ?? 0) + 1);
  let generation = 0;
  return {
    executeAsync: (params: SqlValue[]) => {
      if (connection.reading > 0) {
        connection.wrote = true;
      }
      generation += 1;
      statement.run(...params);
      return Promise.resolve();
    },
    executeForRawResultAsync: (params: SqlValue[]) => {
      generation += 1;
      const mine = generation;
      connection.reading += 1;
      const rows = statement.iterate(...params);
      const first = rows.next();
      const result = {
        getAllAsync: () => {
          connection.reading -= 1;
          if (mine !== generation) {
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
      };
      return releaseOf(parking, result);
    },
    finalizeAsync: () => {
      counting.live.count -= 1;
      return Promise.resolve();
    },
  };
};

const standIn = (): StandIn => {
  const parking: Parking = { armed: false };
  const backing: Backing = {
    sqlite: new DatabaseSync(':memory:'),
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

export { standIn };
export type { StandIn };
