import { describe, expect, it } from 'vitest';
import {
  fetchKiloOrganizations,
  fetchKiloGatewayModels,
  parseKiloGatewayModelsResponse,
  parseKiloOrganizationsResponse,
  thinkingEffortLabel,
} from './kilo-api-client';
import type { FetchLike } from './auth';

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, {
    ...init,
  });

const firstRequest = <Request>(requests: Request[]): Request => {
  const [request] = requests;

  if (request === undefined) {
    throw new Error('Expected request to be captured.');
  }

  return request;
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
        organizationId: 'org-1',
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
    const request = firstRequest(seen);
    expect(request.input).toBe('https://app.kilo.ai/api/gateway/models');
    expect(Object.fromEntries(request.headers.entries())).toMatchObject({
      accept: 'application/json',
      authorization: 'Bearer token-1',
      'x-kilocode-organizationid': 'org-1',
    });
  });

  it('fetches organizations with bearer auth', async () => {
    const seen: { headers: Headers; input: string }[] = [];
    const fetch: FetchLike = (input, init) => {
      seen.push({ headers: new Headers(init?.headers), input: String(input) });
      return jsonResponse({
        organizations: [
          { id: 'org-1', name: 'Acme' },
          { id: 'org-2', name: 'Kilo' },
        ],
      });
    };

    await expect(
      fetchKiloOrganizations({
        apiBaseUrl: 'https://app.kilo.ai/',
        fetch,
        token: 'token-1',
      })
    ).resolves.toStrictEqual([
      { id: 'org-1', name: 'Acme' },
      { id: 'org-2', name: 'Kilo' },
    ]);
    expect(seen[0]?.input).toBe('https://app.kilo.ai/api/organizations');
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
            architecture: { input_modalities: ['text', 'image'] },
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
        supportsImages: true,
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

  it('parses organizations and drops malformed entries', () => {
    expect(
      parseKiloOrganizationsResponse({
        organizations: [
          { id: 'org-1', name: 'Acme' },
          { id: '', name: 'Nope' },
          { id: 'org-2', name: '' },
          { id: 'org-3', name: 'Kilo' },
        ],
      })
    ).toStrictEqual([
      { id: 'org-1', name: 'Acme' },
      { id: 'org-3', name: 'Kilo' },
    ]);
    expect(() => parseKiloOrganizationsResponse({ organizations: {} })).toThrow(
      'Organizations response did not include a list.'
    );
  });

  it('labels thinking efforts compactly', () => {
    expect(thinkingEffortLabel('medium')).toBe('Med');
    expect(thinkingEffortLabel('xhigh')).toBe('XHigh');
    expect(thinkingEffortLabel('minimal')).toBe('Min');
    expect(thinkingEffortLabel('instant')).toBe('Instant');
  });
});
