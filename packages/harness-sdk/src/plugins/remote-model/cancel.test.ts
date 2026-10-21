import { Deferred, Effect, Either, Fiber, Schedule, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { AbortLike, FetchLike, HttpResponse } from '../../core/fetch.js';
import { sampleRequest, sse } from '../gateway/fake.js';
import { remoteModelClient, type RemoteModelConfig } from './index.js';

const configFor = (fetch: FetchLike): RemoteModelConfig => ({
  baseUrl: 'https://provider.example/v1',
  apiKind: 'chat_completions',
  fetch,
  headers: () => Effect.succeed({}),
});
const retry = { schedule: Schedule.recurs(0) };
interface AbortEvents extends AbortLike {
  readonly addEventListener: (event: 'abort', listener: () => void) => void;
}
const hasAbortEvents = (signal: AbortLike | undefined): signal is AbortEvents =>
  signal !== undefined &&
  'addEventListener' in signal &&
  typeof signal.addEventListener === 'function';

it('aborts a pending request when a connection-check deadline expires', async () => {
  const observed: { signal: AbortLike | undefined } = { signal: undefined };
  const fetch: FetchLike = (_url, request) => {
    observed.signal = request.signal;
    return Promise.withResolvers<HttpResponse>().promise;
  };
  const result = await Effect.runPromise(
    Stream.runDrain(remoteModelClient(configFor(fetch), retry).stream(sampleRequest())).pipe(
      Effect.timeout('10 millis'),
      Effect.either
    )
  );
  expect(Either.isLeft(result)).toBe(true);
  expect(observed.signal?.aborted).toBe(true);
});

it('owns the abort handle until the consumer stops reading, not only until headers arrive', async () => {
  const observed: { signal: AbortLike | undefined } = { signal: undefined };
  const ready = await Effect.runPromise(Deferred.make<boolean>());
  const stopped = Promise.withResolvers<void>();
  const frames = async function* frames(): AsyncIterable<string> {
    yield sse({ choices: [{ delta: { content: 'first' } }] })[0] ?? '';
    await stopped.promise;
  };
  const fetch: FetchLike = (_url, request) => {
    observed.signal = request.signal;
    if (hasAbortEvents(observed.signal)) {
      observed.signal.addEventListener('abort', () => {
        stopped.resolve();
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
      stream: frames,
    });
  };
  await Effect.runPromise(
    Effect.gen(function* () {
      const reading = yield* Effect.fork(
        remoteModelClient(configFor(fetch), retry)
          .stream(sampleRequest())
          .pipe(Stream.runForEach(() => Deferred.succeed(ready, true)))
      );
      yield* Deferred.await(ready);
      expect(observed.signal?.aborted).toBeFalsy();
      yield* Fiber.interrupt(reading);
      expect(observed.signal?.aborted).toBe(true);
    })
  );
});
