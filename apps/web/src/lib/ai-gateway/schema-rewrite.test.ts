import { describe, expect, it } from '@jest/globals';
import {
  rewriteChatCompletionsOneOfAsAnyOf,
  isFriendliChatCompletionsRequest,
} from '@/lib/ai-gateway/schema-rewrite';
import type {
  GatewayRequest,
  OpenRouterChatCompletionRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';

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

function makeGatewayRequest(partial: Record<string, unknown>): GatewayRequest {
  return { kind: 'chat_completions', body: makeRequest(partial) };
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

describe('rewriteChatCompletionsOneOfAsAnyOf logging', () => {
  it('logs once when a oneOf is rewritten', () => {
    const calls: Array<{ message: string; details: unknown }> = [];
    const log = (message: string, details: unknown) => calls.push({ message, details });
    const parameters: Schema = { type: 'object', oneOf: [{ type: 'string' }] };
    const request = makeRequest({ tools: [toolWith('get_weather', parameters)] });

    rewriteChatCompletionsOneOfAsAnyOf(request, log);

    expect(calls).toHaveLength(1);
    expect(calls[0].details).toEqual({
      event: 'ai_gateway_chat_completions_one_of_rewritten',
      model: 'zai/glm-4.6',
      count: 1,
      toolNames: ['get_weather'],
    });
  });

  it('logs once even when multiple schemas across tools are rewritten', () => {
    const calls: unknown[] = [];
    const log = (_message: string, _details: unknown) => calls.push(_details);
    const request = makeRequest({
      tools: [
        toolWith('a', { type: 'object', oneOf: [{ type: 'string' }] }),
        toolWith('a', { type: 'object', oneOf: [{ type: 'integer' }] }),
        toolWith('b', { type: 'object', oneOf: [{ type: 'number' }, { type: 'boolean' }] }),
        toolWith('unchanged', { type: 'object' }),
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'r', schema: { type: 'object', oneOf: [{ type: 'string' }] } },
      } as OpenRouterChatCompletionRequest['response_format'],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request, log);

    expect(calls).toHaveLength(1);
    const details = calls[0] as { count: number; toolNames: string[] };
    expect(details.count).toBe(4);
    expect(details.toolNames).toEqual(['a', 'b']);
  });

  it('does not log when nothing is rewritten', () => {
    const calls: unknown[] = [];
    const log = (_message: string, _details: unknown) => calls.push(_details);
    const request = makeRequest({
      tools: [toolWith('ping', { type: 'object', properties: { host: { type: 'string' } } })],
    });

    rewriteChatCompletionsOneOfAsAnyOf(request, log);

    expect(calls).toHaveLength(0);
  });
});

describe('isFriendliChatCompletionsRequest', () => {
  it('returns true when friendli is in provider.order', () => {
    const request = makeGatewayRequest({ provider: { order: ['friendli', 'novita'] } });

    expect(isFriendliChatCompletionsRequest(request)).toBe(true);
  });

  it('returns true when friendli is not the first entry', () => {
    const request = makeGatewayRequest({ provider: { order: ['novita', 'friendli'] } });

    expect(isFriendliChatCompletionsRequest(request)).toBe(true);
  });

  it('returns false when friendli is absent from provider.order', () => {
    const request = makeGatewayRequest({ provider: { order: ['novita', 'z-ai'] } });

    expect(isFriendliChatCompletionsRequest(request)).toBe(false);
  });

  it('returns false when there is no provider config', () => {
    const request = makeGatewayRequest({});

    expect(isFriendliChatCompletionsRequest(request)).toBe(false);
  });

  it('returns false when provider has no order', () => {
    const request = makeGatewayRequest({ provider: { only: ['friendli'] } });

    expect(isFriendliChatCompletionsRequest(request)).toBe(false);
  });

  it('returns false for non-chat-completions requests', () => {
    const request: GatewayRequest = {
      kind: 'responses',
      body: { model: 'zai/glm-4.6', input: '' },
    } as GatewayRequest;

    expect(isFriendliChatCompletionsRequest(request)).toBe(false);
  });

  it('narrows the request body type when true', () => {
    const request = makeGatewayRequest({ provider: { order: ['friendli'] } });

    if (isFriendliChatCompletionsRequest(request)) {
      expect(request.body.provider?.order).toEqual(['friendli']);
    } else {
      throw new Error('expected narrowing to succeed');
    }
  });
});
