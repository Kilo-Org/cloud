import { DatabaseSync } from 'node:sqlite';
import { Effect, Layer, Option } from 'effect';
import { expect, it } from 'vitest';
import { SessionStore, type SessionStoreService } from '../../core/storage.js';
import { layerNodeStore } from './node.js';

const database = (): DatabaseSync => new DatabaseSync(':memory:');

const use = <A, E>(
  db: DatabaseSync,
  run: (store: SessionStoreService) => Effect.Effect<A, E>
): Promise<A> => Effect.runPromise(Effect.provide(Effect.flatMap(SessionStore, run), layerNodeStore(db)));

const session = { id: 'ses_1', system: 'sys', model: 'claude-opus-5' };

it('leaves an already migrated database alone when it is opened again', async () => {
  const db = database();
  await use(db, () => Effect.void);
  await use(db, () => Effect.void);

  const versions = db.prepare('PRAGMA user_version').all();
  expect(versions).toEqual([{ user_version: 1 }]);
});

it('reads the turns back in the order they were appended', async () => {
  const db = database();
  const loaded = await use(db, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      for (const [index, role] of (['user', 'assistant', 'user'] as const).entries()) {
        yield* store.append({
          id: `trn_${String(index)}`,
          sessionId: session.id,
          role,
          content: `message ${String(index)}`,
        });
      }
      return yield* store.load(session.id);
    })
  );

  expect(loaded.map(turn => turn.content)).toEqual(['message 0', 'message 1', 'message 2']);
});

it('gives back the options a session was opened with, absent ones included', async () => {
  const db = database();
  const read = await use(db, store =>
    Effect.gen(function* () {
      yield* store.create({ ...session, effort: 'high' });
      return yield* store.read(session.id);
    })
  );

  expect(Option.getOrThrow(read)).toEqual({
    id: 'ses_1',
    system: 'sys',
    model: 'claude-opus-5',
    effort: 'high',
  });
});

it('answers with nothing for a session it has never heard of', async () => {
  const read = await use(database(), store => store.read('ses_missing'));

  expect(Option.isNone(read)).toBe(true);
});

it('refuses a turn whose session was never created', async () => {
  const failed = await use(database(), store =>
    store
      .append({ id: 'trn_1', sessionId: 'ses_missing', role: 'user', content: 'hello' })
      .pipe(Effect.flip)
  );

  expect(failed).toMatchObject({ operation: 'append' });
});

it('refuses a row the schema cannot explain rather than handing it back', async () => {
  const db = database();
  await use(db, store => store.create(session));
  db.prepare('INSERT INTO turns VALUES (?, ?, ?, ?)').run('trn_1', session.id, 'banana', 'hello');

  const failed = await use(db, store => Effect.flip(store.load(session.id)));

  /* The cause is named, so a validator that has silently stopped running
     cannot pass this test by failing for some other reason. */
  expect(failed).toMatchObject({ operation: 'load' });
  expect(String(failed.cause)).toContain('invalid type on $input[0].role');
});

it('keeps two sessions apart', async () => {
  const db = database();
  const loaded = await use(db, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      yield* store.create({ ...session, id: 'ses_2' });
      yield* store.append({ id: 'trn_1', sessionId: 'ses_1', role: 'user', content: 'first' });
      yield* store.append({ id: 'trn_2', sessionId: 'ses_2', role: 'user', content: 'second' });
      return yield* store.load('ses_2');
    })
  );

  expect(loaded.map(turn => turn.content)).toEqual(['second']);
});

/** The layer builds the store once, so a driver that cannot migrate fails there. */
it('fails when the layer is built, not when a question is asked', async () => {
  const db = database();
  db.exec('CREATE TABLE sessions (wrong text)');

  const failed = await Effect.runPromise(
    Effect.flip(Effect.scoped(Layer.build(layerNodeStore(db))))
  );

  expect(failed).toMatchObject({ operation: 'create' });
});
