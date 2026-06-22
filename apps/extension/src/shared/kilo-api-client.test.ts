import { describe, expect, it } from 'vitest';
import {
  fetchKiloGatewayChatCompletion,
  fetchKiloGatewayModels,
  parseKiloGatewayChatCompletionResponse,
  parseKiloGatewayModelsResponse,
  thinkingEffortLabel,
} from './kilo-api-client';
import type { FetchLike } from './auth';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, {
    ...init,
  });

const parseJsonRequestBody = (body: BodyInit | null | undefined): unknown => {
  if (typeof body !== 'string') {
    throw new TypeError('Expected JSON string request body.');
  }

  return JSON.parse(body);
};

describe('kilo API client', () => {
  it('fetches gateway models with bearer auth', async () => {
    const seen: { headers: Headers; input: string }[] = [];
    const fetch: FetchLike = (input, init) => {
      seen.push({ headers: new Headers(init?.headers), input: String(input) });
      return jsonResponse({
        data: [
          {
            id: 'anthropic/claude-sonnet-4',
            name: 'Anthropic: Claude Sonnet 4',
            opencode: { variants: { high: {}, low: {}, medium: {} } },
            preferredIndex: 0,
          },
        ],
      });
    };

    await expect(
      fetchKiloGatewayModels({
        apiBaseUrl: 'https://app.kilo.ai/',
        fetch,
        token: 'token-1',
      })
    ).resolves.toStrictEqual([
      {
        id: 'anthropic/claude-sonnet-4',
        isPreferred: true,
        name: 'Claude Sonnet 4',
        variants: ['high', 'low', 'medium'],
      },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.input).toBe('https://app.kilo.ai/api/gateway/models');
    expect(seen[0]?.headers.get('accept')).toBe('application/json');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer token-1');
  });

  it('parses gateway models into sorted picker options', () => {
    expect(
      parseKiloGatewayModelsResponse({
        data: [
          {
            id: 'z-model',
            name: 'Provider: Z Model',
            opencode: { variants: { high: {}, low: {} } },
          },
          {
            id: 'preferred-2',
            name: 'Provider: Preferred Two',
            preferredIndex: 2,
          },
          {
            id: 'preferred-1',
            name: 'Provider: Preferred One',
            opencode: { variants: { medium: {}, minimal: {}, xhigh: {} } },
            preferredIndex: 1,
          },
          {
            id: 'a-model',
            name: 'A Model',
          },
          {
            id: '',
            name: 'Ignored Model',
          },
        ],
      })
    ).toStrictEqual([
      {
        id: 'preferred-1',
        isPreferred: true,
        name: 'Preferred One',
        variants: ['medium', 'minimal', 'xhigh'],
      },
      {
        id: 'preferred-2',
        isPreferred: true,
        name: 'Preferred Two',
        variants: [],
      },
      {
        id: 'a-model',
        isPreferred: false,
        name: 'A Model',
        variants: [],
      },
      {
        id: 'z-model',
        isPreferred: false,
        name: 'Z Model',
        variants: ['high', 'low'],
      },
    ]);
  });

  it('rejects malformed model responses', () => {
    expect(() => parseKiloGatewayModelsResponse({ data: {} })).toThrow(
      'Gateway models response did not include a model list.'
    );
  });

  it('fetches chat completions with eval tools and bearer auth', async () => {
    const seen: { body: unknown; headers: Headers; input: string; method: string | undefined }[] =
      [];
    const fetch: FetchLike = (input, init) => {
      seen.push({
        body: parseJsonRequestBody(init?.body),
        headers: new Headers(init?.headers),
        input: String(input),
        method: init?.method,
      });

      return jsonResponse({
        choices: [
          {
            message: {
              content: 'I will inspect the page.',
              role: 'assistant',
              tool_calls: [
                {
                  function: {
                    arguments: '{"code":"return document.documentElement.outerHTML.length;"}',
                    name: 'eval',
                  },
                  id: 'call_eval_1',
                  type: 'function',
                },
              ],
            },
          },
        ],
      });
    };

    await expect(
      fetchKiloGatewayChatCompletion({
        apiBaseUrl: 'https://app.kilo.ai/',
        fetch,
        messages: [{ content: 'Inspect this page', role: 'user' }],
        model: 'anthropic/claude-sonnet-4',
        token: 'token-1',
        tools: [
          {
            function: {
              description: 'Run JavaScript',
              name: 'eval',
              parameters: { additionalProperties: false, type: 'object' },
            },
            type: 'function',
          },
        ],
      })
    ).resolves.toStrictEqual({
      content: 'I will inspect the page.',
      toolCalls: [
        {
          code: 'return document.documentElement.outerHTML.length;',
          id: 'call_eval_1',
          name: 'eval',
        },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      input: 'https://app.kilo.ai/api/gateway/v1/chat/completions',
      method: 'POST',
    });
    expect({
      accept: seen[0]?.headers.get('accept'),
      authorization: seen[0]?.headers.get('authorization'),
      contentType: seen[0]?.headers.get('content-type'),
    }).toStrictEqual({
      accept: 'application/json',
      authorization: 'Bearer token-1',
      contentType: 'application/json',
    });
    expect(seen[0]?.body).toStrictEqual({
      messages: [{ content: 'Inspect this page', role: 'user' }],
      model: 'anthropic/claude-sonnet-4',
      temperature: 0,
      tool_choice: 'auto',
      tools: [
        {
          function: {
            description: 'Run JavaScript',
            name: 'eval',
            parameters: { additionalProperties: false, type: 'object' },
          },
          type: 'function',
        },
      ],
    });
  });

  it('rejects malformed eval tool calls', () => {
    expect(() =>
      parseKiloGatewayChatCompletionResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  function: {
                    arguments: '{"code":7}',
                    name: 'eval',
                  },
                  id: 'call_eval_1',
                  type: 'function',
                },
              ],
            },
          },
        ],
      })
    ).toThrow('Gateway eval tool call did not include code.');
  });

  it('labels thinking efforts compactly', () => {
    expect(thinkingEffortLabel('medium')).toBe('Med');
    expect(thinkingEffortLabel('xhigh')).toBe('XHigh');
    expect(thinkingEffortLabel('minimal')).toBe('Min');
    expect(thinkingEffortLabel('instant')).toBe('Instant');
  });
});
