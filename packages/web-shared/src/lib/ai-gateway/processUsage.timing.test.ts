import { test, describe, expect, beforeEach, afterEach } from '@jest/globals';
import { parseMicrodollarUsageFromStream } from './processUsage';
import { parseMessagesMicrodollarUsageFromStream } from './processUsage.messages';
import { parseResponsesMicrodollarUsageFromStream } from './processUsage.responses';
import type { MicrodollarUsageStats } from './processUsage.types';
import { createControlledClock } from '@kilocode/web-shared/tests/helpers/timed-body.helper';

jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<object>('@sentry/nextjs'),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

type ParseStream = (
  stream: ReadableStream<Uint8Array>,
  kiloUserId: string,
  openrouterRequestSpan: undefined,
  provider: 'openrouter',
  statusCode: number,
  usesUserCredentials: boolean,
  requestStartedAt?: number
) => Promise<MicrodollarUsageStats>;

type Fixtures = {
  /** Token-free events a stream may open with. */
  lifecycle: unknown[];
  text: unknown;
  reasoning: unknown;
  /** A tool call's first generated part, without any text. */
  toolCall: unknown;
  /** Token-free events a stream may end with, including usage. */
  completion: unknown[];
  error: unknown;
  /** Other events that each carry generated output. */
  otherOutputs: unknown[];
  /** Other events that carry no generated tokens. */
  otherTokenFree: unknown[];
};

const usage = { cost: 0.001, is_byok: false };

const apiKinds: { apiKind: string; parse: ParseStream; fixtures: Fixtures }[] = [
  {
    apiKind: 'chat_completions',
    parse: parseMicrodollarUsageFromStream,
    fixtures: {
      lifecycle: [
        { id: 'gen-1', model: 'test/model', choices: [{ index: 0, delta: { role: 'assistant' } }] },
        {
          id: 'gen-1',
          model: 'test/model',
          choices: [{ index: 0, delta: { role: 'assistant', content: '', reasoning: null } }],
        },
        {
          id: 'gen-1',
          choices: [{ index: 0, delta: { content: [{ type: 'text', text: '' }], tool_calls: [] } }],
        },
      ],
      text: { id: 'gen-1', choices: [{ index: 0, delta: { content: 'Hello' } }] },
      reasoning: { id: 'gen-1', choices: [{ index: 0, delta: { reasoning: 'Thinking' } }] },
      toolCall: {
        id: 'gen-1',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      completion: [
        { id: 'gen-1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        {
          id: 'gen-1',
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 2, ...usage },
        },
        '[DONE]',
      ],
      error: { error: { code: 502, message: 'Upstream error' } },
      otherOutputs: [
        { choices: [{ delta: { reasoning_content: 'Thinking' } }] },
        {
          choices: [
            { delta: { reasoning_details: [{ type: 'reasoning.text', text: 'Thinking' }] } },
          ],
        },
        {
          choices: [
            { delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'Thinking' }] } },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Thinking' }] }],
              },
            },
          ],
        },
        { choices: [{ delta: { content: [{ type: 'text', text: 'Hello' }] } }] },
        { choices: [{ delta: { refusal: 'No' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"' } }] } }] },
        {
          choices: [
            {
              delta: {
                images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' } }],
              },
            },
          ],
        },
        { choices: [{ delta: { audio: { transcript: 'Hello' } } }] },
      ],
      otherTokenFree: [
        {
          choices: [
            {
              delta: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'ZW5jcnlwdGVk' }] },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '' } }] } }] },
        { choices: [{ delta: { refusal: null, images: [] } }] },
      ],
    },
  },
  {
    apiKind: 'responses',
    parse: parseResponsesMicrodollarUsageFromStream,
    fixtures: {
      lifecycle: [
        {
          type: 'response.created',
          response: { id: 'resp_1', model: 'test/model', status: 'in_progress' },
        },
        {
          type: 'response.in_progress',
          response: { id: 'resp_1', model: 'test/model', status: 'in_progress' },
        },
        {
          type: 'response.output_item.added',
          item: { type: 'message', role: 'assistant', content: [] },
        },
        { type: 'response.content_part.added', part: { type: 'output_text', text: '' } },
        { type: 'response.output_text.delta', delta: '' },
      ],
      text: { type: 'response.output_text.delta', delta: 'Hello' },
      reasoning: { type: 'response.reasoning_summary_text.delta', delta: 'Thinking' },
      toolCall: {
        type: 'response.output_item.added',
        item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '' },
      },
      completion: [
        { type: 'response.output_text.done', text: 'Hello' },
        {
          type: 'response.completed',
          response: {
            id: 'resp_1',
            model: 'test/model',
            status: 'completed',
            usage: { input_tokens: 10, output_tokens: 2, ...usage },
          },
        },
      ],
      error: { type: 'error', error: { message: 'Upstream error' } },
      otherOutputs: [
        { type: 'response.function_call_arguments.delta', delta: '{"' },
        { type: 'response.refusal.delta', delta: 'No' },
        { type: 'response.reasoning_text.delta', delta: 'Thinking' },
      ],
      otherTokenFree: [
        { type: 'response.function_call_arguments.delta', delta: '' },
        { type: 'response.output_item.added', item: { type: 'reasoning', summary: [] } },
        { type: 'response.output_item.done', item: { type: 'message', content: [] } },
      ],
    },
  },
  {
    apiKind: 'messages',
    parse: parseMessagesMicrodollarUsageFromStream,
    fixtures: {
      lifecycle: [
        {
          type: 'message_start',
          message: { id: 'msg_1', model: 'test/model', usage: { input_tokens: 10 } },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'ping' },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' } },
      ],
      text: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      reasoning: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Thinking' },
      },
      toolCall: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      },
      completion: [
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 2, ...usage },
        },
        { type: 'message_stop' },
      ],
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Upstream error' } },
      otherOutputs: [
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"' },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'server_tool_use',
            id: 'srvtoolu_1',
            name: 'web_search',
            input: {},
          },
        },
      ],
      otherTokenFree: [
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '' },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'redacted_thinking', data: 'ZW5jcnlwdGVk' },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'citations_delta', citation: { type: 'char_location', cited_text: 'x' } },
        },
      ],
    },
  },
];

