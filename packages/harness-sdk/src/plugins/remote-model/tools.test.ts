import { Effect, Schedule, Stream } from 'effect';
import { expect, it } from 'vitest';
import type { ApiKind, ModelRequest } from '../../index.js';
import { fakeFetch, sampleRequest, sse } from '../gateway/fake.js';
import { remoteModelClient } from './index.js';

const tools = [
  {
    name: 'weather',
    description: 'Weather',
    parameters: {
      type: 'object' as const,
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
];
const toolProtocols: readonly { kind: ApiKind; frames: readonly unknown[] }[] = [
  {
    kind: 'chat_completions',
    frames: [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call-a', function: { name: 'wea', arguments: '{"city":' } },
                { index: 1, id: 'call-b', function: { name: 'weather', arguments: '{"city":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, function: { arguments: '"Rome"}' } },
                { index: 0, function: { name: 'ther', arguments: '"Paris"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ],
  },
  {
    kind: 'responses',
    frames: [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call-a', name: 'weather' },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call-b', name: 'weather' },
      },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city":"Rome"}' },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"city":"Paris"}',
      },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ],
  },
  {
    kind: 'messages',
    frames: [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-a', name: 'weather', input: {} },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'call-b', name: 'weather', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { partial_json: '{"city":"Rome"}' } },
      { type: 'content_block_delta', index: 0, delta: { partial_json: '{"city":"Paris"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ],
  },
];

const toolBodyChecks: Readonly<Record<ApiKind, (body: unknown) => void>> = {
  chat_completions: body => {
    expect(body).toMatchObject({ tools: [{ type: 'function', function: { name: 'weather' } }] });
    expect(body).toHaveProperty(
      'messages',
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-a',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Paris"}' },
            },
          ],
        }),
        { role: 'tool', tool_call_id: 'call-a', content: 'Sunny' },
      ])
    );
  },
  responses: body => {
    expect(body).toMatchObject({ tools: [{ type: 'function', name: 'weather', strict: false }] });
    expect(body).toHaveProperty(
      'input',
      expect.arrayContaining([
        {
          type: 'function_call',
          call_id: 'call-a',
          name: 'weather',
          arguments: '{"city":"Paris"}',
        },
        { type: 'function_call_output', call_id: 'call-a', output: 'Sunny' },
      ])
    );
  },
  messages: body => {
    expect(body).toMatchObject({ tools: [{ name: 'weather', input_schema: { type: 'object' } }] });
    expect(body).toHaveProperty(
      'messages',
      expect.arrayContaining([
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call-a', name: 'weather', input: { city: 'Paris' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-a', content: 'Sunny' }],
        },
      ])
    );
  },
};

const answeredTool = [
  {
    role: 'assistant',
    cache: false,
    parts: [{ kind: 'toolCall', callId: 'call-a', name: 'weather', arguments: '{"city":"Paris"}' }],
  },
  {
    role: 'user',
    cache: false,
    parts: [{ kind: 'toolResult', callId: 'call-a', body: 'Sunny', failed: false }],
  },
] as const;

it.each(toolProtocols)(
  'retains interleaved $kind ids, names, arguments and tool round-trip bodies',
  async ({ kind, frames }) => {
    const { fetch, calls } = fakeFetch([
      { ok: true, status: 200, body: '', chunks: sse(...frames) },
    ]);
    const client = remoteModelClient(
      {
        baseUrl: 'https://provider.example/v1',
        apiKind: kind,
        fetch,
        headers: () => Effect.succeed({}),
      },
      { schedule: Schedule.recurs(0) }
    );
    const request: ModelRequest = { ...sampleRequest(), tools };
    const events = [...(await Effect.runPromise(Stream.runCollect(client.stream(request))))];
    expect(events.filter(event => event.kind === 'toolCall')).toEqual([
      { kind: 'toolCall', call: { id: 'call-a', name: 'weather', arguments: '{"city":"Paris"}' } },
      { kind: 'toolCall', call: { id: 'call-b', name: 'weather', arguments: '{"city":"Rome"}' } },
    ]);
    expect(events.filter(event => event.kind === 'done')).toMatchObject([
      { kind: 'done', stop: 'tools' },
    ]);
    await Effect.runPromise(
      Stream.runDrain(
        client.stream({
          ...request,
          prompt: {
            ...request.prompt,
            messages: [...request.prompt.messages, ...answeredTool],
          },
        })
      )
    );
    const body: unknown = JSON.parse(calls[1]?.request.body ?? '');
    toolBodyChecks[kind](body);
  }
);

it('keeps stream tool state independent when one client is consumed twice', async () => {
  const { fetch } = fakeFetch([
    { ok: true, status: 200, body: '', chunks: sse(...(toolProtocols[0]?.frames ?? [])) },
  ]);
  const client = remoteModelClient(
    {
      baseUrl: 'https://provider.example/v1',
      apiKind: 'chat_completions',
      fetch,
      headers: () => Effect.succeed({}),
    },
    { schedule: Schedule.recurs(0) }
  );
  const stream = client.stream(sampleRequest());
  const [first, second] = await Promise.all([
    Effect.runPromise(Stream.runCollect(stream)),
    Effect.runPromise(Stream.runCollect(stream)),
  ]);
  expect([...second]).toEqual([...first]);
  expect([...first].filter(event => event.kind === 'toolCall')).toHaveLength(2);
});

it('normalizes an empty Anthropic tool input without fabricating an argument fragment', async () => {
  const { fetch } = fakeFetch([
    {
      ok: true,
      status: 200,
      body: '',
      chunks: sse(
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'empty', name: 'clock', input: {} },
        },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } }
      ),
    },
  ]);
  const client = remoteModelClient(
    {
      baseUrl: 'https://provider.example/v1',
      apiKind: 'messages',
      fetch,
      headers: () => Effect.succeed({}),
    },
    { schedule: Schedule.recurs(0) }
  );
  const events = await Effect.runPromise(Stream.runCollect(client.stream(sampleRequest())));
  expect([...events]).toMatchObject([
    { kind: 'toolCall', call: { id: 'empty', name: 'clock', arguments: '{}' } },
    { kind: 'done', stop: 'tools' },
  ]);
});
