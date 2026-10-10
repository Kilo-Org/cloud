import { type FetchLike, type ModelClientService, type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Either, Schedule, Stream } from 'effect';
import { beforeEach, expect, it, vi } from 'vitest';

import { rememberKiloImageModels, targetSupportsTools } from './backend-capabilities';
import { IMAGE_OMITTED, routedModelClient, targetModelFacts } from './backend-routing';
import { type StoredChatBackend } from './backend-store';
import { backendFailureKey, backendTargetId } from './backend-target';
import { type NativeAvailability, type NativeModelEvent } from './native-model-client';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('./backend-store', () => ({ listChatBackends: () => [] }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));

const apple = vi.hoisted(() => {
  const listeners = new Set<(event: NativeModelEvent) => void>();
  const available: NativeAvailability = {
    status: 'available',
    modelId: 'apple-system-language-model',
    contextWindow: 4096,
    maxOutputTokens: 4096,
    systemInstructions: true,
    tokenCounting: true,
    tools: true,
  };
  return {
    available,
    availability: vi.fn<() => Promise<NativeAvailability>>(),
    generate: vi.fn(async (request: { id: string }) => {
      await Promise.resolve();
      for (const listener of listeners) {
        listener({ id: request.id, kind: 'delta', text: 'On device' });
        listener({
          id: request.id,
          kind: 'done',
          stop: 'end',
          usageSource: 'counted',
          inputTokens: 9,
          outputTokens: 2,
        });
      }
    }),
    cancel: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    resume: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    countTokens: vi.fn<() => Promise<number>>().mockResolvedValue(9),
    addListener: (_name: string, listener: (event: NativeModelEvent) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
  };
});

vi.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => (name === 'KiloAppleModel' ? apple : null),
}));

vi.mock('./gguf-models', () => ({
  ggufModelProvider: {
    availability: apple.availability,
    client: { stream: () => undefined },
    facts: () => ({ apiKinds: [] }),
    supportsTools: () => false,
    supportsImages: () => false,
  },
}));

beforeEach(() => {
  apple.availability.mockReset().mockResolvedValue(apple.available);
  apple.generate.mockClear();
});

function localRouter() {
  const kilo = vi.fn<ModelClientService['stream']>(() => Stream.empty);
  const fetch = vi.fn<FetchLike>();
  const client = routedModelClient({
    kilo: { stream: kilo },
    retry: { schedule: Schedule.recurs(0) },
    profiles: () => [],
    fetch,
    headers: () => ({}),
    validateTransport: () => undefined,
  });
  return { client, kilo, fetch };
}

const question = (model: string): ModelRequest => ({
  model,
  maxTokens: 512,
  tools: [
    {
      name: 'time',
      description: 'Current time',
      parameters: { type: 'object', properties: {} },
    },
  ],
  prompt: {
    system: [{ text: 'System', cache: false }],
    messages: [{ role: 'user', cache: false, parts: [{ kind: 'text', text: 'Question' }] }],
  },
});

it('routes an on-device target to its native model without Kilo, with the tools it runs', async () => {
  const { client, kilo, fetch } = localRouter();
  expect(targetSupportsTools('local:apple')).toBe(false);
  const events = await Effect.runPromise(Stream.runCollect(client.stream(question('local:apple'))));
  expect([...events]).toMatchObject([
    { kind: 'delta', text: 'On device' },
    { kind: 'done', stop: 'end', usage: { inputTokens: 9, outputTokens: 2 } },
  ]);
  expect(kilo).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(apple.generate).toHaveBeenCalledOnce();
  expect(apple.generate.mock.calls[0]?.[0]).toMatchObject({
    tools: [{ name: 'time', description: 'Current time' }],
  });
  // The module said it runs the tool loop, so new chats on it are opened with tools.
  expect(targetSupportsTools('local:apple')).toBe(true);
  expect(targetSupportsTools('kilo/default')).toBe(true);
  // The availability read at send time supplies the window that drives compaction.
  expect(targetModelFacts('local:apple', [], { apiKinds: ['messages'] })).toEqual({
    apiKinds: [],
    contextWindow: 4096,
    maxOutputTokens: 4096,
  });
});

