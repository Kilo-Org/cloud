import { Effect, Layer, Schedule, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { type ApiKind, ModelClient, RetryPolicy } from '../../index.js';
import { fakeFetch, sampleRequest, sse } from '../gateway/fake.js';
import { layerRemoteModel, remoteModelClient, type RemoteModelConfig } from './index.js';

const retry = { schedule: Schedule.recurs(0) };
const protocols: readonly {
  kind: ApiKind;
  path: string;
  frames: readonly unknown[];
  stop: string;
  usage: object;
}[] = [
  {
    kind: 'chat_completions',
    path: '/chat/completions',
    stop: 'maxTokens',
    frames: [
      { choices: [{ delta: { content: 'hello' }, finish_reason: 'length' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 4 },
        },
      },
    ],
    usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 },
  },
  {
    kind: 'responses',
    path: '/responses',
    stop: 'end',
    frames: [
      { type: 'response.output_text.delta', delta: 'hello' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
        },
      },
    ],
    usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 },
  },
  {
    kind: 'messages',
    path: '/messages',
    stop: 'refusal',
    frames: [
      {
        type: 'message_start',
        message: { usage: { input_tokens: 6, cache_read_input_tokens: 4 } },
      },
      { type: 'content_block_delta', delta: { text: 'hello' } },
      { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 2 } },
    ],
    usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 0 },
  },
];

const expectedBodies: Readonly<Record<ApiKind, object>> = {
  chat_completions: {
    max_completion_tokens: 1024,
    reasoning_effort: 'low',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ],
  },
  responses: {
    max_output_tokens: 1024,
    instructions: 'sys',
    reasoning: { effort: 'low' },
    store: false,
    prompt_cache_key: 'ses_1',
  },
  messages: {
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: 'sys' }],
  },
};

const headersByKind: Readonly<Record<ApiKind, Readonly<Record<string, string>>>> = {
  chat_completions: { authorization: 'Bearer remote-secret' },
  responses: { authorization: 'Bearer remote-secret' },
  messages: { 'x-api-key': 'remote-secret', 'anthropic-version': '2023-06-01' },
};

describe.each(protocols)('$kind direct provider', ({ kind, path, frames, stop, usage }) => {
  it('renders the direct request and streams normalized events through its public layer', async () => {
    const chunks = sse(...frames).join('');
    const { calls, fetch } = fakeFetch([
      {
        ok: true,
        status: 200,
        body: '',
        chunks: [chunks.slice(0, 23), chunks.slice(23), 'data: [DONE]\n\n'],
      },
    ]);
    const config: RemoteModelConfig = {
      baseUrl: 'https://provider.example/v1///',
      apiKind: kind,
      fetch,
      headers: () => Effect.succeed(headersByKind[kind]),
    };
    const events = await Effect.runPromise(
      Effect.flatMap(ModelClient, client =>
        Stream.runCollect(
          client.stream({ ...sampleRequest(), model: 'upstream-id', effort: 'low' })
        )
      ).pipe(
        Effect.provide(
          layerRemoteModel(config).pipe(Layer.provide(Layer.succeed(RetryPolicy, retry)))
        )
      )
    );
    expect(calls[0]).toMatchObject({
      url: `https://provider.example/v1${path}`,
      request: {
        redirect: 'error',
        headers: { ...headersByKind[kind], 'content-type': 'application/json' },
      },
    });
    const body: unknown = JSON.parse(calls[0]?.request.body ?? '');
    expect(body).toMatchObject({ model: 'upstream-id', stream: true, ...expectedBodies[kind] });
    if (kind === 'chat_completions') {
      expect(body).not.toHaveProperty('reasoning');
    }
    expect([...events]).toEqual([
      { kind: 'delta', text: 'hello' },
      { kind: 'done', usage, stop },
    ]);
  });
});

it.each(['chat_completions', 'responses'] as const)(
  'preserves %s refusal text and finish reason',
  async kind => {
    const frames =
      kind === 'chat_completions'
        ? [
            { choices: [{ delta: { refusal: 'Cannot help' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ]
        : [
            { type: 'response.refusal.delta', delta: 'Cannot help' },
            { type: 'response.completed', response: { status: 'completed' } },
          ];
    const { fetch } = fakeFetch([{ ok: true, status: 200, body: '', chunks: sse(...frames) }]);
    const client = remoteModelClient(
      {
        baseUrl: 'https://provider.example/v1',
        apiKind: kind,
        fetch,
        headers: () => Effect.succeed({}),
      },
      retry
    );
    const events = await Effect.runPromise(Stream.runCollect(client.stream(sampleRequest())));
    expect([...events]).toMatchObject([
      { kind: 'delta', text: 'Cannot help' },
      { kind: 'done', stop: 'refusal' },
    ]);
  }
);

it('preserves simultaneous text and reasoning instead of shadowing either delta', async () => {
  const { fetch } = fakeFetch([
    {
      ok: true,
      status: 200,
      body: '',
      chunks: sse({
        choices: [
          { delta: { content: 'answer', reasoning_content: 'thinking' }, finish_reason: 'stop' },
        ],
      }),
    },
  ]);
  const client = remoteModelClient(
    {
      baseUrl: 'https://provider.example/v1',
      apiKind: 'chat_completions',
      fetch,
      headers: () => Effect.succeed({}),
    },
    retry
  );
  const events = await Effect.runPromise(Stream.runCollect(client.stream(sampleRequest())));
  expect([...events]).toMatchObject([
    { kind: 'delta', text: 'answer' },
    { kind: 'reasoning', text: 'thinking' },
    { kind: 'done', stop: 'end' },
  ]);
});

it('keeps images as content blocks while sending text-only turns as strings', async () => {
  const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: '', chunks: [] }]);
  const client = remoteModelClient(
    {
      baseUrl: 'https://provider.example/v1',
      apiKind: 'chat_completions',
      fetch,
      headers: () => Effect.succeed({}),
    },
    retry
  );
  await Effect.runPromise(
    Stream.runDrain(
      client.stream({
        ...sampleRequest(),
        prompt: {
          system: [],
          messages: [
            {
              role: 'user',
              cache: false,
              parts: [
                { kind: 'text', text: 'Look' },
                { kind: 'image', media: 'image/png', data: 'AAAA' },
              ],
            },
          ],
        },
      })
    )
  );
  expect(JSON.parse(calls[0]?.request.body ?? '')).toMatchObject({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
});

it.each([undefined, 'max_completion_tokens', 'max_tokens'] as const)(
  'serializes the explicit Chat Completions limit field %s',
  async completionTokenField => {
    const { fetch, calls } = fakeFetch([{ ok: true, status: 200, body: '', chunks: [] }]);
    const client = remoteModelClient(
      {
        baseUrl: 'https://provider.example/v1',
        apiKind: 'chat_completions',
        ...(completionTokenField === undefined ? {} : { completionTokenField }),
        fetch,
        headers: () => Effect.succeed({}),
      },
      retry
    );
    await Effect.runPromise(Stream.runDrain(client.stream(sampleRequest())));
    const field = completionTokenField ?? 'max_completion_tokens';
    const body: unknown = JSON.parse(calls[0]?.request.body ?? '');
    expect(body).toHaveProperty(field, 1024);
    expect(body).not.toHaveProperty(
      field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'
    );
  }
);
