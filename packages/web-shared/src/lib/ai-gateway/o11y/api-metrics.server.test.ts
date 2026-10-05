import { afterEach, describe, expect, test } from '@jest/globals';
import { after } from 'next/server';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { emitApiMetricsForResponse, getToolsAvailable, getToolsUsed } from './api-metrics.server';

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));
jest.mock('@/lib/config.server', () => ({
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

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    jest.mocked(after).mockReset();
  });

  test('stops draining an open stream at the deadline with a single timer', async () => {
    jest.useFakeTimers();
    const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
    mockedFetch.mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = mockedFetch;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"provider":"Fireworks"}\n\n'));
      },
    });

    emitApiMetricsForResponse(
      {
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
      },
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
      performance.now()
    );

    const [callback] = jest.mocked(after).mock.calls[0] ?? [];
    if (typeof callback !== 'function') throw new Error('Expected deferred metrics callback');
    const drained = callback();
    await jest.advanceTimersByTimeAsync(0);
    expect(jest.getTimerCount()).toBe(1);

    await jest.advanceTimersByTimeAsync(60_000);
    await drained;

    expect(jest.getTimerCount()).toBe(0);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      inferenceProvider: 'Fireworks',
      clientSecret: 'test-secret',
    });
  });
});
