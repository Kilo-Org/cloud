import { DatabaseSync } from 'node:sqlite';
import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { layerNodeStore } from '../plugins/store/node.js';
import { assemble } from '../plugins/prompt/default.js';
import { seededEntropy } from '../plugins/entropy/seeded.js';
import { SessionStore, type SessionStoreService } from './storage.js';
import { makeTurn, textOf, type PartDraft } from './turn.js';

/** A one-pixel PNG, small enough to read and real enough to be an image. */
const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const entropy = seededEntropy(7);
const session = { id: 'ses_1', system: 'sys', model: 'claude-opus-5' };

const stored = <A, E>(run: (store: SessionStoreService) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.provide(Effect.flatMap(SessionStore, run), layerNodeStore(new DatabaseSync(':memory:')))
  );

const question: readonly PartDraft[] = [
  { kind: 'text', body: 'what is in this picture' },
  { kind: 'image', body: pixel, media: 'image/png' },
];

it('carries an image and its media type through the store, in place', async () => {
  const loaded = await stored(store =>
    Effect.gen(function* () {
      yield* store.create(session);
      const turn = yield* makeTurn(entropy, {
        sessionId: session.id,
        role: 'user',
        parts: question,
      });
      yield* store.append({ sessionId: session.id, turns: [turn], prompted: 0 });
      return yield* store.load(session.id);
    })
  );

  /* The order inside a turn is the order the model reads. An image that came
     back before its question would change what was asked. */
  expect(loaded[0]?.parts).toMatchObject([
    { kind: 'text', body: 'what is in this picture' },
    { kind: 'image', body: pixel, media: 'image/png' },
  ]);
});

it('gives every part its own identifier', async () => {
  const turn = Effect.runSync(
    makeTurn(entropy, { sessionId: session.id, role: 'user', parts: question })
  );

  const ids = turn.parts.map(part => part.id);
  expect(new Set(ids).size).toBe(2);
  expect(ids.every(id => id.startsWith('prt_'))).toBe(true);
});

it('reads the text of a turn that also holds an image', () => {
  const turn = Effect.runSync(
    makeTurn(entropy, { sessionId: session.id, role: 'user', parts: question })
  );

  expect(textOf(turn)).toBe('what is in this picture');
});

it('refuses to load an image row that names no media type', async () => {
  const database = new DatabaseSync(':memory:');
  const failed = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(SessionStore, store =>
        Effect.gen(function* () {
          yield* store.create(session);
          yield* store.append({
            sessionId: session.id,
            turns: [{ id: 'trn_1', sessionId: session.id, role: 'user', parts: [] }],
            prompted: 0,
          });
          database
            .prepare('INSERT INTO parts VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run('prt_1', 'trn_1', session.id, 'image', pixel, null, null);
          return yield* Effect.flip(store.load(session.id));
        })
      ),
      layerNodeStore(database)
    )
  );

  expect(failed).toMatchObject({ operation: 'load' });
  expect(String(failed.cause)).toContain('names no media type');
});

it('puts every part of the turn in the prompt, in the order it arrived', () => {
  const turn = Effect.runSync(
    makeTurn(entropy, {
      sessionId: session.id,
      role: 'assistant',
      parts: [
        { kind: 'reasoning', body: 'thinking about it', signature: 'sig' },
        { kind: 'text', body: 'a picture' },
        { kind: 'image', body: pixel, media: 'image/png' },
      ],
    })
  );

  const prompt = assemble({ system: 'sys', turns: [turn] });

  /* The reasoning goes back with the rest. The provider drops what the model
     cannot read and does not bill for it, and a block removed by hand can fail
     the request on its ordering or on its signature. */
  expect(prompt.messages[0]?.parts).toEqual([
    { kind: 'reasoning', text: 'thinking about it', signature: 'sig' },
    { kind: 'text', text: 'a picture' },
    { kind: 'image', media: 'image/png', data: pixel },
  ]);
});
