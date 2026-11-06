import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { after } from 'next/server';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { emitApiMetricsForResponse, getToolsAvailable, getToolsUsed } from './api-metrics.server';
import { parseMessagesMicrodollarUsageFromStream } from '../processUsage.messages';
import { parseResponsesMicrodollarUsageFromStream } from '../processUsage.responses';
import type { ProviderType } from '../providers/types';

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  O11Y_SERVICE_URL: 'https://o11y.test',
  O11Y_KILO_GATEWAY_CLIENT_SECRET: 'test-secret',
}));

function chatRequest(overrides: Partial<OpenRouterChatCompletionRequest> = {}): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'test-model',
      messages: [],
      ...overrides,
    },
  };
}

function responsesRequest(overrides: Partial<GatewayResponsesRequest> = {}): GatewayRequest {
  return {
    kind: 'responses',
    body: {
      model: 'test-model',
      input: [],
      ...overrides,
    },
  };
}

function messagesRequest(overrides: Partial<GatewayMessagesRequest> = {}): GatewayRequest {
  return {
    kind: 'messages',
    body: {
      model: 'test-model',
      max_tokens: 16,
      messages: [],
      ...overrides,
    },
  };
}

describe('getToolsAvailable', () => {
  test('returns empty when tools is missing', () => {
    expect(getToolsAvailable(chatRequest())).toEqual([]);
  });

  test('returns empty when tools is not an array', () => {
    expect(
      getToolsAvailable(
        chatRequest({
          tools: { type: 'function', function: { name: 'search' } } as never,
        })
      )
    ).toEqual([]);
    expect(getToolsAvailable(chatRequest({ tools: 'search' as never }))).toEqual([]);
  });

  test('labels chat completion function and custom tools', () => {
    expect(
      getToolsAvailable(
        chatRequest({
          tools: [
            null as never,
            { type: 'function', function: { name: '  search  ' } },
            { type: 'custom', custom: { name: 'browser' } },
            { type: 'function', function: { name: '' } },
          ],
        })
      )
    ).toEqual(['function:search', 'custom:browser', 'function:unknown']);
  });

  test('labels responses tools and skips malformed entries', () => {
    expect(
      getToolsAvailable(
        responsesRequest({
          tools: [
            null,
            { type: 'function', name: 'lookup' },
            { type: 'custom', name: 'browser' },
            { type: 'mcp' },
            { type: 'web_search_preview' },
            {},
            { type: 123 },
          ] as GatewayResponsesRequest['tools'],
        })
      )
    ).toEqual([
      'function:lookup',
      'custom:browser',
      'mcp:unknown',
      'web_search_preview',
      'unknown:unknown',
      'unknown:unknown',
    ]);
  });

  test('labels messages tools', () => {
    expect(
      getToolsAvailable(
        messagesRequest({
          tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        })
      )
    ).toEqual(['function:read_file']);
  });
});

describe('getToolsUsed', () => {
  test('returns empty when chat messages are missing', () => {
    expect(getToolsUsed(chatRequest({ messages: undefined as never }))).toEqual([]);
  });

  test('labels chat completion tool calls', () => {
    expect(
      getToolsUsed(
        chatRequest({
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: '1', type: 'function', function: { name: 'search', arguments: '{}' } },
                { id: '2', type: 'custom', custom: { name: 'browser', input: '{}' } },
              ],
            },
          ],
        })
      )
    ).toEqual(['function:search', 'custom:browser']);
  });

  test('ignores non-array chat completion tool_calls', () => {
    expect(
      getToolsUsed(
        chatRequest({
          messages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: { id: '1', type: 'function' } as never,
            },
          ],
        })
      )
    ).toEqual([]);
  });

  test('tolerates responses tool calls with missing names', () => {
    expect(
      getToolsUsed(
        responsesRequest({
          input: [
            { type: 'function_call', call_id: '1', name: 'search', arguments: '{}' },
            { type: 'function_call', call_id: '2' },
            { type: 'custom_tool_call', call_id: '3', name: 'browser', input: '{}' },
            { type: 'custom_tool_call', call_id: '4' },
          ] as GatewayResponsesRequest['input'],
        })
      )
    ).toEqual(['function:search', 'function:unknown', 'custom:browser', 'custom:unknown']);
  });

  test('labels messages tool_use blocks', () => {
    expect(
      getToolsUsed(
        messagesRequest({
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: '1', name: 'read_file', input: {} }],
            },
          ],
        })
      )
    ).toEqual(['function:read_file']);
  });
});

