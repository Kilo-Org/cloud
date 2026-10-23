import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { SessionStore, StoreError, type SessionStoreService } from '../../core/storage.js';
import { expoDriver, type ExpoDatabase, type ExpoStatement } from './expo.js';
import type { SqlValue } from './driver.js';
import { layerSqliteStore } from './sqlite.js';
import { textOf } from '../../core/turn.js';

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
 */
interface StandIn {
  readonly database: ExpoDatabase;
  /** Statements prepared and not finalized. */
  readonly open: () => number;
  /** How many statements were prepared for the SQL texts holding this text. */
  readonly prepared: (holding: string) => number;
  /** Whether a write ran while a read was between its run and its rows. */
  readonly wroteDuringRead: () => boolean;
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
}

/** One prepared statement, with the two rules expo-sqlite holds it to. */
const statementOf = (backing: Backing, source: string): ExpoStatement => {
  const { sqlite, counting, connection } = backing;
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
      return Promise.resolve({
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
      });
    },
    finalizeAsync: () => {
      counting.live.count -= 1;
      return Promise.resolve();
    },
  };
};

const standIn = (): StandIn => {
  const backing: Backing = {
    sqlite: new DatabaseSync(':memory:'),
    counting: { live: { count: 0 }, perText: new Map() },
    connection: { reading: 0, wrote: false },
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
  };
};

const session = { id: 'ses_1', system: 'sys', model: 'claude-opus-5', effort: 'high' } as const;

/**
 * Runs against the store and closes its layer afterwards, so a test can check
 * what a release left behind. `Layer.build` is what gives the release a scope;
 * the layer's finalizer is what finalizes the statements the driver kept.
 */
const use = <A, E>(
  database: ExpoDatabase,
  run: (store: SessionStoreService) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(Layer.build(layerSqliteStore(expoDriver(database))), context =>
        Effect.provide(Effect.flatMap(SessionStore, run), context)
      )
    )
  );

const oneTurn = (id: string, body: string, prompted: number) => ({
  sessionId: id,
  turns: [
    {
      id: `trn_${id}_${body}`,
      sessionId: id,
      role: 'user' as const,
      parts: [{ id: `prt_${id}_${body}`, kind: 'text' as const, body }],
    },
  ],
  prompted,
});

it('carries a session and its turns through the Expo shape', async () => {
  const { database } = standIn();

  const read = await use(database, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      yield* store.append(oneTurn('ses_1', 'hello', 0));
      yield* store.append(oneTurn('ses_1', 'hi', 41));
      return { options: yield* store.read('ses_1'), turns: yield* store.load('ses_1') };
    })
  );

  expect(read.options).toMatchObject({ _tag: 'Some', value: { ...session, prompted: 41 } });
  expect(read.turns.map(textOf)).toEqual(['hello', 'hi']);
});

it('prepares each SQL text once and runs it again for the next load', async () => {
  const { database, prepared } = standIn();
  const counts: number[] = [];

  const loaded = await use(database, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      yield* store.append(oneTurn('ses_1', 'hello', 1));
      const first = yield* store.load('ses_1');
      counts.push(prepared('from "parts"'));
      const second = yield* store.load('ses_1');
      counts.push(prepared('from "parts"'));
      return [first, second] as const;
    })
  );

  expect(loaded[1].map(textOf)).toEqual(loaded[0].map(textOf));
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[1]).toBe(counts[0]);
});

it('runs two reads of one SQL text at once without either losing its rows', async () => {
  const { database, open, prepared } = standIn();

  const result = await use(database, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      yield* store.create({ ...session, id: 'ses_2' });
      yield* store.append(oneTurn('ses_1', 'first', 0));
      yield* store.append(oneTurn('ses_2', 'second', 0));
      /* One load first, so the pool holds a statement for each scan and the
         two concurrent reads have to decide between sharing it and preparing
         another. Sharing one cursor is what the double refuses. */
      yield* store.load('ses_1');
      const warmed = prepared('from "turns"');
      const [one, two] = yield* Effect.all([store.load('ses_1'), store.load('ses_2')], {
        concurrency: 'unbounded',
      });
      return { one, two, warmed, after: prepared('from "turns"') };
    })
  );

  expect(result.one.map(textOf)).toEqual(['first']);
  expect(result.two.map(textOf)).toEqual(['second']);
  expect(result.after).toBeGreaterThan(result.warmed);
  expect(open()).toBe(0);
});

it('keeps a write out of a read that is between its run and its rows', async () => {
  const { database, open, wroteDuringRead } = standIn();
  const driver = expoDriver(database);
  await driver('CREATE TABLE probe (a integer)', [], 'run');
  await driver('INSERT INTO probe VALUES (1)', [], 'run');

  /* Started in this order, a read is between its run and its rows before the
     write reaches the database, which is the window the gate exists for. */
  const [read] = await Promise.all([
    driver('SELECT a FROM probe', [], 'all'),
    driver('INSERT INTO probe VALUES (2)', [], 'run'),
  ]);

  expect(read.rows).toEqual([[1]]);
  expect(wroteDuringRead()).toBeFalsy();
  await driver.close?.();
  expect(open()).toBe(0);
});

it('drops a statement that threw, and prepares another for the next call', async () => {
  const { database, prepared, open } = standIn();

  const failed = await use(database, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      const first = yield* Effect.flip(store.append(oneTurn('ses_missing', 'lost', 0)));
      const second = yield* Effect.flip(store.append(oneTurn('ses_missing', 'lost again', 0)));
      const after = prepared('insert into "turns"');
      yield* store.append(oneTurn('ses_1', 'kept', 0));
      return { first, second, after, reread: yield* store.load('ses_1') };
    })
  );

  expect(failed.first).toBeInstanceOf(StoreError);
  expect(failed.first).toMatchObject({ operation: 'append' });
  expect(failed.second).toMatchObject({ operation: 'append' });
  /* Each failure finalized its statement rather than pooling one whose cursor
     state is unknown, so the retry prepared its own. */
  expect(failed.after).toBe(2);
  expect(failed.reread.map(textOf)).toEqual(['kept']);
  expect(open()).toBe(0);
});

it('finalizes what a call prepares after the store was released', async () => {
  const { database, open } = standIn();
  const driver = expoDriver(database);
  await driver('CREATE TABLE probe (a integer)', [], 'run');
  await driver.close?.();

  /* The store is gone, so nothing this call prepares may be kept: it runs, and
     the handle goes with it. */
  await driver('INSERT INTO probe VALUES (1)', [], 'run');
  const read = await driver('SELECT a FROM probe', [], 'all');

  expect(read.rows).toEqual([[1]]);
  expect(open()).toBe(0);
});

it('finalizes what it prepared for a build that failed', async () => {
  const { database, open } = standIn();
  let prepared = 0;
  const refusing: ExpoDatabase = {
    prepareAsync: (source: string) => {
      prepared += 1;
      /* The migration set is a series of statements; the one after this fails
         the way a database that cannot migrate does. */
      return prepared > 3
        ? Promise.reject(new Error('the database refused the statement'))
        : database.prepareAsync(source);
    },
  };

  await expect(use(refusing, store => Effect.asVoid(store.read('ses_1')))).rejects.toBeDefined();

  expect(prepared).toBeGreaterThan(3);
  expect(open()).toBe(0);
});

it('answers no session for an id it never stored', async () => {
  const { database, open } = standIn();
  const found = await use(database, store => store.read('ses_missing'));
  expect(found).toMatchObject({ _tag: 'None' });
  expect(open()).toBe(0);
});