const clock = createControlledClock();

function sse(event: unknown) {
  return `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`;
}

/** Events arriving at the given times; a stream starting at 0 is timed from the request start. */
function parseEvents(parse: ParseStream, events: [at: number, event: unknown][], failure?: Error) {
  return parse(
    clock.bodyArrivingAt(
      events.map(([at, event]) => [at, sse(event)]),
      failure
    ),
    'timing-user',
    undefined,
    'openrouter',
    200,
    false,
    0
  );
}

describe.each(apiKinds)('$apiKind stream timing', ({ parse, fixtures }) => {
  let clockSpy: ReturnType<typeof clock.install>;

  beforeEach(() => {
    clockSpy = clock.install();
  });

  afterEach(() => {
    clockSpy.mockRestore();
  });

  test('times the first generated token, not earlier lifecycle events', async () => {
    const result = await parseEvents(parse, [
      ...fixtures.lifecycle.map((event, i): [number, unknown] => [100 + i, event]),
      [5_000, fixtures.text],
      [5_200, fixtures.text],
      ...fixtures.completion.map((event, i): [number, unknown] => [5_300 + i, event]),
    ]);

    expect(result).toMatchObject({
      latency: 5_000,
      generation_time: 300 + fixtures.completion.length - 1,
      hasError: false,
    });
  });

  test.each(fixtures.otherOutputs)('times the generated output in %j', async event => {
    const result = await parseEvents(parse, [
      [100, fixtures.lifecycle[0]],
      [600, event],
      [900, fixtures.completion.at(-1)],
    ]);

    expect(result).toMatchObject({ latency: 600, generation_time: 300 });
  });

  test.each(fixtures.otherTokenFree)('does not time the token-free %j', async event => {
    const result = await parseEvents(parse, [
      [100, fixtures.lifecycle[0]],
      [600, event],
      [800, fixtures.text],
      [900, fixtures.completion.at(-1)],
    ]);

    expect(result).toMatchObject({ latency: 800, generation_time: 100 });
  });

  test('times reasoning that precedes the text', async () => {
    const result = await parseEvents(parse, [
      [100, fixtures.lifecycle[0]],
      [1_000, fixtures.reasoning],
      [2_000, fixtures.text],
      [2_500, fixtures.completion.at(-1)],
    ]);

    expect(result).toMatchObject({ latency: 1_000, generation_time: 1_500 });
  });

  test('times a tool call without text', async () => {
    const result = await parseEvents(parse, [
      [100, fixtures.lifecycle[0]],
      [3_000, fixtures.toolCall],
      [3_400, fixtures.completion.at(-1)],
    ]);

    expect(result).toMatchObject({ latency: 3_000, generation_time: 400 });
  });

  test('reports no timing for a stream without generated tokens', async () => {
    const result = await parseEvents(parse, [
      ...fixtures.lifecycle.map((event, i): [number, unknown] => [100 + i, event]),
      ...fixtures.completion.map((event, i): [number, unknown] => [500 + i, event]),
    ]);

    expect(result).toMatchObject({ latency: null, generation_time: null });
  });

  test('reports no timing for an error stream', async () => {
    const result = await parseEvents(parse, [
      [100, fixtures.lifecycle[0]],
      [300, fixtures.error],
    ]);

    expect(result).toMatchObject({ latency: null, generation_time: null, hasError: true });
  });

  test('does not time malformed events', async () => {
    const result = await parseEvents(parse, [
      [100, 'not-json'],
      [800, fixtures.text],
      [900, fixtures.completion.at(-1)],
    ]);

    expect(result).toMatchObject({ latency: 800, generation_time: 100, hasError: true });
  });

  test('reports no timing for a stream aborted before any generated token', async () => {
    const result = await parseEvents(
      parse,
      [[100, fixtures.lifecycle[0]]],
      new TypeError('terminated')
    );

    expect(result).toMatchObject({ latency: null, generation_time: null, hasError: true });
  });

  test('times a stream aborted after generated tokens until its last event', async () => {
    const result = await parseEvents(
      parse,
      [
        [100, fixtures.lifecycle[0]],
        [700, fixtures.text],
        [750, fixtures.text],
      ],
      new TypeError('terminated')
    );

    expect(result).toMatchObject({ latency: 700, generation_time: 50, hasError: true });
  });
});
