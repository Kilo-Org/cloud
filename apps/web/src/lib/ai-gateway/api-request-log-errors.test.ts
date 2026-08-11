import { describe, expect, test } from '@jest/globals';
import { detectRequestLogErrors } from './api-request-log-errors';
import type {
  GatewayMessagesRequest,
  GatewayRequest,
  GatewayResponsesRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';

const weatherParameters = {
  type: 'object' as const,
  properties: {
    city: { type: 'string' as const },
  },
  required: ['city'],
};

function chatRequest(overrides: Partial<OpenRouterChatCompletionRequest> = {}): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: {
      model: 'test',
      messages: [],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', parameters: weatherParameters },
        },
      ],
      ...overrides,
    },
  };
}

function responsesRequest(overrides: Partial<GatewayResponsesRequest> = {}): GatewayRequest {
  return {
    kind: 'responses',
    body: {
      model: 'test',
      input: [],
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          parameters: weatherParameters,
          strict: null,
        },
      ],
      ...overrides,
    },
  };
}

function messagesRequest(overrides: Partial<GatewayMessagesRequest> = {}): GatewayRequest {
  return {
    kind: 'messages',
    body: {
      model: 'claude-test',
      max_tokens: 16,
      messages: [],
      tools: [
        {
          name: 'get_weather',
          input_schema: weatherParameters,
        },
      ],
      ...overrides,
    },
  };
}

function sse(...payloads: unknown[]): string {
  return (
    payloads.map(payload => `data: ${JSON.stringify(payload)}\n\n`).join('') + 'data: [DONE]\n\n'
  );
}

describe('detectRequestLogErrors', () => {
  test('returns null for a successful streamed completion with no tools', () => {
    expect(
      detectRequestLogErrors(
        sse({ id: 'gen-1', choices: [{ index: 0, delta: { content: 'hi' } }] }),
        chatRequest({ tools: [] })
      )
    ).toBeNull();
  });

  test('returns null for a successful JSON completion with no tools', () => {
    expect(
      detectRequestLogErrors(
        JSON.stringify({
          choices: [{ message: { content: 'hi' } }],
        }),
        chatRequest({ tools: [] })
      )
    ).toBeNull();
  });

  describe('upstream errors', () => {
    test('stores chat completion SSE error objects', () => {
      expect(
        detectRequestLogErrors(
          sse(
            { id: 'gen-1', choices: [{ index: 0, delta: { content: 'hi' } }] },
            { error: { code: 429, message: 'rate limited' } }
          ),
          chatRequest()
        )
      ).toEqual({
        upstream_error: { code: 429, message: 'rate limited' },
      });
    });

    test('stores messages SSE error objects', () => {
      expect(
        detectRequestLogErrors(
          'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"rate limited"}}\n\n',
          messagesRequest()
        )
      ).toEqual({
        upstream_error: { type: 'api_error', message: 'rate limited' },
      });
    });

    test('stores responses SSE error objects', () => {
      expect(
        detectRequestLogErrors(
          'event: error\ndata: {"type":"error","error":{"type":"server_error","message":"rate limited"}}\n\n',
          responsesRequest()
        )
      ).toEqual({
        upstream_error: { type: 'server_error', message: 'rate limited' },
      });
    });

    test('stores response.failed error details', () => {
      expect(
        detectRequestLogErrors(
          sse({
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { code: 'server_error', message: 'provider failed' },
            },
          }),
          responsesRequest()
        )
      ).toEqual({
        upstream_error: { code: 'server_error', message: 'provider failed' },
      });
    });

    test('stores JSON error bodies', () => {
      expect(
        detectRequestLogErrors(
          JSON.stringify({
            error: { message: 'Model not found', code: 404 },
            error_type: 'model_not_found',
          }),
          chatRequest()
        )
      ).toEqual({
        upstream_error: { message: 'Model not found', code: 404 },
      });
    });

    test('stores string JSON error bodies', () => {
      expect(
        detectRequestLogErrors(JSON.stringify({ error: 'temporarily unavailable' }), chatRequest())
      ).toEqual({
        upstream_error: 'temporarily unavailable',
      });
    });

    test('keeps the last upstream error when several appear in a stream', () => {
      expect(
        detectRequestLogErrors(
          sse({ error: { message: 'first' } }, { error: { message: 'second' } }),
          chatRequest()
        )
      ).toEqual({
        upstream_error: { message: 'second' },
      });
    });
  });

  describe('tool call argument errors', () => {
    test('detects unparseable JSON arguments in a chat SSE stream', () => {
      const result = detectRequestLogErrors(
        sse(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'get_weather', arguments: '{"city":' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"' } }] },
              },
            ],
          }
        ),
        chatRequest()
      );

      expect(result?.invalid_tool_call_arguments).toEqual([
        {
          tool_call_id: 'call_1',
          tool_name: 'get_weather',
          kind: 'unparseable_json',
          details: expect.any(String),
        },
      ]);
    });

    test('detects schema mismatches in a non-streamed chat completion', () => {
      expect(
        detectRequestLogErrors(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'get_weather', arguments: '{"city":1}' },
                    },
                  ],
                },
              },
            ],
          }),
          chatRequest()
        )
      ).toEqual({
        invalid_tool_call_arguments: [
          {
            tool_call_id: 'call_1',
            tool_name: 'get_weather',
            kind: 'schema_mismatch',
            details: expect.anything(),
          },
        ],
      });
    });

    test('detects unknown tools in a non-streamed responses body', () => {
      expect(
        detectRequestLogErrors(
          JSON.stringify({
            output: [
              {
                type: 'function_call',
                call_id: 'call_9',
                name: 'launch_missiles',
                arguments: '{}',
              },
            ],
          }),
          responsesRequest()
        )
      ).toEqual({
        invalid_tool_call_arguments: [
          {
            tool_call_id: 'call_9',
            tool_name: 'launch_missiles',
            kind: 'unknown_tool',
          },
        ],
      });
    });

    test('detects schema mismatches in a non-streamed messages body', () => {
      expect(
        detectRequestLogErrors(
          JSON.stringify({
            content: [
              {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'get_weather',
                input: { city: 1 },
              },
            ],
          }),
          messagesRequest()
        )
      ).toEqual({
        invalid_tool_call_arguments: [
          {
            tool_call_id: 'toolu_1',
            tool_name: 'get_weather',
            kind: 'schema_mismatch',
            details: expect.anything(),
          },
        ],
      });
    });

    test('still records tool-call errors when a later SSE error event has no choices', () => {
      const result = detectRequestLogErrors(
        sse(
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'missing_tool', arguments: '{}' },
                    },
                  ],
                },
              },
            ],
          },
          { error: { code: 502, message: 'provider unavailable' } }
        ),
        chatRequest()
      );

      expect(result).toEqual({
        invalid_tool_call_arguments: [
          {
            tool_call_id: 'call_1',
            tool_name: 'missing_tool',
            kind: 'unknown_tool',
          },
        ],
        upstream_error: { code: 502, message: 'provider unavailable' },
      });
    });

    test('ignores a malformed SSE event and still records later errors', () => {
      expect(
        detectRequestLogErrors(
          'data: not-json\n\n' +
            'data: {"error":{"message":"still captured"}}\n\n' +
            'data: [DONE]\n\n',
          chatRequest()
        )
      ).toEqual({
        upstream_error: { message: 'still captured' },
      });
    });
  });
});
