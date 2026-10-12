import type { Layer } from 'effect';
import type { SessionStore, StoreError } from '../../core/storage.js';
import type { SqlDriver, SqlValue } from './driver.js';
import { layerSqliteStore } from './sqlite.js';

/**
 * The store on Expo's SQLite, which is how a React Native app reaches one.
 *
 * It names no package. The database arrives already open, exactly as on Node,
 * and what this file needs of one is the two methods below — so an Expo
 * database satisfies it structurally, and the plugin depends on nothing.
 */

/**
 * The part of an Expo database this adapter uses, and the whole of what
 * `layerExpoStore` asks for.
 *
 * Naming `SQLiteDatabase` here instead would buy nothing and cost a dependency:
 * the caller passes their own database, so their compiler checks the real type
 * against this one at the call. It also lets a test supply one without a native
 * module, which is how `expo.test.ts` runs at all.
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
const layerExpoStore = (database: ExpoDatabase): Layer.Layer<SessionStore, StoreError> =>
  layerSqliteStore(expoDriver(database));

export type { ExpoDatabase };
export { expoDriver, layerExpoStore };
