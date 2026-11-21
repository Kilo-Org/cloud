/* eslint-disable typescript-eslint/consistent-type-assertions -- a llama.rn context is a JSI object: a test double can only be built by asserting its shape */
import { ModelError, type ModelEvent, type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Stream } from 'effect';
import { expect, it, vi } from 'vitest';

import { type GgufContext, ggufModelClient, RELEASE_WAIT_MS } from './gguf-client';
import { type GgufModelFile } from './gguf-records';
import { LocalModelError } from './local-model-error';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

const FILE: GgufModelFile = {
  path: '/models/a.gguf',
  contextWindow: 2048,
  tools: false,
  projector: undefined,
};

const OTHER: GgufModelFile = { ...FILE, path: '/models/b.gguf' };

const request: ModelRequest = {
  model: 'a',
  maxTokens: 4096,
  tools: [],
  prompt: {
    system: [{ text: 'Be brief.', cache: false }],
    messages: [{ role: 'user', cache: false, parts: [{ kind: 'text', text: 'Hi' }] }],
  },
};

/**
 * What the client did, in order. An open recorded while a release is still
 * running is the defect: two llama.rn contexts would be resident at once.
 */
type Timeline = string[];

/** A context whose native release runs `freeing`, as llama.rn freeing the weights does. */
function contextOf(timeline: Timeline, name: string, freeing: () => Promise<void>) {
  return {
    model: { chatTemplates: { llamaChat: true, jinja: { default: false } } },
    completion: () =>
      Promise.resolve({
        text: 'ok',
        tokens_evaluated: 1,
        tokens_predicted: 1,
        stopped_eos: true,
      }),
    stopCompletion: vi.fn(() => Promise.resolve()),
    release: vi.fn(async () => {
      await freeing();
      timeline.push(`freed ${name}`);
    }),
  } as unknown as GgufContext;
}

/** A context whose native release throws as it is called, like a handle freed twice. */
function throwingContext(): GgufContext {
  const release = vi.fn(() => {
    throw new Error('context already released');
  });
  return {
    model: { chatTemplates: { llamaChat: true, jinja: { default: false } } },
    completion: () =>
      Promise.resolve({
        text: 'ok',
        tokens_evaluated: 1,
        tokens_predicted: 1,
        stopped_eos: true,
      }),
    stopCompletion: vi.fn(() => Promise.resolve()),
    release,
  } as unknown as GgufContext;
}

function clientWith(contexts: readonly GgufContext[], timeline: Timeline, file = FILE) {
  let index = 0;
  const init = vi.fn(() => {
    const context = contexts[index];
    index += 1;
    if (context === undefined) {
      return Promise.reject(new Error('no context left'));
    }
    timeline.push(`open ${String(index)}`);
    return Promise.resolve(context);
  });
  return {
    init,
    ...ggufModelClient({
      runtime: { init, gpu: false },
      fileOf: id => (id === 'b' ? { ...file, path: OTHER.path } : file),
    }),
  };
}

function collect(stream: Stream.Stream<ModelEvent, unknown>) {
  return Effect.runPromise(Stream.runCollect(stream));
}

/** The stream's result, or the failure it ended with, for a refusal under test. */
async function settle(stream: Promise<unknown>): Promise<unknown> {
  try {
    return await stream;
  } catch (error) {
    return error;
  }
}

it('opens no second context while a release the app did not await is still freeing one', async () => {
  const timeline: Timeline = [];
  const gate = Promise.withResolvers<undefined>();
  const first = contextOf(timeline, 'first', () => gate.promise);
  const second = contextOf(timeline, 'second', () => Promise.resolve());
  const { client, release } = clientWith([first, second], timeline);
  await collect(client.stream(request));

  // The background listener starts this release and never awaits it.
  const releasing = release();
  const answered = collect(client.stream(request));
  gate.resolve(undefined);
  await releasing;
  await answered;

  // The second open came after the first context was freed, never beside it.
  expect(timeline).toEqual(['open 1', 'freed first', 'open 2']);
});

it('waits for another model to be freed before it opens this one', async () => {
  const timeline: Timeline = [];
  const gate = Promise.withResolvers<undefined>();
  const first = contextOf(timeline, 'first', () => gate.promise);
  const second = contextOf(timeline, 'second', () => Promise.resolve());
  const { client, release } = clientWith([first, second], timeline);
  await collect(client.stream(request));

  const releasing = release('a');
  const other = collect(client.stream({ ...request, model: 'b' }));
  gate.resolve(undefined);
  await releasing;
  await other;

  expect(timeline).toEqual(['open 1', 'freed first', 'open 2']);
});

