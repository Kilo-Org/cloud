import { describe, expect, it } from 'vitest';
import {
  fetchKiloGatewayModels,
  parseKiloGatewayModelsResponse,
  thinkingEffortLabel,
} from './kilo-api-client';
import type { FetchLike } from './auth';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, {
    ...init,
  });

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

  it('labels thinking efforts compactly', () => {
    expect(thinkingEffortLabel('medium')).toBe('Med');
    expect(thinkingEffortLabel('xhigh')).toBe('XHigh');
    expect(thinkingEffortLabel('minimal')).toBe('Min');
    expect(thinkingEffortLabel('instant')).toBe('Instant');
  });
});
