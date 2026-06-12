import { describe, expect, it } from '@jest/globals';
import { rewriteChatCompletionsOneOfAsAnyOf } from '@/lib/ai-gateway/schema-rewrite';
import type { OpenRouterChatCompletionRequest } from '@/lib/ai-gateway/providers/openrouter/types';

type Schema = Record<string, unknown>;

function toolWith(name: string, parameters: Schema) {
  return { type: 'function', function: { name, parameters } };
}

function makeRequest(partial: Record<string, unknown>): OpenRouterChatCompletionRequest {
  return {
    model: 'zai/glm-4.6',
    messages: [],
    ...partial,
  } as OpenRouterChatCompletionRequest;
}

describe('rewriteChatCompletionsOneOfAsAnyOf', () => {
  it('rewrites oneOf as anyOf in tool function parameters', () => {
    const parameters: Schema = {
      type: 'object',
      oneOf: [{ type: 'string' }, { type: 'number' }],
    };
    const request = makeRequest({ tools: [toolWith('get_weather', parameters)] });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters).toHaveProperty('anyOf');
    expect(parameters.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('rewrites oneOf as anyOf in the response_format schema', () => {
    const schema: Schema = { type: 'object', oneOf: [{ type: 'string' }] };
    const request = makeRequest({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'result', schema },
      } as OpenRouterChatCompletionRequest['response_format'],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    expect(schema).not.toHaveProperty('oneOf');
    expect(schema.anyOf).toEqual([{ type: 'string' }]);
  });

  it('rewrites nested oneOf keywords', () => {
    const filter: Schema = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    const parameters: Schema = {
      type: 'object',
      properties: { filter },
      oneOf: [{ type: 'object' }],
    };
    const request = makeRequest({ tools: [toolWith('search', parameters)] });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters.anyOf).toEqual([{ type: 'object' }]);
    expect(filter).not.toHaveProperty('oneOf');
    expect(filter.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('leaves schemas without oneOf untouched', () => {
    const parameters: Schema = { type: 'object', properties: { host: { type: 'string' } } };
    const request = makeRequest({ tools: [toolWith('ping', parameters)] });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    expect(parameters).not.toHaveProperty('anyOf');
    expect(parameters).not.toHaveProperty('oneOf');
  });

  it('preserves other keywords alongside the rewrite', () => {
    const parameters: Schema = { type: 'object', required: ['mode'], oneOf: [{ type: 'string' }] };
    const request = makeRequest({ tools: [toolWith('run', parameters)] });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    expect(parameters.type).toBe('object');
    expect(parameters.required).toEqual(['mode']);
    expect(parameters.anyOf).toEqual([{ type: 'string' }]);
  });

  it('merges into an existing anyOf instead of overwriting it', () => {
    const parameters: Schema = {
      type: 'object',
      anyOf: [{ type: 'boolean' }],
      oneOf: [{ type: 'string' }],
    };
    const request = makeRequest({ tools: [toolWith('merge', parameters)] });

    rewriteChatCompletionsOneOfAsAnyOf(request);

    expect(parameters).not.toHaveProperty('oneOf');
    expect(parameters.anyOf).toEqual([{ type: 'boolean' }, { type: 'string' }]);
  });

  it('handles a request with no tools or response_format', () => {
    const request = makeRequest({});

    expect(() => rewriteChatCompletionsOneOfAsAnyOf(request)).not.toThrow();
  });

  it('does not loop forever on a circular schema', () => {
    const schema: Schema = { type: 'object', oneOf: [] };
    const child: Schema = { type: 'string' };
    schema.properties = { child };
    child.parent = schema;
    const request = makeRequest({ tools: [toolWith('circular', schema)] });

    expect(() => rewriteChatCompletionsOneOfAsAnyOf(request)).not.toThrow();
    expect(schema).not.toHaveProperty('oneOf');
    expect(schema).toHaveProperty('anyOf');
  });
});
