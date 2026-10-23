import type { Layer } from 'effect';
import type { SessionStore, StoreError } from '../../core/storage.js';
import type { SqlDriver, SqlValue } from './driver.js';
import { layerSqliteStore } from './sqlite.js';

/**
 * The store on Expo's SQLite, which is how a React Native app reaches one.
 *
 * It names no package. The database arrives already open, exactly as on Node,
 * and what this file needs of one is the asynchronous statement API below — so
 * an Expo database satisfies it structurally, and the plugin depends on nothing.
 *
 * Every call is asynchronous on purpose. React Native runs one JavaScript
 * thread, and a synchronous statement holds it from the first bind to the last
 * row: a session load, or the migration set applied when the store is built,
 * would paint no frame until it finished. The async statement API does the same
 * work on a native thread, so the JavaScript thread is free while it runs.
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
  readonly executeAsync: (params: SqlValue[]) => Promise<unknown>;
  readonly executeForRawResultAsync: (params: SqlValue[]) => Promise<{
    readonly getAllAsync: () => Promise<unknown[][]>;
  }>;
  readonly finalizeAsync: () => Promise<void>;
}

interface ExpoDatabase {
  readonly prepareAsync: (source: string) => Promise<ExpoStatement>;
}

/**
 * Idle statements per SQL text. The store sends a fixed set of SQL, so compiling
 * each one once and running it again is free where preparing it per call is not.
 *
 * The cap is what keeps a burst from living forever: at most `MAX_IDLE`
 * statements wait per SQL text, and an extra one is finalized instead of kept.
 */
const MAX_IDLE = 4;

interface Pool {
  readonly idle: ExpoStatement[];
  /** Set when the store is released: what comes back after that is finalized. */
  closed: boolean;
}

const poolFor = (pools: Map<string, Pool>, sql: string): Pool => {
  const held = pools.get(sql);
  if (held !== undefined) {
    return held;
  }
  const made: Pool = { idle: [], closed: false };
  pools.set(sql, made);
  return made;
};

const take = async (pool: Pool, database: ExpoDatabase, sql: string): Promise<ExpoStatement> =>
  pool.idle.pop() ?? database.prepareAsync(sql);

/**
 * A statement whose cursor state is known goes back for the next caller; one
 * that threw does not, because a run that failed part way leaves the cursor
 * somewhere this adapter cannot see, and a later read of it would answer with
 * rows of the failed run. So it is finalized and the next caller prepares its
 * own.
 *
 * A statement that comes back after the store was released is finalized here
 * too, so no native handle outlives the store.
 */
const put = async (pool: Pool, statement: ExpoStatement, known: boolean): Promise<void> => {
  if (known && !pool.closed && pool.idle.length < MAX_IDLE) {
    pool.idle.push(statement);
    return;
  }
  await statement.finalizeAsync();
};

/** Finalizes what the pools hold and closes them, so nothing outlives the store. */
const release = async (pools: Map<string, Pool>): Promise<void> => {
  const held = [...pools.values()];
  pools.clear();
  for (const pool of held) {
    pool.closed = true;
  }
  const statements = held.flatMap(pool => pool.idle.splice(0));
  await Promise.all(statements.map(statement => statement.finalizeAsync()));
};

/**
 * One connection, one line at a time for writes and any number of readers.
 *
 * A read is two awaits — run the statement, then take the rows — so the
 * JavaScript thread runs other work in between. Without this, another statement
 * on the same connection can run inside that gap, and SQLite does not support
 * writing to a table while a cursor is open on it. A synchronous adapter cannot
 * meet that case by construction; an asynchronous one meets it here.
 *
 * Readers do not wait for each other, which is the point: loading two sessions
 * at once is the launch path. Each one waits at most for one statement of a
 * write, never for a whole transaction, and a queued writer is served before a
 * reader that arrives after it, so neither side starves.
 */
interface Gate {
  readonly share: <A>(work: () => Promise<A>) => Promise<A>;
  readonly alone: <A>(work: () => Promise<A>) => Promise<A>;
}

