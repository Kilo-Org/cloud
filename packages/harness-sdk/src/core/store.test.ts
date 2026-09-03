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

it('keeps a turn it could not store, so memory and the store disagree', async () => {
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

  /* The session kept the question; the store never took it. On the next load
     the prefix would start at a different turn and miss the cache for good.
     This test states the behavior as it is, so a change to it is deliberate. */
  expect(value).toEqual(['user:hi']);
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
