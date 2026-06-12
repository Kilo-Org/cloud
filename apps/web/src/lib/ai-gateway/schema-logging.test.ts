import type { OpenRouterChatCompletionRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { logChatCompletionsOneOfSchemas } from './schema-logging';

function createRequest(
  overrides: Partial<OpenRouterChatCompletionRequest> = {}
): OpenRouterChatCompletionRequest {
  return {
    model: 'test-model',
    messages: [],
    ...overrides,
  };
}

describe('logChatCompletionsOneOfSchemas', () => {
  it('does not log when request schemas do not use oneOf', () => {
    const log = jest.fn();
    const request = createRequest({
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          },
        },
      ],
    });

    logChatCompletionsOneOfSchemas(request, 'test-model', 'openrouter', log);

    expect(log).not.toHaveBeenCalled();
  });

  it('ignores malformed optional schema fields', () => {
    const log = jest.fn();
    const requests = [
      createRequest({ tools: {} as never }),
      createRequest({ tools: [null] as never }),
      createRequest({
        response_format: { type: 'json_schema', json_schema: null } as never,
      }),
    ];

    for (const request of requests) {
      expect(() =>
        logChatCompletionsOneOfSchemas(request, 'test-model', 'openrouter', log)
      ).not.toThrow();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('logs nested oneOf occurrences in tool schemas', () => {
    const log = jest.fn();
    const request = createRequest({
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            parameters: {
              type: 'object',
              properties: {
                query: {
                  oneOf: [{ type: 'string' }, { type: 'number' }],
                },
              },
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'read',
            parameters: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    path: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                },
              ],
            },
          },
        },
      ],
    });

    logChatCompletionsOneOfSchemas(request, 'test-model', 'openrouter', log);

    expect(log).toHaveBeenCalledWith('Chat completions request contains JSON Schema oneOf', {
      event: 'ai_gateway_chat_completions_one_of_schema',
      model: 'test-model',
      provider: 'openrouter',
      one_of_occurrences: 3,
      tool_schema_count: 2,
      response_format_schema: false,
    });
  });

  it('logs oneOf occurrences in a JSON response format schema', () => {
    const log = jest.fn();
    const request = createRequest({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'result',
          schema: {
            type: 'object',
            properties: {
              value: { oneOf: [{ type: 'boolean' }, { type: 'string' }] },
            },
          },
        },
      },
    });

    logChatCompletionsOneOfSchemas(request, 'test-model', 'vercel', log);

    expect(log).toHaveBeenCalledWith('Chat completions request contains JSON Schema oneOf', {
      event: 'ai_gateway_chat_completions_one_of_schema',
      model: 'test-model',
      provider: 'vercel',
      one_of_occurrences: 1,
      tool_schema_count: 0,
      response_format_schema: true,
    });
  });
});