describe('emitApiMetricsForResponse', () => {
  const originalFetch = globalThis.fetch;
  const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
  const params = {
    kiloUserId: 'user-1',
    isAnonymous: false,
    isStreaming: true,
    userByok: false,
    provider: 'openrouter',
    requestedModel: 'test-model',
    resolvedModel: 'test-model',
    toolsAvailable: [],
    toolsUsed: [],
    ttfbMs: 10,
    statusCode: 200,
  };

  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = mockedFetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
    jest.mocked(after).mockReset();
  });

  test('registers an eager promise and measures parse completion, not deferred callback execution', async () => {
    const stats = Promise.withResolvers<{ inference_provider: string }>();
    const now = jest.spyOn(performance, 'now').mockReturnValue(100);
    emitApiMetricsForResponse(params, stats.promise, 50);

    const [task] = jest.mocked(after).mock.calls[0] ?? [];
    expect(task).toBeInstanceOf(Promise);
    expect(mockedFetch).not.toHaveBeenCalled();

    now.mockReturnValue(275);
    stats.resolve({ inference_provider: 'Fireworks' });
    await task;

    now.mockReturnValue(1000);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockedFetch.mock.calls[0][1]?.body as string)).toMatchObject({
      inferenceProvider: 'Fireworks',
      completeRequestMs: 225,
      clientSecret: 'test-secret',
    });
  });

  test.each([
    { kind: 'messages', provider: 'openrouter', inferenceProvider: 'Anthropic' },
    { kind: 'messages', provider: 'vercel', inferenceProvider: 'bedrock' },
    { kind: 'responses', provider: 'vercel', inferenceProvider: 'anthropic' },
  ] satisfies { kind: string; provider: ProviderType; inferenceProvider: string }[])(
    'reports $kind stream provider from $provider usage parsing without cloning',
    async ({ kind, provider, inferenceProvider }) => {
      const clone = jest.spyOn(Response.prototype, 'clone');
      const now = jest.spyOn(performance, 'now').mockReturnValue(150);
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      const metadata = { gateway: { routing: { finalProvider: inferenceProvider } } };
      const frames =
        kind === 'messages'
          ? [
              {
                type: 'message_start',
                message: {
                  id: 'msg-1',
                  model: 'test-model',
                  ...(provider === 'openrouter'
                    ? { provider: inferenceProvider }
                    : { provider_metadata: metadata }),
                  usage: { input_tokens: 2, output_tokens: 0 },
                },
              },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 1 },
              },
              { type: 'message_stop' },
            ]
          : [
              {
                type: 'response.created',
                response: { id: 'resp-1', model: 'test-model', provider_metadata: metadata },
              },
              {
                type: 'response.completed',
                response: {
                  id: 'resp-1',
                  model: 'test-model',
                  status: 'completed',
                  usage: { input_tokens: 2, output_tokens: 1 },
                },
              },
            ];
      if (!controller) throw new Error('Expected stream controller');
      controller.enqueue(
        encoder.encode(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))
      );
      const parse =
        kind === 'messages'
          ? parseMessagesMicrodollarUsageFromStream
          : parseResponsesMicrodollarUsageFromStream;
      const statsPromise = parse(stream, 'user-1', undefined, provider, 200, false, 100);

      emitApiMetricsForResponse({ ...params, provider }, statsPromise, 100);
      expect(mockedFetch).not.toHaveBeenCalled();
      now.mockReturnValue(350);
      controller.close();

      const [task] = jest.mocked(after).mock.calls[0] ?? [];
      expect(task).toBeInstanceOf(Promise);
      await task;

      expect(clone).not.toHaveBeenCalled();
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockedFetch.mock.calls[0];
      expect(JSON.parse(init?.body as string)).toMatchObject({
        inferenceProvider,
        completeRequestMs: 250,
        clientSecret: 'test-secret',
      });
    }
  );

  test('emits metrics for a missing body without a provider', async () => {
    emitApiMetricsForResponse(params, Promise.resolve(null), performance.now());
    await jest.mocked(after).mock.calls[0]?.[0];

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockedFetch.mock.calls[0][1]?.body as string)).not.toHaveProperty(
      'inferenceProvider'
    );
  });

  test('propagates usage parse failure without emitting replacement metrics', async () => {
    const stats = Promise.withResolvers<null>();
    emitApiMetricsForResponse(params, stats.promise, performance.now());
    const [task] = jest.mocked(after).mock.calls[0] ?? [];
    const rejected = expect(task).rejects.toThrow('Usage parse failed');

    stats.reject(new Error('Usage parse failed'));
    await rejected;
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
