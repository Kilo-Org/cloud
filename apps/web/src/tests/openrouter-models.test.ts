import { test, expect, describe, afterEach, beforeEach } from '@jest/globals';
import { mockOpenRouterModels, createMockResponse } from './helpers/openrouter-models.helper';
import { GET } from '../app/api/openrouter/models/route';
import { GET as gatewayV1ModelsGET } from '../app/api/gateway/v1/models/route';
import { GET as transcriptionModelsGET } from '../app/api/gateway/transcription-models/route';
import { getRawOpenRouterModels } from '@/lib/ai-gateway/providers/openrouter';
import { NextRequest } from 'next/server';
import { OpenRouterModelsResponseSchema } from '@/lib/organizations/organization-types';
import { getEnkryptBenchmarks } from '@/lib/model-stats/enkrypt';
import { fingerprintEnkryptScore } from '@/lib/model-stats/enkrypt-fingerprint';
import type * as Enkrypt from '@/lib/model-stats/enkrypt';
import type * as GatewayModelsCache from '@/lib/ai-gateway/providers/gateway-models-cache';
import type * as Byok from '@/lib/ai-gateway/byok';
import { getTerminalBenchSummaries } from '@/lib/model-stats/terminal-bench';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { AUTO_MODELS } from '@/lib/ai-gateway/auto-model';
import type { EnkryptBenchmark } from '@kilocode/db/schema-types';
import { captureException } from '@sentry/nextjs';

import type * as Config from '@/lib/config.server';

let mockPublicationEnabled = true;

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<typeof Config>('@/lib/config.server'),
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
  ENKRYPT_SYNC_ENABLED: false,
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: jest.fn(async () => ({
    user: { id: 'test-user-id' },
    organizationId: null,
  })),
}));

jest.mock('@/lib/redis', () => ({
  redisClient: { get: jest.fn(async () => null) },
}));

jest.mock('@/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual<typeof GatewayModelsCache>(
    '@/lib/ai-gateway/providers/gateway-models-cache'
  ),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(async () => ({})),
  getVercelModelsMetadataFromDatabase: jest.fn(async () => ({})),
}));

jest.mock('@/lib/ai-gateway/byok', () => ({
  ...jest.requireActual<typeof Byok>('@/lib/ai-gateway/byok'),
  getBYOKforUser: jest.fn(async () => null),
  getUserByokProviderIds: jest.fn(async () => []),
}));

jest.mock('@/lib/ai-gateway/experiments/list-available-experiment-models', () => ({
  listAvailableExperimentModels: jest.fn(async () => []),
}));

jest.mock('@/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getBenchmarkRoutingTable: jest.fn(async () => ({ status: 200, body: { table: null } })),
}));

jest.mock('@/lib/model-stats/terminal-bench', () => ({
  getTerminalBenchSummaries: jest.fn(
    async () => new Map([['some-other-model', { overallScore: 0.551, avgAttemptCostUsd: 53.37 }]])
  ),
  terminalBenchFor: jest.fn((summaries: Map<string, unknown>, id: string) => summaries.get(id)),
}));

jest.mock('@/lib/model-stats/enkrypt', () => ({
  ...jest.requireActual<typeof Enkrypt>('@/lib/model-stats/enkrypt'),
  getEnkryptBenchmarks: jest.fn(async () => new Map()),
}));

const enkryptBenchmark: EnkryptBenchmark = {
  model_name: 'Other Model',
  provider: 'Example Provider',
  source: 'Enkrypt AI',
  risk_score: 0,
  bias_score: null,
  safety_score: 87.5,
  ingestedAt: '2026-08-27T00:00:00.000Z',
  evaluatedAt: null,
};
const publishedEnkryptBenchmark = {
  ...enkryptBenchmark,
  lastCheckedAt: enkryptBenchmark.ingestedAt,
  staleAfter: '2026-08-28T02:00:00.000Z',
  freshness: 'fresh',
};

function createTestRequest(path: string) {
  return new NextRequest(new URL(path, 'http://localhost:3000'), {
    method: 'GET',
  });
}

const originalFetch = global.fetch;

beforeEach(() => {
  mockPublicationEnabled = true;
  jest.clearAllMocks();
  jest.mocked(getEnkryptBenchmarks).mockResolvedValue(new Map());
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(enkryptBenchmark.ingestedAt));
});

