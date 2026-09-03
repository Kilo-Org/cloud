import type { SQLiteDatabase } from 'expo-sqlite';
import type { Layer } from 'effect';
import type { SessionStore, StoreError } from '../../core/storage.js';
import { layerSqliteStore, type SqlDriver, type SqlValue } from './sqlite.js';

/**
 * The store on Expo's SQLite, which is how a React Native app reaches one.
 *
 * The Expo import is a type, so nothing of Expo survives the build. The
 * database arrives already open, exactly as on Node, and this file only teaches
 * the shared store how to talk to it.
 */

/**
 * The part of an Expo database this adapter uses.
 *
 * The driver is written against this rather than against `SQLiteDatabase` so a
 * test can supply one without a native module. `layerExpoStore` still takes the
 * real type, so the compiler keeps checking that a real database is one of
 * these.
 */
interface ExpoStatement {
  readonly executeSync: (params: SqlValue[]) => unknown;
  readonly executeForRawResultSync: (params: SqlValue[]) => {
    readonly getAllSync: () => unknown[][];
  };
  readonly finalizeSync: () => void;
}

interface ExpoDatabase {
  readonly prepareSync: (source: string) => ExpoStatement;
}

/**
 * A statement holds a native handle, so it is finalized whether the query
 * answered or threw. A lost one leaks the handle for the life of the app.
 */
const query = <A>(database: ExpoDatabase, sql: string, use: (statement: ExpoStatement) => A): A => {
  const statement = database.prepareSync(sql);
  try {
    return use(statement);
  } finally {
    statement.finalizeSync();
  }
};

/**
 * Adapts a database to the driver seam.
 *
 * Rows come back by position, from Expo's raw result, which is the shape the
 * store maps onto the selected columns. A `get` that finds nothing answers with
 * no row: the store reads at most one row through `all` and a `limit`, so the
 * shape drizzle wants back from a missing `get` is never asked for.
 */
const expoDriver =
  (database: ExpoDatabase): SqlDriver =>
  (sql, params, method) =>
    Promise.resolve(
      query(database, sql, statement => {
        const bound: SqlValue[] = [...params];
        if (method === 'run') {
          statement.executeSync(bound);
          return { rows: [] };
        }
        const rows = statement.executeForRawResultSync(bound).getAllSync();
        return { rows: method === 'get' ? (rows[0] ?? []) : rows };
      })
    );

/** Opens the store on a database the caller already opened, and still closes. */
const layerExpoStore = (database: SQLiteDatabase): Layer.Layer<SessionStore, StoreError> =>
  layerSqliteStore(expoDriver(database));

export type { ExpoDatabase, ExpoStatement };
export { expoDriver, layerExpoStore };
