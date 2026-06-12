import { describe, expect, it } from '@jest/globals';
import { rewriteChatCompletionsOneOfAsAnyOf } from '@/lib/ai-gateway/schema-rewrite';
import type { OpenRouterChatCompletionRequest } from '@/lib/ai-gateway/providers/openrouter/types';

function makeRequest(
  partial: Partial<OpenRouterChatCompletionRequest>
): OpenRouterChatCompletionRequest {
  return {
    model: 'zai/glm-4.6',
    messages: [],
    ...partial,
  } as OpenRouterChatCompletionRequest;
}

describe('rewriteChatCompletionsOneOfAsAnyOf', () => {
  it('rewrites oneOf as anyOf in tool function parameters', () => {
    const request = makeRequest({
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            parameters: {
              type: 'object',
              oneOf: [{ type: 'string' }, { type: 'number' }],
            },
          },
        },
      ],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    const parameters = request.tools![0].function.parameters as Record<string, unknown>;
    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters).toHaveProperty('anyOf');
    expect(parameters.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('rewrites oneOf as anyOf in the response_format schema', () => {
    const request = makeRequest({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'result',
          schema: {
            type: 'object',
            oneOf: [{ type: 'string' }],
          },
        },
      } as OpenRouterChatCompletionRequest['response_format'],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    const schema = (
      request.response_format as Record<string, unknown> & {
        json_schema: { schema: Record<string, unknown> };
      }
    ).json_schema.schema;
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema.anyOf).toEqual([{ type: 'string' }]);
  });

  it('rewrites nested oneOf keywords', () => {
    const request = makeRequest({
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            parameters: {
              type: 'object',
              properties: {
                filter: {
                  oneOf: [{ type: 'string' }, { type: 'number' }],
                },
              },
              oneOf: [{ type: 'object' }],
            },
          },
        },
      ],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    const parameters = request.tools![0].function.parameters as Record<string, unknown>;
    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters.anyOf).toEqual([{ type: 'object' }]);
    expect(parameters.properties.filter).not.toHaveProperty('oneOf');
    expect(parameters.properties.filter.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('leaves schemas without oneOf untouched', () => {
    const request = makeRequest({
      tools: [
        {
          type: 'function',
          function: {
            name: 'ping',
            parameters: {
              type: 'object',
              properties: { host: { type: 'string' } },
            },
          },
        },
      ],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    const parameters = request.tools![0].function.parameters as Record<string, unknown>;
    expect(parameters).not.toHaveProperty('anyOf');
    expect(parameters).not.toHaveProperty('oneOf');
  });

  it('preserves other keywords alongside the rewrite', () => {
    const request = makeRequest({
      tools: [
        {
          type: 'function',
          function: {
            name: 'run',
            parameters: {
              type: 'object',
              required: ['mode'],
              oneOf: [{ type: 'string' }],
            },
          },
        },
      ],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    const parameters = request.tools![0].function.parameters as Record<string, unknown>;
    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['mode']);
    expect(parameters.anyOf).toEqual([{ type: 'string' }]);
  });

  it('merges into an existing anyOf instead of overwriting it', () => {
    const request = makeRequest({
      tools: [
        {
          type: 'function',
          function: {
            name: 'merge',
            parameters: {
              type: 'object',
              anyOf: [{ type: 'boolean' }],
              oneOf: [{ type: 'string' }],
            },
          },
        },
      ],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    const parameters = request.tools![0].function.parameters as Record<string, unknown>;
    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters.anyOf).toEqual([{ type: 'boolean' }, { type: 'string' }]);
  });

  it('handles a request with no tools or response_format', () => {
    const request = makeRequest({});

    expect(() => rewriteChatCompletionsOneOfAsAnyOf(request)).not.toThrow();
  });

  it('does not loop forever on a circular schema', () => {
    const schema: Record<string, unknown> = { type: 'object', oneOf: [] };
    const child: Record<string, unknown> = { type: 'string' };
    schema.properties = { child };
    child.parent = schema;

    const request = makeRequest({
      tools: [
        {
          type: 'function',
          function: { name: 'circular', parameters: schema },
        },
      ],
    });

    expect(() => rewriteChatCompletionsOneOfAsAnyOf(request)).not.toThrow();
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).toHaveProperty('anyOf');
  });
});