describe('GET /api/openrouter/models', () => {
  test('should handle OpenRouter API errors', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          jsonData: { error: 'OpenRouter API Error' },
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();

    expect(response.status).toBe(500);
    expect(responseData.error).toBe('Failed to fetch models');
    expect(responseData.message).toBe('Error from OpenRouter API');
  });

  test('should handle unexpected response format', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: { unexpected: 'format' },
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();

    expect(response.status).toBe(200);
    expect(responseData.unexpected).toBe('format');
  });

  test('should include defaultModel field in response', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: mockOpenRouterModels,
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();

    expect(captureException).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(responseData.data).toBeDefined();
    expect(Array.isArray(responseData.data)).toBe(true);
  });

  test('should include publishable Terminal Bench summaries for canonical models', async () => {
    const request = createTestRequest('/api/openrouter/models');

    global.fetch = jest.fn(() => {
      return Promise.resolve(
        createMockResponse({
          ok: true,
          status: 200,
          statusText: 'OK',
          jsonData: mockOpenRouterModels,
        })
      );
    }) as unknown as typeof fetch;

    const response = await GET(request);
    const responseData = await response.json();
    const model = responseData.data.find((item: { id: string }) => item.id === 'some-other-model');

    expect(response.status).toBe(200);
    expect(model.terminalBench).toEqual({ overallScore: 0.551, avgAttemptCostUsd: 53.37 });
  });

  test('retains Enkrypt scores in the response schema without changing Terminal Bench', async () => {
    jest
      .mocked(getEnkryptBenchmarks)
      .mockResolvedValueOnce(new Map([['some-other-model', enkryptBenchmark]]));
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));

    const response = await GET(createTestRequest('/api/openrouter/models'));
    const responseData = OpenRouterModelsResponseSchema.parse(await response.json());
    const model = responseData.data.find(item => item.id === 'some-other-model');

    expect(response.status).toBe(200);
    expect(model?.enkrypt).toEqual(publishedEnkryptBenchmark);
    expect(model?.terminalBench).toEqual({ overallScore: 0.551, avgAttemptCostUsd: 53.37 });
    expect(model?.enkrypt).not.toHaveProperty('toxicity_score');
  });

  test('includes Enkrypt scores even when Terminal Bench has no publishable summary', async () => {
    jest
      .mocked(getEnkryptBenchmarks)
      .mockResolvedValueOnce(new Map([['some-other-model', enkryptBenchmark]]));
    jest.mocked(getTerminalBenchSummaries).mockResolvedValueOnce(new Map());
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));

    const response = await GET(createTestRequest('/api/openrouter/models'));
    const responseData = OpenRouterModelsResponseSchema.parse(await response.json());
    const model = responseData.data.find(item => item.id === 'some-other-model');

    expect(response.status).toBe(200);
    expect(model?.enkrypt).toEqual(publishedEnkryptBenchmark);
    expect(model).not.toHaveProperty('terminalBench');
  });

  test('enriches public Kilo-exclusive models but not virtual catalog entries', async () => {
    const exclusiveModel = kiloExclusiveModels.find(model => model.status === 'public');
    if (!exclusiveModel) throw new Error('Expected a public Kilo-exclusive model fixture');
    const exclusiveBenchmark = { ...enkryptBenchmark, model_name: exclusiveModel.display_name };
    jest
      .mocked(getEnkryptBenchmarks)
      .mockResolvedValueOnce(
        new Map([
          [exclusiveModel.public_id, exclusiveBenchmark],
          ...AUTO_MODELS.map(model => [model.id, enkryptBenchmark] as const),
          ['kilo-internal/custom', enkryptBenchmark],
          ['byok/openai/model', enkryptBenchmark],
        ])
      );
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));

    const response = await GET(createTestRequest('/api/openrouter/models'));
    const responseData = OpenRouterModelsResponseSchema.parse(await response.json());
    const model = responseData.data.find(item => item.id === exclusiveModel.public_id);
    const virtualModels = responseData.data.filter(item => item.id.startsWith('kilo-auto/'));

    expect(response.status).toBe(200);
    expect(model?.enkrypt).toEqual({
      ...publishedEnkryptBenchmark,
      model_name: exclusiveBenchmark.model_name,
    });
    expect(virtualModels.length).toBeGreaterThan(0);
    for (const virtualModel of virtualModels) {
      expect(virtualModel).not.toHaveProperty('enkrypt');
    }
    expect(responseData.data.some(item => item.id === 'kilo-internal/custom')).toBe(false);
    expect(responseData.data.some(item => item.id === 'byok/openai/model')).toBe(false);
  });

  test('omits the Enkrypt field when no score is available', async () => {
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));

    const response = await GET(createTestRequest('/api/openrouter/models'));
    const responseData = OpenRouterModelsResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(responseData.data.length).toBeGreaterThan(0);
    for (const model of responseData.data) {
      expect(model).not.toHaveProperty('enkrypt');
    }
  });
});