it.each([
  ['Apple Intelligence is off', 'local:apple'],
  ['the provider is not in this build', 'local:android'],
])('fails explicitly without calling Kilo when %s', async (_label, model) => {
  apple.availability.mockResolvedValue({
    ...apple.available,
    status: 'unavailable',
    reason: 'apple_intelligence_disabled',
  });
  const { client, kilo, fetch } = localRouter();
  const result = await Effect.runPromise(
    Effect.either(Stream.runCollect(client.stream(question(model))))
  );
  expect(Either.isLeft(result) && backendFailureKey(result.left)).toBe(
    'modelChat.localModels.unavailable'
  );
  expect(apple.generate).not.toHaveBeenCalled();
  expect(kilo).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

async function* responseStream() {
  await Promise.resolve();
  yield 'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\n';
}

async function responseText(): Promise<string> {
  await Promise.resolve();
  return '';
}

it.each(['max_completion_tokens', 'max_tokens'] as const)(
  'routes the configured %s field into an actual upstream request',
  async completionTokenField => {
    const backend: StoredChatBackend = {
      id: 'server',
      revision: 1,
      name: 'Custom',
      baseUrl: 'https://provider.example/v1',
      apiKind: 'chat_completions',
      completionTokenField,
      apiKey: 'custom-key',
      headers: {},
      models: [{ id: 'upstream', name: 'Upstream', tools: false, images: false }],
      allowLocalHttp: false,
    };
    const fetch = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      text: responseText,
      stream: responseStream,
    });
    const kiloStream = vi.fn<ModelClientService['stream']>(() => Stream.empty);
    const client = routedModelClient({
      kilo: { stream: kiloStream },
      retry: { schedule: Schedule.recurs(0) },
      profiles: () => [backend],
      fetch,
      headers: profile => ({ authorization: `Bearer ${profile.apiKey}` }),
      validateTransport: () => undefined,
    });
    const events = await Effect.runPromise(
      Stream.runCollect(
        client.stream({
          model: backendTargetId(backend, 'upstream'),
          maxTokens: 321,
          prompt: {
            system: [],
            messages: [{ role: 'user', cache: false, parts: [{ kind: 'text', text: 'Question' }] }],
          },
        })
      )
    );
    expect([...events]).toMatchObject([
      { kind: 'delta', text: 'Answer' },
      { kind: 'done', stop: 'end' },
    ]);
    expect(kiloStream).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe('https://provider.example/v1/chat/completions');
    expect(call?.[1].headers).toMatchObject({ authorization: 'Bearer custom-key' });
    const body: unknown = JSON.parse(call?.[1].body ?? '{}');
    expect(body).toMatchObject({
      model: 'upstream',
      messages: [{ role: 'user', content: 'Question' }],
    });
    expect(body).toHaveProperty(completionTokenField, 321);
    expect(body).not.toHaveProperty(
      completionTokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
    );
  }
);

/** A conversation that read an image on an earlier model, then asks again. */
const afterImage = (model: string): ModelRequest => ({
  model,
  maxTokens: 64,
  prompt: {
    system: [],
    messages: [
      {
        role: 'user',
        cache: false,
        parts: [
          { kind: 'image', media: 'image/jpeg', data: 'AAAA' },
          { kind: 'text', text: 'What is this?' },
        ],
      },
      { role: 'assistant', cache: false, parts: [{ kind: 'text', text: 'A cat.' }] },
      { role: 'user', cache: false, parts: [{ kind: 'text', text: 'And now?' }] },
    ],
  },
});

it('sends the image to a Kilo model the catalog lists as reading images', async () => {
  rememberKiloImageModels([{ id: 'vendor/vision', supportsImages: true }]);
  const { client, kilo } = localRouter();
  await Effect.runPromise(Stream.runCollect(client.stream(afterImage('vendor/vision'))));
  expect(kilo.mock.calls[0]?.[0]).toEqual(afterImage('vendor/vision'));
});

it('tells a text-only Kilo model an image was there instead of sending it', async () => {
  rememberKiloImageModels([{ id: 'vendor/vision', supportsImages: true }]);
  const { client, kilo } = localRouter();
  await Effect.runPromise(Stream.runCollect(client.stream(afterImage('vendor/text'))));
  const sent = kilo.mock.calls[0]?.[0];
  expect(sent?.prompt.messages[0]?.parts).toEqual([
    { kind: 'text', text: IMAGE_OMITTED },
    { kind: 'text', text: 'What is this?' },
  ]);
  expect(sent?.prompt.messages.slice(1)).toEqual(
    afterImage('vendor/text').prompt.messages.slice(1)
  );
});

it.each([
  [false, 'What is this?'],
  [true, 'data:image/jpeg;base64,AAAA'],
])('sends a custom model with images=%s what it can read', async (images, expected) => {
  const backend: StoredChatBackend = {
    id: 'server',
    revision: 1,
    name: 'Custom',
    baseUrl: 'https://provider.example/v1',
    apiKind: 'chat_completions',
    apiKey: '',
    headers: {},
    models: [{ id: 'upstream', name: 'Upstream', tools: false, images }],
    allowLocalHttp: false,
  };
  const fetch = vi.fn<FetchLike>().mockResolvedValue({
    ok: true,
    status: 200,
    text: responseText,
    stream: responseStream,
  });
  const client = routedModelClient({
    kilo: { stream: () => Stream.empty },
    retry: { schedule: Schedule.recurs(0) },
    profiles: () => [backend],
    fetch,
    headers: () => ({}),
    validateTransport: () => undefined,
  });
  await Effect.runPromise(
    Stream.runCollect(client.stream(afterImage(backendTargetId(backend, 'upstream'))))
  );
  const body = fetch.mock.calls[0]?.[1].body ?? '';
  expect(body).toContain(expected);
  expect(body.includes('image_url')).toBe(images);
  expect(body.includes(IMAGE_OMITTED)).toBe(!images);
});
