import type { DatabaseSync } from 'node:sqlite';
import type { Layer } from 'effect';
import type { SessionStore, StoreError } from '../../core/storage.js';
import { layerSqliteStore, type SqlDriver, type SqlValue } from './sqlite.js';

/**
 * The store on Node's own SQLite. This file is one of the two in the package
 * that name a platform, which is why it is a plugin and why nothing else
 * imports it.
 *
 * `node:sqlite` needs Node 24, or Node 22.5 with `--experimental-sqlite`.
 */

/**
 * Rows come back as arrays rather than objects, because that is what the seam
 * is defined in: the reader maps them onto columns by position.
 *
 * SQLite fills the object in the order the columns were selected, so reading
 * the values back off it recovers that order. Two columns of one name would
 * collapse into one key, which no query here can produce: every read selects
 * from a single table and joins nothing.
 */
const rowsOf = (database: DatabaseSync, sql: string, params: readonly SqlValue[]): unknown[][] =>
  database
    .prepare(sql)
    .all(...params)
    .map(Object.values);

/**
 * Adapts a database to the driver seam.
 *
 * A `get` that finds nothing answers with no row. The store reads at most one
 * row, through `all` and a `limit`, so the shape drizzle wants back from a
 * missing `get` is never asked for.
 */
const nodeDriver =
  (database: DatabaseSync): SqlDriver =>
  (sql, params, method) => {
    if (method === 'run') {
      database.prepare(sql).run(...params);
      return Promise.resolve({ rows: [] });
    }
    const rows = rowsOf(database, sql, params);
    return Promise.resolve({ rows: method === 'get' ? (rows[0] ?? []) : rows });
  };

/** Opens the store on a database the caller already opened, and still closes. */
const layerNodeStore = (database: DatabaseSync): Layer.Layer<SessionStore, StoreError> =>
  layerSqliteStore(nodeDriver(database));

export { layerNodeStore, nodeDriver };
