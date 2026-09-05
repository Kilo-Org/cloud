import { Chunk, Effect, Fiber, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { layerSeededEntropy } from '../plugins/entropy/seeded.js';
import { fakeModel } from '../plugins/model/fake.js';
import { layerAssembler } from '../plugins/prompt/default.js';
import { ModelError } from './model.js';
import { textIn } from './prompt.js';
import { openSession } from './run.js';
import { catalogWindowed, options, run, runWith, silentCatalog, texts } from './session-fixture.js';
import { hitRatio } from './usage.js';

it('keeps the question and the answer as two turns, in order', async () => {
  const { value } = await run([{ deltas: ['he', 'llo'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('hi')), session.history)
  );
  expect(texts(value)).toEqual(['user:hi', 'assistant:hello']);
});

it('takes the question back out when the stream fails part way', async () => {
  const failure = new ModelError({ reason: 'transport', cause: 'cut' });
  const { value } = await run([{ deltas: ['par'], fail: failure }], session =>
    Effect.zipRight(
      Effect.ignore(Stream.runDrain(session.ask('hi'))),
      Effect.map(session.history, texts)
    )
  );

  /* A transcript that ends on an unanswered question sends it again with
     every later request, and the model may answer it late. */
  expect(value).toEqual([]);
});

it('takes the question back out when the caller walks away mid-stream', async () => {
  const { value } = await run([{ deltas: ['par'], stall: true }, { deltas: ['ok'] }], session =>
    Effect.gen(function* () {
      const reading = yield* Effect.fork(Stream.runDrain(session.ask('a')));
      yield* Effect.sleep('10 millis');
      yield* Fiber.interrupt(reading);
      /* The session must still take a question: a `busy` flag left set by the
         interrupt would strand it, and the abandoned question would ride along
         on every later request. */
      yield* Stream.runDrain(session.ask('b'));
      return yield* Effect.map(session.history, texts);
    })
  );
  expect(value).toEqual(['user:b', 'assistant:ok']);
});

/** A window small enough that the call below fills it, and a call that does. */
const window = 1000;
const full = { deltas: ['answered'], usage: { inputTokens: 900, cacheReadTokens: 0 } };

it('takes the next question after a caller walks away mid-compaction', async () => {
  /* The session is held before the summariser is called, and the stream that
     releases it does not exist yet. An interrupt in that window must still
     free the session, or every later question is refused as busy. */
  const { value } = await runWith({
    replies: [
      full,
      { deltas: ['the notes'], stall: true },
      { deltas: ['the notes'] },
      { deltas: ['ok'] },
    ],
    catalog: catalogWindowed(window),
    use: session =>
      Effect.gen(function* () {
        yield* Stream.runDrain(session.ask('one'));
        const reading = yield* Effect.fork(Stream.runDrain(session.ask('two')));
        yield* Effect.sleep('10 millis');
        yield* Fiber.interrupt(reading);
        yield* Stream.runDrain(session.ask('three'));
        return yield* Effect.map(session.history, texts);
      }),
  });

  /* The abandoned summary wrote nothing, so the window is still full and the
     next question summarises before it is asked. What it must not do is fail. */
  expect(value).toEqual(['user:one', 'assistant:answered', 'user:', 'user:three', 'assistant:ok']);
});

it('asks the second question with the first exchange already in the prompt', async () => {
  const { calls } = await run([{ deltas: ['one'] }, { deltas: ['two'] }], session =>
    Effect.zipRight(Stream.runDrain(session.ask('a')), Stream.runDrain(session.ask('b')))
  );
  expect(calls[0]?.prompt.messages.map(textIn)).toEqual(['a']);
  expect(calls[1]?.prompt.messages.map(textIn)).toEqual(['a', 'one', 'b']);
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

it('asks with the same effort on every question of a session', async () => {
  const model = fakeModel([{ deltas: ['x'] }]);
  const layers = Layer.mergeAll(layerAssembler, silentCatalog, layerSeededEntropy(1), model.layer);
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

it('refuses a second question asked while the first is still streaming', async () => {
  const { value } = await run([{ deltas: ['one'] }, { deltas: ['two'] }], session =>
    Stream.runCollect(
      Stream.merge(
        Stream.map(session.ask('a'), () => 'a'),
        Stream.catchTag(
          Stream.map(session.ask('b'), () => 'b'),
          'harness/SessionBusyError',
          () => Stream.succeed('refused')
        )
      )
    ).pipe(Effect.map(chunk => [...new Set(Chunk.toReadonlyArray(chunk))].toSorted()))
  );

  expect(value).toEqual(['a', 'refused']);
});

it('takes the next question once the first stream has ended', async () => {
  const { value } = await run([{ deltas: ['one'] }, { deltas: ['two'] }], session =>
    Effect.zipRight(
      Effect.zipRight(Stream.runDrain(session.ask('a')), Stream.runDrain(session.ask('b'))),
      Effect.map(session.history, texts)
    )
  );

  expect(value).toEqual(['user:a', 'assistant:one', 'user:b', 'assistant:two']);
});

it('takes the next question after one fails part way', async () => {
  const failure = new ModelError({ reason: 'transport', cause: 'cut' });
  const { value } = await run([{ deltas: ['par'], fail: failure }, { deltas: ['ok'] }], session =>
    Effect.zipRight(
      Effect.zipRight(
        Effect.ignore(Stream.runDrain(session.ask('a'))),
        Stream.runDrain(session.ask('b'))
      ),
      Effect.map(session.history, texts)
    )
  );

  /* The failed question is gone, so the transcript still alternates. */
  expect(value).toEqual(['user:b', 'assistant:ok']);
});
