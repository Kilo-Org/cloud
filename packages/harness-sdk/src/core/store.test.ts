import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { brokenStore, recordingStore, run, texts } from './session-fixture.js';

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

it('keeps memory and the store agreeing when the store refuses the write', async () => {
  const store = brokenStore('append');
  const { value } = await run(
    [{ deltas: ['x'] }],
    session =>
      Effect.zipRight(
        Effect.ignore(Stream.runDrain(session.ask('hi'))),
        Effect.map(session.history, texts)
      ),
    store.layer
  );

  /* Neither holds the exchange. A session that kept a turn the store refused
     would load back from a different turn and miss the cache for good. */
  expect(value).toEqual([]);
  expect(store.seen).toEqual(['flush']);
});

it('reports the store failure to the caller rather than swallowing it', async () => {
  const store = brokenStore('append');
  const failure = await run(
    [{ deltas: ['x'] }],
    session => Effect.either(Stream.runDrain(session.ask('hi'))),
    store.layer
  );

  expect(failure.value).toMatchObject({
    _tag: 'Left',
    left: { _tag: 'harness/StoreError', operation: 'append' },
  });
});

it('closes the session even when the final flush fails', async () => {
  const store = brokenStore('flush');
  const { value } = await run(
    [{ deltas: ['x'] }],
    session => Effect.zipRight(Stream.runDrain(session.ask('hi')), Effect.succeed('closed')),
    store.layer
  );

  /* `run.ts` ignores a failing flush on purpose: a close that throws would
     hide the answer the caller already has. The cost is that whatever the
     store still buffered is lost silently, which is the plugin's risk to
     manage. Pinned here so that trade is a decision, not an accident. */
  expect(value).toBe('closed');
  expect(store.seen).toEqual(['user:hi', 'assistant:x']);
});
