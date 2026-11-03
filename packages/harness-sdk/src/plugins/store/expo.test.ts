import { setTimeout as delay } from 'node:timers/promises';
import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { SessionStore, StoreError, type SessionStoreService } from '../../core/storage.js';
import { expoDriver, type ExpoDatabase } from './expo.js';
import { layerSqliteStore } from './sqlite.js';
import { probeTable, standIn } from './expo-fixture.js';
import { textOf } from '../../core/turn.js';

/** The double in `expo-fixture.ts` keeps the two rules expo-sqlite keeps. */

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
  const { database, parkReads, wroteDuringRead } = standIn({ probe: true });
  const driver = expoDriver(database);

  /* The read is held exactly where the adapter yields: its statement has run
     and its rows are not taken yet, which is the window a write would land in
     without the connection gate. */
  const parked = parkReads();
  const read = driver('SELECT a FROM probe', [], 'all');
  await parked.reached;
  const write = driver('INSERT INTO probe VALUES (2)', [], 'run');
  await delay(0);
  parked.release();
  const [rows] = await Promise.all([read, write]);

  expect({ rows: rows.rows, wrote: wroteDuringRead() }).toEqual({ rows: [[1]], wrote: false });
});

it('keeps at most four idle statements for one SQL text', async () => {
  const { database, open, prepared } = standIn();
  const driver = expoDriver(database);
  await probeTable(driver);
  const opened = open();
  const reads = prepared('SELECT a FROM probe');

  /* Six reads of one text in flight at once find no idle statement, so each of
     them prepares one; the two that come back past the cap are finalized. */
  await Promise.all(Array.from({ length: 6 }, () => driver('SELECT a FROM probe', [], 'all')));

  expect(prepared('SELECT a FROM probe') - reads).toBe(6);
  expect(open() - opened).toBe(4);
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
