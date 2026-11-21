/* eslint-disable typescript-eslint/consistent-type-assertions -- a llama.rn context is a JSI object: a test double can only be built by asserting its shape */
import { type ModelEvent, type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Stream } from 'effect';
import { expect, it, vi } from 'vitest';

import { type GgufContext, ggufModelClient } from './gguf-client';
import { type GgufModelFile } from './gguf-records';

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

function clientWith(contexts: readonly GgufContext[], timeline: Timeline) {
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
      fileOf: id => (id === 'b' ? OTHER : FILE),
    }),
  };
}

function collect(stream: Stream.Stream<ModelEvent, unknown>) {
  return Effect.runPromise(Stream.runCollect(stream));
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
