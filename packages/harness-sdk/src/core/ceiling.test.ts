import { Effect, Layer, Stream } from 'effect';
import { expect, it } from 'vitest';
import { layerSeededEntropy } from '../plugins/entropy/seeded.js';
import { fakeModel } from '../plugins/model/fake.js';
import { layerAssembler } from '../plugins/prompt/default.js';
import { openSession } from './run.js';
import { catalogSaying, emptyCatalog, options, run } from './session-fixture.js';

it('raises the token ceiling for one question only', async () => {
  const { calls } = await run([{ deltas: ['x'] }], session =>
    Effect.zipRight(
      Stream.runDrain(session.ask('a', { maxTokens: 4096 })),
      Stream.runDrain(session.ask('b'))
    )
  );
  expect(calls.map(call => call.maxTokens)).toEqual([4096, 1024]);
});

it('takes the ceiling from the model catalog when the caller names none', async () => {
  const model = fakeModel([{ deltas: ['x'] }]);
  await Effect.runPromise(
    Effect.provide(
      Effect.scoped(
        Effect.flatMap(openSession({ system: 'sys', model: 'm' }), session =>
          Stream.runDrain(session.ask('a'))
        )
      ),
      Layer.mergeAll(layerAssembler, catalogSaying(2048), layerSeededEntropy(1), model.layer)
    )
  );
  expect(model.calls[0]?.maxTokens).toBe(2048);
});

it('lets the session and then the question beat the catalog', async () => {
  const model = fakeModel([{ deltas: ['x'] }]);
  await Effect.runPromise(
    Effect.provide(
      Effect.scoped(
        Effect.flatMap(openSession({ ...options, maxTokens: 512 }), session =>
          Effect.zipRight(
            Stream.runDrain(session.ask('a')),
            Stream.runDrain(session.ask('b', { maxTokens: 99 }))
          )
        )
      ),
      Layer.mergeAll(layerAssembler, catalogSaying(2048), layerSeededEntropy(1), model.layer)
    )
  );
  expect(model.calls.map(call => call.maxTokens)).toEqual([512, 99]);
});

it('falls back to 4096 when the catalog cannot name a limit', async () => {
  const model = fakeModel([{ deltas: ['x'] }]);
  await Effect.runPromise(
    Effect.provide(
      Effect.scoped(
        Effect.flatMap(openSession({ system: 'sys', model: 'm' }), session =>
          Stream.runDrain(session.ask('a'))
        )
      ),
      Layer.mergeAll(layerAssembler, emptyCatalog, layerSeededEntropy(1), model.layer)
    )
  );

  /* A catalog that cannot answer must not stop the question. The ceiling is
     the package's floor, not the catalog's opinion. */
  expect(model.calls[0]?.maxTokens).toBe(4096);
});

it('asks anyway when the catalog fails and the caller named a ceiling', async () => {
  const model = fakeModel([{ deltas: ['x'] }]);
  await Effect.runPromise(
    Effect.provide(
      Effect.scoped(
        Effect.flatMap(openSession({ ...options, maxTokens: 77 }), session =>
          Stream.runDrain(session.ask('a'))
        )
      ),
      Layer.mergeAll(layerAssembler, emptyCatalog, layerSeededEntropy(1), model.layer)
    )
  );

  expect(model.calls[0]?.maxTokens).toBe(77);
});
