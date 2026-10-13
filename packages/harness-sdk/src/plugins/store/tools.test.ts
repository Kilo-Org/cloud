import { DatabaseSync } from 'node:sqlite';
import { Effect, Option } from 'effect';
import { expect, it } from 'vitest';
import { SessionStore, type SessionStoreService } from '../../core/storage.js';
import { layerNodeStore } from './node.js';

/**
 * What the store does with the two halves of a tool call.
 *
 * They are the one pair it must never split. Every shape refuses a call whose
 * result is missing, so a session whose store lost one half can never be
 * continued at all, and the only symptom is the next question failing.
 */

const database = (): DatabaseSync => new DatabaseSync(':memory:');

const use = <A, E>(
  db: DatabaseSync,
  run: (store: SessionStoreService) => Effect.Effect<A, E>
): Promise<A> =>
  Effect.runPromise(Effect.provide(Effect.flatMap(SessionStore, run), layerNodeStore(db)));

const session = { id: 'ses_1', system: 'sys', model: 'claude-opus-5' };

const call = {
  id: 'prt_1',
  kind: 'toolCall',
  body: '{"city":"Oslo"}',
  callId: 'tc_1',
  name: 'weather',
} as const;

const answered = {
  id: 'prt_2',
  kind: 'toolResult',
  body: 'it rains',
  callId: 'tc_1',
  failed: false,
} as const;

const refused = {
  id: 'prt_3',
  kind: 'toolResult',
  body: 'no such city',
  callId: 'tc_2',
  failed: true,
} as const;

it('writes a call and its result, and reads both back whole', async () => {
  const db = database();
  const loaded = await use(db, store =>
    Effect.gen(function* () {
      yield* store.create({ ...session, tools: ['weather', 'question'] });
      yield* store.append({
        sessionId: session.id,
        turns: [
          { id: 'trn_1', sessionId: session.id, role: 'assistant', parts: [call] },
          { id: 'trn_2', sessionId: session.id, role: 'user', parts: [answered, refused] },
        ],
        prompted: 12,
      });
      return { turns: yield* store.load(session.id), stored: yield* store.read(session.id) };
    })
  );

  expect(loaded.turns[0]?.parts).toEqual([call]);
  /* Whether a result failed is what tells the model to try something else, so
     it is a column and not something inferred from the text. */
  expect(loaded.turns[1]?.parts).toEqual([answered, refused]);
  /* The order of the tools is part of the prefix, so it comes back as written. */
  expect(Option.getOrThrow(loaded.stored).tools).toEqual(['weather', 'question']);
});

it('gives back no tools for a session that named none', async () => {
  const read = await use(database(), store =>
    Effect.zipRight(store.create(session), store.read(session.id))
  );

  expect(Option.getOrThrow(read).tools).toBeUndefined();
});

it('refuses a call that names no call rather than handing it back', async () => {
  const db = database();
  const failed = await use(db, store =>
    Effect.gen(function* () {
      yield* store.create(session);
      yield* store.append({
        sessionId: session.id,
        turns: [{ id: 'trn_1', sessionId: session.id, role: 'assistant', parts: [] }],
        prompted: 0,
      });
      db.prepare(
        'INSERT INTO parts (id, turn_id, session_id, kind, body) VALUES (?, ?, ?, ?, ?)'
      ).run('prt_1', 'trn_1', session.id, 'toolCall', '{}');
      return yield* Effect.flip(store.load(session.id));
    })
  );

  expect(failed).toMatchObject({ operation: 'load' });
  expect(String(failed.cause)).toContain('names no call');
});