interface Queue {
  readers: number;
  writing: boolean;
  readonly waiting: { readonly write: boolean; readonly grant: () => void }[];
}

/** Serves what waits, in the order it arrived: a writer alone, readers together. */
const serve = (queue: Queue): void => {
  while (queue.waiting.length > 0) {
    const [head] = queue.waiting;
    /* A writer needs the connection empty; a reader needs no writer in it, and
       stops at one that is queued ahead of it so a stream of reads cannot keep
       a write waiting forever. */
    const blocked =
      head === undefined || (head.write ? queue.writing || queue.readers > 0 : queue.writing);
    if (blocked) {
      return;
    }
    queue.waiting.shift();
    if (head.write) {
      queue.writing = true;
    } else {
      queue.readers += 1;
    }
    head.grant();
  }
};

const gateOf = (): Gate => {
  const queue: Queue = { readers: 0, writing: false, waiting: [] };

  const acquire = (write: boolean): Promise<() => void> => {
    const { promise, resolve } = Promise.withResolvers<() => void>();
    queue.waiting.push({
      write,
      grant: () => {
        resolve(() => {
          if (write) {
            queue.writing = false;
          } else {
            queue.readers -= 1;
          }
          serve(queue);
        });
      },
    });
    serve(queue);
    return promise;
  };

  const through = async <A>(write: boolean, work: () => Promise<A>): Promise<A> => {
    const done = await acquire(write);
    try {
      return await work();
    } finally {
      done();
    }
  };

  return {
    share: work => through(false, work),
    alone: work => through(true, work),
  };
};

/**
 * One gate per database object, not per store: the mobile app builds one store
 * per organization over the one open database, and two stores that each held
 * their own gate would interleave with each other anyway.
 *
 * A `WeakMap` keys it to the database, so the gate goes away with the database
 * and nothing here keeps one alive.
 */
const gates = new WeakMap<ExpoDatabase, Gate>();

const gateOfDatabase = (database: ExpoDatabase): Gate => {
  const held = gates.get(database);
  if (held !== undefined) {
    return held;
  }
  const made = gateOf();
  gates.set(database, made);
  return made;
};

/**
 * Runs one statement and gives back what the seam expects: the rows by
 * position, from Expo's raw result, which is the shape the store maps onto the
 * selected columns. A `get` that finds nothing answers with no row: the store
 * reads at most one row through `all` and a `limit`, so the shape drizzle wants
 * back from a missing `get` is never asked for.
 */
const runOn = async (
  statement: ExpoStatement,
  params: readonly SqlValue[],
  method: string
): Promise<{ rows: unknown[] }> => {
  const bound: SqlValue[] = [...params];
  if (method === 'run') {
    await statement.executeAsync(bound);
    return { rows: [] };
  }
  const result = await statement.executeForRawResultAsync(bound);
  const rows = await result.getAllAsync();
  return { rows: method === 'get' ? (rows[0] ?? []) : rows };
};

/**
 * Adapts a database to the driver seam.
 *
 * A run is a write and takes the connection alone; everything else shares it.
 * The store's own write queue already keeps two writes in one line, and this is
 * the other half: a read never straddles one.
 */
const expoDriver = (database: ExpoDatabase): SqlDriver => {
  const pools = new Map<string, Pool>();
  const gate = gateOfDatabase(database);

  const driver = (sql: string, params: readonly SqlValue[], method: string) =>
    (method === 'run' ? gate.alone : gate.share)(async () => {
      const pool = poolFor(pools, sql);
      const statement = await take(pool, database, sql);
      let known = false;
      try {
        const answer = await runOn(statement, params, method);
        known = true;
        return answer;
      } finally {
        await put(pool, statement, known);
      }
    });

  return Object.assign(driver as SqlDriver, { close: () => release(pools) });
};

/** Opens the store on a database the caller already opened, and still closes. */
const layerExpoStore = (database: ExpoDatabase): Layer.Layer<SessionStore, StoreError> =>
  layerSqliteStore(expoDriver(database));

export type { ExpoDatabase, ExpoStatement };
export { expoDriver, layerExpoStore };