it('reuses the context a finished release left, without opening a third', async () => {
  const timeline: Timeline = [];
  const first = contextOf(timeline, 'first', () => Promise.resolve());
  const second = contextOf(timeline, 'second', () => Promise.resolve());
  const { client, release } = clientWith([first, second], timeline);
  await collect(client.stream(request));

  await release();
  await collect(client.stream(request));
  await collect(client.stream(request));

  expect(timeline).toEqual(['open 1', 'freed first', 'open 2']);
});

it('frees a context whose native stop throws as it is called, without wedging the chain', async () => {
  const timeline: Timeline = [];
  const started = Promise.withResolvers<undefined>();
  const stopping = {
    model: { chatTemplates: { llamaChat: true, jinja: { default: false } } },
    // An answer the stop never reaches: its promise never settles, which is what
    // a stop that threw at call time leaves behind.
    completion: () => {
      started.resolve(undefined);
      return new Promise<never>(() => undefined);
    },
    // A handle that was already freed throws where the method is called, so the
    // stop never becomes a promise.
    stopCompletion: vi.fn(() => {
      throw new Error('context already released');
    }),
    release: vi.fn(() => {
      timeline.push('freed stopping');
      return Promise.resolve();
    }),
  } as unknown as GgufContext;
  const second = contextOf(timeline, 'second', () => Promise.resolve());
  const { client, release, init } = clientWith([stopping, second], timeline);
  // The abandoned answer rejects, so it is awaited as a settled result here: a
  // stray rejection after the test passed would hide what it is proving.
  const answered = settle(collect(client.stream(request)));
  await started.promise;

  // The release stops the answer in progress first, and that stop throws. The
  // context must still be freed, and the teardown the next load waits on must
  // settle rather than wait for a completion that never resolves.
  await expect(release()).resolves.toBeUndefined();
  expect(stopping.release).toHaveBeenCalledTimes(1);
  // A second release answers at once: the shared chain settled instead of
  // staying pending behind a completion that never resolves. That chain is what
  // every later load waits on, so a stuck one would wedge the whole client.
  await expect(release()).resolves.toBeUndefined();
  expect(init).toHaveBeenCalledTimes(1);
  expect(timeline).toEqual(['open 1', 'freed stopping']);

  // The abandoned answer ends as a reported failure rather than holding the
  // client: the next request loads its own context instead of being refused as
  // busy, which is what the app would show until a restart.
  expect(await answered).toMatchObject({ reason: 'unsupported' });
  const next = await collect(client.stream(request));
  expect(next.at(-1)?.kind).toBe('done');
  expect(init).toHaveBeenCalledTimes(2);
});

it('does not let an abandoned answer clear the state a newer answer owns', async () => {
  const timeline: Timeline = [];
  const started = Promise.withResolvers<undefined>();
  const settledLater = Promise.withResolvers<{ text: string }>();
  const slow = Promise.withResolvers<{ text: string }>();
  const stopping = {
    model: { chatTemplates: { llamaChat: true, jinja: { default: false } } },
    // The answer the failed stop could not interrupt: it settles only later.
    completion: () => {
      started.resolve(undefined);
      return settledLater.promise;
    },
    stopCompletion: vi.fn(() => {
      throw new Error('context already released');
    }),
    release: vi.fn(() => {
      timeline.push('freed stopping');
      return Promise.resolve();
    }),
  } as unknown as GgufContext;
  // The next answer, still in flight when the abandoned one settles.
  const second = {
    model: { chatTemplates: { llamaChat: true, jinja: { default: false } } },
    completion: () => slow.promise,
    stopCompletion: vi.fn(() => Promise.resolve()),
    release: vi.fn(() => Promise.resolve()),
  } as unknown as GgufContext;
  const { client, release } = clientWith([stopping, second], timeline);
  const abandoned = settle(collect(client.stream(request)));
  await started.promise;
  await release();

  // A newer answer takes the client and is still running.
  const running = settle(collect(client.stream(request)));

  // The abandoned answer settles now. Its exit must not free a client the newer
  // answer owns: a third request must still be refused while that one runs.
  settledLater.resolve({ text: 'late' });
  await abandoned;
  const third: unknown = await settle(collect(client.stream(request)));
  expect(Array.isArray(third)).toBe(false);

  slow.resolve({ text: 'ok' });
  expect(Array.isArray(await running)).toBe(true);
  await collect(client.stream(request));
});

