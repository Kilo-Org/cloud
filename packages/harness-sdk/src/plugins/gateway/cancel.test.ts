import { Chunk, type Duration, Effect, Fiber, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { AbortLike, FetchLike } from '../../core/fetch.js';
import { ModelClient } from '../../core/model.js';
import { sampleRequest } from './fake.js';
import { testGateway } from './test-gateway.js';

const frame = 'data: {"delta":{"text":"and"}}\n\n';

const pause = (): Promise<void> => Effect.runPromise(Effect.sleep('5 millis'));

/**
 * A model that never stops talking. It is the case cancellation exists for: a
 * caller who walks away from a long answer must stop the generation, or the
 * provider keeps producing it and keeps charging for it.
 */
const endless = async function* endless(): AsyncIterable<string> {
  yield frame;
  await pause();
  yield* endless();
};

const once = async function* once(): AsyncIterable<string> {
  yield frame;
};

/** Records the signal each call was handed, so a test can read it afterwards. */
const watched = (
  body: () => AsyncIterable<string>
): { readonly fetch: FetchLike; readonly signals: (AbortLike | undefined)[] } => {
  const signals: (AbortLike | undefined)[] = [];
  const fetch: FetchLike = (_url, request) => {
    signals.push(request.signal);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{}'),
      stream: body,
    });
  };
  return { fetch, signals };
};

const interrupted = (fetch: FetchLike, after: Duration.DurationInput): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* ModelClient;
      const reading = yield* Effect.fork(Stream.runDrain(client.stream(sampleRequest(true))));
      yield* Effect.sleep(after);
      yield* Fiber.interrupt(reading);
    }).pipe(Effect.provide(testGateway({ fetch })))
  );

it('stops a stream the caller has walked away from', async () => {
  const { fetch, signals } = watched(endless);

  await interrupted(fetch, '50 millis');

  /* The handle is scoped to the stream, not to the request. A streamed call
     resolves as soon as the headers arrive and produces for a long time after,
     so a handle released when the request resolved would cancel nothing. */
  expect(signals).toHaveLength(1);
  expect(signals[0]?.aborted).toBeTruthy();
});

it('leaves the signal alone while the caller is still reading', async () => {
  const { fetch, signals } = watched(endless);
  const reading = interrupted(fetch, '200 millis');

  await Effect.runPromise(Effect.sleep('40 millis'));
  expect(signals[0]?.aborted).toBeFalsy();

  await reading;
  expect(signals[0]?.aborted).toBeTruthy();
});

it('gives back every event of a stream that ends on its own', async () => {
  const { fetch, signals } = watched(once);

  const events = await Effect.runPromise(
    Effect.flatMap(ModelClient, client =>
      Stream.runCollect(client.stream(sampleRequest(true)))
    ).pipe(Effect.provide(testGateway({ fetch })))
  );

  expect(Chunk.toReadonlyArray(events).map(event => event.kind)).toEqual(['delta', 'done']);
  expect(signals[0]?.aborted).toBeTruthy();
});
