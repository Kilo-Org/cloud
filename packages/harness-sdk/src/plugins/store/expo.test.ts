import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { SessionStore, type SessionStoreService } from '../../core/storage.js';
import { expoDriver, type ExpoDatabase } from './expo.js';
import { layerSqliteStore, type SqlValue } from './sqlite.js';

/**
 * Expo's SQLite is a native module, so it cannot run here. What can run is the
 * adapter: a database of the same shape, backed by Node's SQLite, proves that
 * the raw rows land in the right columns and that every statement is finalized.
 *
 * The shapes cannot drift apart unnoticed. `layerExpoStore` takes Expo's own
 * `SQLiteDatabase`, so the compiler checks a real database against the same
 * interface this double implements.
 */
const standIn = (): { readonly database: ExpoDatabase; readonly open: () => number } => {
  const sqlite = new DatabaseSync(':memory:');
  const live = { count: 0 };
  const database: ExpoDatabase = {
    prepareSync: (source: string) => {
      const statement = sqlite.prepare(source);
      live.count += 1;
      return {
        executeSync: (params: SqlValue[]) => statement.run(...params),
        executeForRawResultSync: (params: SqlValue[]) => ({
          /* Expo answers a raw query by position, so the double does too. */
          getAllSync: () => statement.all(...params).map(Object.values),
        }),
        finalizeSync: () => {
          live.count -= 1;
        },
      };
    },
  };
  return { database, open: () => live.count };
};

const session = { id: 'ses_1', system: 'sys', model: 'claude-opus-5', effort: 'high' } as const;

const use = <A, E>(
  database: ExpoDatabase,
  run: (store: SessionStoreService) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(Effect.flatMap(SessionStore, run), layerSqliteStore(expoDriver(database)))
  );

it('carries a session and its turns through the Expo shape', async () => {
  const { database } = standIn();

  const read = await use(database, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      yield* store.append({ id: 'trn_1', sessionId: 'ses_1', role: 'user', content: 'hello' });
      yield* store.append({ id: 'trn_2', sessionId: 'ses_1', role: 'assistant', content: 'hi' });
      return { options: yield* store.read('ses_1'), turns: yield* store.load('ses_1') };
    })
  );

  expect(read.options).toMatchObject({ _tag: 'Some', value: session });
  expect(read.turns.map(turn => turn.content)).toEqual(['hello', 'hi']);
});

it('finalizes every statement it prepares, including the one that failed', async () => {
  const { database, open } = standIn();

  const failed = await use(database, store =>
    Effect.flip(
      store.append({ id: 'trn_1', sessionId: 'ses_missing', role: 'user', content: 'hello' })
    )
  );

  expect(failed).toMatchObject({ operation: 'append' });
  expect(open()).toBe(0);
});
