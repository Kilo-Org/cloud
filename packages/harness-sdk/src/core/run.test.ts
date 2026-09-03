import { Chunk, Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { layerUlid } from '../plugins/id/ulid.js';
import { fakeModel, type FakeReply } from '../plugins/model/fake.js';
import { layerAssembler } from '../plugins/prompt/default.js';
import { ModelError } from './model.js';
import { openSession, type SessionHandle } from './run.js';
import { SessionStore, type StoreError } from './storage.js';
import type { Turn } from './turn.js';
import { hitRatio } from './usage.js';

const options = { system: 'sys', model: 'claude-opus-5', maxTokens: 1024 };

const recordingStore = (): {
  readonly seen: string[];
  readonly layer: Layer.Layer<SessionStore>;
} => {
  const seen: string[] = [];
  const layer = Layer.succeed(SessionStore, {
    append: (turn: Turn) => Effect.sync(() => void seen.push(`${turn.role}:${turn.content}`)),
    load: () => Effect.succeed([] as readonly Turn[]),
    flush: () => Effect.sync(() => void seen.push('flush')),
  });
  return { seen, layer };
};

const run = <A>(
  replies: readonly FakeReply[],
  use: (session: SessionHandle) => Effect.Effect<A, ModelError | StoreError>,
  store?: Layer.Layer<SessionStore>
) => {
  const model = fakeModel(replies);
  const layers = Layer.mergeAll(layerUlid, layerAssembler, model.layer);
  const program = Effect.scoped(Effect.flatMap(openSession(options), use));
  return Effect.runPromise(
    Effect.provide(program, store === undefined ? layers : Layer.merge(layers, store))
  ).then(value => ({ value, calls: model.calls }));
};

const texts = (turns: Chunk.Chunk<Turn>) =>
  Chunk.toReadonlyArray(turns).map(turn => `${turn.role}:${turn.content}`);

it('keeps the question and the answer as two turns, in order', async () => {
  const { value } = await run([{ deltas: ['he', 'llo'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('hi')), session.history)
  );
  expect(texts(value)).toEqual(['user:hi', 'assistant:hello']);
});

it('adds no answer turn when the stream fails part way', async () => {
  const failure = new ModelError({ reason: 'transport', cause: 'cut' });
  const { value } = await run([{ deltas: ['par'], fail: failure }], session =>
    Effect.zipRight(
      Effect.ignore(Stream.runDrain(session.ask('hi'))),
      Effect.map(session.history, texts)
    )
  );
  expect(value).toEqual(['user:hi']);
});

it('asks the second question with the first exchange already in the prompt', async () => {
  const { calls } = await run([{ deltas: ['one'] }, { deltas: ['two'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('a')), Stream.runDrain(session.ask('b')))
  );
  expect(calls[0]?.prompt.messages.map(message => message.text)).toEqual(['a']);
  expect(calls[1]?.prompt.messages.map(message => message.text)).toEqual(['a', 'one', 'b']);
});

it('adds up the token counts of every call', async () => {
  const usage = { inputTokens: 5, cacheReadTokens: 95 };
  const { value } = await run([{ deltas: ['x'], usage }], session =>
    Effect.zipRight(
      Effect.zipRight(Stream.runDrain(session.ask('a')), Stream.runDrain(session.ask('b'))),
      session.usage
    )
  );
  expect(value).toMatchObject({ inputTokens: 10, cacheReadTokens: 190 });
  expect(hitRatio(value)).toBeCloseTo(0.95);
});

it('tells the store about every turn and asks it to flush on close', async () => {
  const store = recordingStore();
  await run([{ deltas: ['hello'] }], session => Stream.runDrain(session.ask('hi')), store.layer);
  expect(store.seen).toEqual(['user:hi', 'assistant:hello', 'flush']);
});

it('runs with no store at all', async () => {
  const { value } = await run([{ deltas: ['hello'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('hi')), Effect.map(session.history, texts))
  );
  expect(value).toEqual(['user:hi', 'assistant:hello']);
});

it('raises the token ceiling for one question only', async () => {
  const { calls } = await run([{ deltas: ['x'] }], session =>
    Effect.zipRight(
      Stream.runDrain(session.ask('a', { maxTokens: 4096 })),
      Stream.runDrain(session.ask('b'))
    )
  );
  expect(calls.map(call => call.maxTokens)).toEqual([4096, 1024]);
});

it('asks with the same effort on every question of a session', async () => {
  const model = fakeModel([{ deltas: ['x'] }]);
  const layers = Layer.mergeAll(layerUlid, layerAssembler, model.layer);
  await Effect.runPromise(
    Effect.provide(
      Effect.scoped(
        Effect.flatMap(openSession({ ...options, effort: 'low' }), session =>
          Effect.zipRight(Stream.runDrain(session.ask('a')), Stream.runDrain(session.ask('b')))
        )
      ),
      layers
    )
  );
  expect(model.calls.map(call => call.effort)).toEqual(['low', 'low']);
});