it('keeps loading after a native release throws as it is called', async () => {
  const timeline: Timeline = [];
  const broken = throwingContext();
  const second = contextOf(timeline, 'second', () => Promise.resolve());
  const third = contextOf(timeline, 'third', () => Promise.resolve());
  const { client, release, init } = clientWith([broken, second, third], timeline);
  await collect(client.stream(request));

  // A synchronous throw from the native object must not leave the shared teardown
  // chain rejected: the next answer would then fail as unavailable until restart.
  await expect(release()).resolves.toBeUndefined();
  expect(broken.release).toHaveBeenCalledTimes(1);
  // The answer after the failed teardown still loads and finishes, and the context
  // it replaces is freed through the same chain.
  const answered = await collect(client.stream(request));
  expect(answered.at(-1)?.kind).toBe('done');
  expect(init).toHaveBeenCalledTimes(2);
  expect(timeline).toEqual(['open 1', 'open 2']);
});

it('fails a projector-mismatched context as unsupported when its native release throws', async () => {
  const timeline: Timeline = [];
  // A handle llama.rn already freed throws where `release` is read, so the throw
  // never becomes a promise a `settled` could contain.
  const mismatched = {
    ...contextOf(timeline, 'mismatched', () => Promise.resolve()),
    initMultimodal: vi.fn(() => Promise.resolve(true)),
    // The verdict about the bytes: the projector loaded and reads no images.
    getMultimodalSupport: vi.fn(() => Promise.resolve({ vision: false, audio: false })),
    release: vi.fn(() => {
      throw new Error('context already released');
    }),
  } as unknown as GgufContext;
  const vision: GgufModelFile = { ...FILE, projector: '/models/a.mmproj.gguf' };
  const { client, init } = clientWith([mismatched], timeline, vision);

  const answer: unknown = await settle(collect(client.stream(request)));

  // The answer is the projector refusal the client reports when a context cannot
  // do what the record promised, not the generic stream failure a leaked throw
  // would become: the native failure stays inside the teardown.
  expect(answer).toBeInstanceOf(ModelError);
  expect(answer).toMatchObject({ reason: 'unsupported' });
  const cause: unknown = (answer as ModelError).cause;
  expect(cause).toBeInstanceOf(LocalModelError);
  expect(cause).toMatchObject({ problem: 'unavailable' });
  // The mismatched context was freed once, before the answer gave up on it.
  expect(mismatched.release).toHaveBeenCalledTimes(1);
  expect(init).toHaveBeenCalledTimes(1);
});

it('reports a teardown that never settles instead of waiting on it forever', async () => {
  const timeline: Timeline = [];
  const gate = Promise.withResolvers<undefined>();
  const first = contextOf(timeline, 'first', () => gate.promise);
  const second = contextOf(timeline, 'second', () => Promise.resolve());
  const { client, release, init } = clientWith([first, second], timeline);
  await collect(client.stream(request));

  // A native release that never settles leaves the shared teardown pending.
  const stuck = release();
  vi.useFakeTimers();
  let outcome: unknown = undefined;
  try {
    const refused = settle(collect(client.stream(request)));
    await vi.advanceTimersByTimeAsync(RELEASE_WAIT_MS);
    outcome = await refused;
  } finally {
    vi.useRealTimers();
  }

  // The send fails as unavailable rather than spinning forever, and the stalled
  // teardown still owns the chain: nothing opened a second context beside it.
  expect(Array.isArray(outcome)).toBe(false);
  expect(outcome).toMatchObject({ reason: 'unsupported' });
  expect(init).toHaveBeenCalledTimes(1);
  expect(timeline).toEqual(['open 1']);

  // The stall is remembered: a second send refuses at once instead of paying the
  // whole wait again, and still opens nothing beside the context being freed.
  vi.useFakeTimers();
  try {
    const refusedAgain = settle(collect(client.stream(request)));
    // Draining the microtask queue without moving the clock is all the fast path
    // needs. A send that still awaited the timer would leave this pending, since
    // no timer is advanced here.
    await vi.advanceTimersByTimeAsync(0);
    const again = await Promise.race([refusedAgain, Promise.resolve('still waiting')]);
    expect(again).not.toBe('still waiting');
    expect(Array.isArray(again)).toBe(false);
    expect(again).toMatchObject({ reason: 'unsupported' });
  } finally {
    vi.useRealTimers();
  }
  expect(init).toHaveBeenCalledTimes(1);
  expect(timeline).toEqual(['open 1']);

  // The teardown finally finishes, and the chain it held is intact: the next
  // send opens its context after the freed one and completes.
  gate.resolve(undefined);
  await stuck;
  const next = await collect(client.stream(request));
  expect(next.at(-1)?.kind).toBe('done');
  expect(init).toHaveBeenCalledTimes(2);
  expect(timeline).toEqual(['open 1', 'freed first', 'open 2']);
});