describe('GET /api/gateway/v1/models', () => {
  test('uses the OpenRouter models handler', () => {
    expect(gatewayV1ModelsGET).toBe(GET);
  });

  test('retains Enkrypt and Terminal Bench in the gateway catalog response', async () => {
    jest
      .mocked(getEnkryptBenchmarks)
      .mockResolvedValueOnce(new Map([['some-other-model', enkryptBenchmark]]));
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));

    const response = await gatewayV1ModelsGET(createTestRequest('/api/gateway/v1/models'));

    expect(captureException).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    const responseData = OpenRouterModelsResponseSchema.parse(await response.json());
    const model = responseData.data.find(item => item.id === 'some-other-model');
    expect(model?.enkrypt).toEqual(publishedEnkryptBenchmark);
    expect(model?.terminalBench).toEqual({ overallScore: 0.551, avgAttemptCostUsd: 53.37 });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('Enkrypt catalog publication boundaries', () => {
  test.each([
    ['/api/openrouter/models', GET],
    ['/api/gateway/v1/models', gatewayV1ModelsGET],
  ])(
    'withholds cached and raw upstream scores at %s when publication is disabled',
    async (path, handler) => {
      mockPublicationEnabled = false;
      jest
        .mocked(getEnkryptBenchmarks)
        .mockResolvedValue(
          new Map([
            ['some-other-model', enkryptBenchmark],
            ...kiloExclusiveModels.map(model => [model.public_id, enkryptBenchmark] as const),
          ])
        );
      const upstream = {
        data: mockOpenRouterModels.data.map(model => ({
          ...model,
          enkrypt: publishedEnkryptBenchmark,
        })),
      };
      global.fetch = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(createMockResponse({ jsonData: upstream }));

      const response = await handler(createTestRequest(path));
      const data = OpenRouterModelsResponseSchema.parse(await response.json());
      expect(response.status).toBe(200);
      expect(data.data.length).toBeGreaterThan(0);
      for (const model of data.data) expect(model).not.toHaveProperty('enkrypt');
      expect(data.data.find(model => model.id === 'some-other-model')?.terminalBench).toEqual({
        overallScore: 0.551,
        avgAttemptCostUsd: 53.37,
      });
      expect(upstream.data[0].enkrypt).toEqual(publishedEnkryptBenchmark);
    }
  );

  test.each([true, false])(
    'never trusts raw upstream scores with publication %s',
    async enabled => {
      mockPublicationEnabled = enabled;
      const upstream = {
        data: mockOpenRouterModels.data.map(model => ({ ...model, enkrypt: { untrusted: true } })),
      };
      global.fetch = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(createMockResponse({ jsonData: upstream }));

      const raw = await getRawOpenRouterModels();
      const catalog = await GET(createTestRequest('/api/openrouter/models'));
      const transcription = await transcriptionModelsGET();
      expect(catalog.status).toBe(200);
      expect(transcription.status).toBe(200);
      for (const response of [raw, await catalog.json(), await transcription.json()]) {
        const data = OpenRouterModelsResponseSchema.parse(response);
        for (const model of data.data) expect(model).not.toHaveProperty('enkrypt');
      }
      expect(upstream.data[0].enkrypt).toEqual({ untrusted: true });
    }
  );

  test('removes raw scores even when unrelated schema validation fails', async () => {
    mockPublicationEnabled = false;
    const upstream = {
      data: [{ id: 'provider/invalid', enkrypt: publishedEnkryptBenchmark, unrelated: 'retained' }],
    };
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: upstream }));
    expect(await getRawOpenRouterModels()).toEqual({
      data: [{ id: 'provider/invalid', unrelated: 'retained' }],
    });
    const transcription = await transcriptionModelsGET();
    expect(transcription.status).toBe(200);
    expect(await transcription.json()).toEqual({
      data: [{ id: 'provider/invalid', unrelated: 'retained' }],
    });
    expect(upstream.data[0].enkrypt).toEqual(publishedEnkryptBenchmark);
  });

  test('recomputes freshness and the kill switch on each response from the same cached snapshot', async () => {
    const cached = new Map([['some-other-model', enkryptBenchmark]]);
    jest.mocked(getEnkryptBenchmarks).mockResolvedValue(cached);
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));
    const staleAfter = Date.parse(publishedEnkryptBenchmark.staleAfter);
    jest.mocked(Date.now).mockReturnValue(staleAfter - 1);
    const freshResponse = await GET(createTestRequest('/api/openrouter/models'));
    const fresh = OpenRouterModelsResponseSchema.parse(await freshResponse.json());
    expect(fresh.data.find(model => model.id === 'some-other-model')?.enkrypt).toEqual(
      publishedEnkryptBenchmark
    );

    jest.mocked(Date.now).mockReturnValue(staleAfter);
    const staleResponse = await gatewayV1ModelsGET(createTestRequest('/api/gateway/v1/models'));
    const stale = OpenRouterModelsResponseSchema.parse(await staleResponse.json());
    expect(stale.data.find(model => model.id === 'some-other-model')?.enkrypt).toEqual({
      ...publishedEnkryptBenchmark,
      freshness: 'stale',
    });

    mockPublicationEnabled = false;
    const disabledResponse = await GET(createTestRequest('/api/openrouter/models'));
    const disabled = OpenRouterModelsResponseSchema.parse(await disabledResponse.json());
    for (const model of disabled.data) expect(model).not.toHaveProperty('enkrypt');
    expect(cached.get('some-other-model')).toEqual(enkryptBenchmark);
  });

  test.each([
    ['/api/openrouter/models', GET],
    ['/api/gateway/v1/models', gatewayV1ModelsGET],
  ])(
    'retains verified lastCheckedAt in the %s schema without leaking server metadata',
    async (path, handler) => {
      const checkedAt = '2026-08-30T00:00:00.000Z';
      const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(enkryptBenchmark) };
      const snapshot = Object.freeze({ ...enkryptBenchmark, verification });
      jest
        .mocked(getEnkryptBenchmarks)
        .mockResolvedValue(new Map([['some-other-model', snapshot]]));
      global.fetch = jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));
      const checked = {
        ...publishedEnkryptBenchmark,
        lastCheckedAt: checkedAt,
        staleAfter: '2026-08-31T02:00:00.000Z',
      };
      jest.mocked(Date.now).mockReturnValue(Date.parse(checked.staleAfter) - 1);
      const response = await handler(createTestRequest(path));
      expect(response.status).toBe(200);
      const raw = await response.json();
      expect(JSON.stringify(raw)).not.toContain(verification.scoreHash);
      const model = OpenRouterModelsResponseSchema.parse(raw).data.find(
        item => item.id === 'some-other-model'
      );
      expect(model?.enkrypt).toEqual(checked);
      expect(model?.enkrypt).not.toHaveProperty('verification');
      expect(model?.terminalBench).toEqual({ overallScore: 0.551, avgAttemptCostUsd: 53.37 });
      expect(getEnkryptBenchmarks).toHaveBeenCalledTimes(1);

      jest.mocked(Date.now).mockReturnValue(Date.parse(checked.staleAfter));
      const stale = OpenRouterModelsResponseSchema.parse(
        await (await handler(createTestRequest(path))).json()
      );
      expect(stale.data.find(item => item.id === 'some-other-model')?.enkrypt).toEqual({
        ...checked,
        freshness: 'stale',
      });
      mockPublicationEnabled = false;
      const disabled = OpenRouterModelsResponseSchema.parse(
        await (await handler(createTestRequest(path))).json()
      );
      expect(disabled.data.find(item => item.id === 'some-other-model')).not.toHaveProperty(
        'enkrypt'
      );
      expect(snapshot).toEqual({ ...enkryptBenchmark, verification });
    }
  );

  test('withholds future snapshots and preserves missing upstream source', async () => {
    const withoutSource = { ...enkryptBenchmark };
    delete withoutSource.source;
    jest
      .mocked(getEnkryptBenchmarks)
      .mockResolvedValue(new Map([['some-other-model', withoutSource]]));
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));
    const response = await GET(createTestRequest('/api/openrouter/models'));
    const data = OpenRouterModelsResponseSchema.parse(await response.json());
    const published = data.data.find(model => model.id === 'some-other-model')?.enkrypt;
    expect(published).toBeDefined();
    expect(published).not.toHaveProperty('source');

    jest.mocked(Date.now).mockReturnValue(Date.parse(enkryptBenchmark.ingestedAt) - 1);
    const futureResponse = await GET(createTestRequest('/api/openrouter/models'));
    const future = OpenRouterModelsResponseSchema.parse(await futureResponse.json());
    for (const model of future.data) expect(model).not.toHaveProperty('enkrypt');
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});
