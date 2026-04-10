import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __test as webSearchSdkStub } from 'openclaw/plugin-sdk/provider-web-search';

import { createKiloExaWebSearchProvider } from './kilo-exa-web-search-provider';

const originalEnv = process.env;

function getTool() {
  const provider = createKiloExaWebSearchProvider();
  const tool = provider.createTool({ searchConfig: {} });
  if (!tool) {
    throw new Error('expected kilo-exa provider to create a tool');
  }
  return tool;
}

describe('kilo-exa web search provider', () => {
  beforeEach(() => {
    webSearchSdkStub.reset();
    process.env = { ...originalEnv, KILOCODE_API_KEY: 'kilo-key-123' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('validates freshness values', async () => {
    const tool = getTool();

    const response = await tool.execute({
      query: 'latest ai research',
      freshness: 'hour',
    });

    expect(response).toMatchObject({
      error: 'invalid_freshness',
    });
  });

  it('normalizes uppercase freshness values', async () => {
    webSearchSdkStub.setPostHandler(async () => ({ results: [] }));
    const tool = getTool();

    const response = await tool.execute({
      query: 'latest ai research',
      freshness: ' WEEK ',
    });

    expect(response).not.toHaveProperty('error');
    const call = webSearchSdkStub.getPostCalls()[0];
    expect(typeof call.body.startPublishedDate).toBe('string');
  });

  it('validates contents object shape', async () => {
    const tool = getTool();

    const response = await tool.execute({
      query: 'openclaw',
      contents: {
        unknownField: true,
      },
    });

    expect(response).toMatchObject({
      error: 'invalid_contents',
    });
  });

  it('accepts boolean contents.summary without throwing', async () => {
    webSearchSdkStub.setPostHandler(async () => ({ results: [] }));
    const tool = getTool();

    const response = await tool.execute({
      query: 'Josh Avant',
      count: 5,
      contents: {
        summary: true,
      },
    });

    expect(response).not.toHaveProperty('error');
    const call = webSearchSdkStub.getPostCalls()[0];
    expect(call.body).toMatchObject({
      contents: {
        summary: true,
      },
    });
  });

  it('builds stable cache keys for identical requests', async () => {
    webSearchSdkStub.setPostHandler(async () => ({
      results: [
        {
          title: 'Result A',
          url: 'https://example.com/a',
          highlights: ['first'],
        },
      ],
    }));
    const tool = getTool();

    await tool.execute({ query: 'stable cache key', type: 'neural', count: 3 });
    await tool.execute({ query: 'stable cache key', type: 'neural', count: 3 });

    const keyPartsLog = webSearchSdkStub.getCacheKeyPartsLog();
    expect(keyPartsLog).toHaveLength(2);
    expect(keyPartsLog[0]).toEqual(keyPartsLog[1]);
    expect(webSearchSdkStub.getPostCalls()).toHaveLength(1);
  });

  it.each(['highlights', 'text', 'summary'] as const)(
    'does not collide cache key when contents.%s is false',
    async key => {
      webSearchSdkStub.setPostHandler(async () => ({
        results: [
          {
            title: 'Result A',
            url: 'https://example.com/a',
            highlights: ['first'],
          },
        ],
      }));
      const tool = getTool();

      await tool.execute({ query: 'cache falsy collision check', type: 'neural', count: 3 });
      await tool.execute({
        query: 'cache falsy collision check',
        type: 'neural',
        count: 3,
        contents: {
          [key]: false,
        },
      });

      const keyPartsLog = webSearchSdkStub.getCacheKeyPartsLog();
      expect(keyPartsLog).toHaveLength(2);
      expect(keyPartsLog[0]).not.toEqual(keyPartsLog[1]);
      expect(webSearchSdkStub.getPostCalls()).toHaveLength(2);
    }
  );

  it('uses KILO_API_URL origin and forwards org header when present', async () => {
    process.env.KILO_API_URL = 'https://claw-api.kilo.ai/api/gateway/';
    process.env.KILOCODE_ORGANIZATION_ID = 'org_123';
    webSearchSdkStub.setPostHandler(async () => ({ results: [] }));

    const tool = getTool();
    await tool.execute({ query: 'kilo origin' });

    const call = webSearchSdkStub.getPostCalls()[0];
    expect(call.url).toBe('https://claw-api.kilo.ai/api/exa/search');
    expect(call.apiKey).toBe('kilo-key-123');
    expect(call.extraHeaders).toEqual({
      'X-KiloCode-OrganizationId': 'org_123',
    });
  });

  it('falls back to KILOCODE_API_BASE_URL origin when KILO_API_URL is missing', async () => {
    delete process.env.KILO_API_URL;
    process.env.KILOCODE_API_BASE_URL = 'https://sandbox.kilo.ai/api/gateway/';
    webSearchSdkStub.setPostHandler(async () => ({ results: [] }));

    const tool = getTool();
    await tool.execute({ query: 'fallback base url' });

    const call = webSearchSdkStub.getPostCalls()[0];
    expect(call.url).toBe('https://sandbox.kilo.ai/api/exa/search');
  });

  it('proxies search with bearer auth and returns wrapped result content', async () => {
    webSearchSdkStub.setPostHandler(async () => ({
      results: [
        {
          title: 'Test Title',
          url: 'https://example.com/article',
          publishedDate: '2026-03-01T00:00:00.000Z',
          highlights: ['Key takeaway 1', 'Key takeaway 2'],
          summary: 'Short summary',
          highlightScores: [0.82, 0.76],
        },
      ],
    }));

    const tool = getTool();
    const response = await tool.execute({ query: 'exa proxy smoke test', count: 1 });

    const call = webSearchSdkStub.getPostCalls()[0];
    expect(call.url).toContain('/api/exa/search');
    expect(call.apiKey).toBe('kilo-key-123');
    expect(call.body).toMatchObject({
      query: 'exa proxy smoke test',
      numResults: 1,
    });

    expect(response).toMatchObject({
      provider: 'kilo-exa',
      count: 1,
      externalContent: {
        untrusted: true,
        source: 'web_search',
        provider: 'kilo-exa',
        wrapped: true,
      },
      results: [
        {
          title: '[wrapped:web_search]Test Title',
          url: 'https://example.com/article',
          description: '[wrapped:web_search]Key takeaway 1\nKey takeaway 2',
          summary: '[wrapped:web_search]Short summary',
          siteName: 'example.com',
        },
      ],
    });
  });
});
