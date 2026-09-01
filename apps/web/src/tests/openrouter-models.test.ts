import { test, expect, describe, afterEach, beforeEach } from '@jest/globals';
import { mockOpenRouterModels, createMockResponse } from './helpers/openrouter-models.helper';
import { GET } from '../app/api/openrouter/models/route';
import { GET as gatewayV1ModelsGET } from '../app/api/gateway/v1/models/route';
import { GET as transcriptionModelsGET } from '../app/api/gateway/transcription-models/route';
import {
  getEnhancedOpenRouterModels,
  getRawOpenRouterModels,
} from '@/lib/ai-gateway/providers/openrouter';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import type * as FreeModel from '@/lib/ai-gateway/is-free-model';
import { getGatewayOpenCodeSettings } from '@/lib/ai-gateway/providers/model-settings';
import type * as ModelSettings from '@/lib/ai-gateway/providers/model-settings';
import { addAutoRoutingModels } from '@/lib/ai-gateway/auto-routing-models';
import type * as AutoRouting from '@/lib/ai-gateway/auto-routing-models';
import { addUserByokAvailability, getUserByokProviderIds } from '@/lib/ai-gateway/byok';
import { listAvailableExperimentModels } from '@/lib/ai-gateway/experiments/list-available-experiment-models';
import { getAvailableModelsForOrganization } from '@/lib/organizations/organization-models';
import { getDirectByokModelsForUser } from '@/lib/ai-gateway/providers/direct-byok';
import type * as DirectByok from '@/lib/ai-gateway/providers/direct-byok';
import { getEnkryptBenchmarks } from '@/lib/model-stats/enkrypt';
import type { OpenRouterModelsResponse } from '@/lib/organizations/organization-types';
import { NextRequest } from 'next/server';
import { OpenRouterModelsResponseSchema } from '@/lib/organizations/organization-types';
import { invalidateModelStatsCache } from '@/lib/model-stats/model-stats-cache';
import { fingerprintEnkryptScore } from '@/lib/model-stats/enkrypt-fingerprint';
import type { ModelStats } from '@kilocode/db/schema';
import { GET as statsGET } from '@/app/api/models/stats/route';
import { GET as statGET } from '@/app/api/models/stats/[slug]/route';
import type * as GatewayModelsCache from '@/lib/ai-gateway/providers/gateway-models-cache';
import type * as Byok from '@/lib/ai-gateway/byok';
import { getTerminalBenchSummaries } from '@/lib/model-stats/terminal-bench';
import { kiloExclusiveModels } from '@/lib/ai-gateway/models';
import { AUTO_MODELS } from '@/lib/ai-gateway/auto-model';
import type { EnkryptBenchmark, EnkryptPublishedBenchmark } from '@kilocode/db/schema-types';
import { captureException } from '@sentry/nextjs';

let mockPublicationEnabled = true;
let mockAuth: { user: { id: string } | null; organizationId: string | null };
const mockRows = jest.fn<
  Promise<ReadonlyMap<string, EnkryptBenchmark & { verification?: unknown; isStealth?: boolean }>>,
  []
>();

jest.mock('@/lib/dotenvx', () => ({
  getEnvVariable: () => '',
  requireEnv: () => 'http://localhost',
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => {
      const orderBy = async () =>
        [...(await mockRows())].map(([id, benchmark]) => ({
          stat: {
            id,
            openrouterId: id,
            slug: id,
            name: id,
            isActive: true,
            isStealth: benchmark.isStealth ?? false,
            benchmarks: { enkrypt: benchmark },
            openrouterData: {},
          } as ModelStats,
          verification: benchmark.verification,
        }));
      return { from: () => ({ orderBy, leftJoin: () => ({ orderBy }) }) };
    }),
  },
  readDb: {},
}));

jest.mock('@/lib/config.server', () => ({
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
  getUserFromAuth: jest.fn(async () => mockAuth),
}));

jest.mock('@/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/is-free-model', () => {
  const actual = jest.requireActual<typeof FreeModel>('@/lib/ai-gateway/is-free-model');
  return { ...actual, isFreeModel: jest.fn(actual.isFreeModel) };
});

jest.mock('@/lib/ai-gateway/providers/model-settings', () => {
  const actual = jest.requireActual<typeof ModelSettings>(
    '@/lib/ai-gateway/providers/model-settings'
  );
  return { ...actual, getGatewayOpenCodeSettings: jest.fn(actual.getGatewayOpenCodeSettings) };
});

jest.mock('@/lib/ai-gateway/auto-routing-models', () => {
  const actual = jest.requireActual<typeof AutoRouting>('@/lib/ai-gateway/auto-routing-models');
  return { ...actual, addAutoRoutingModels: jest.fn(actual.addAutoRoutingModels) };
});

jest.mock('@/lib/ai-gateway/providers/direct-byok', () => {
  const actual = jest.requireActual<typeof DirectByok>('@/lib/ai-gateway/providers/direct-byok');
  return { ...actual, getDirectByokModelsForUser: jest.fn(actual.getDirectByokModelsForUser) };
});

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

jest.mock('@/lib/ai-gateway/byok', () => {
  const actual = jest.requireActual<typeof Byok>('@/lib/ai-gateway/byok');
  return {
    ...actual,
    addUserByokAvailability: jest.fn(actual.addUserByokAvailability),
    getBYOKforUser: jest.fn(async () => null),
    getUserByokProviderIds: jest.fn(async () => []),
  };
});

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
const publishedEnkryptBenchmark: EnkryptPublishedBenchmark = {
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
const realFreeModel = jest.requireActual<typeof FreeModel>('@/lib/ai-gateway/is-free-model');
const realModelSettings = jest.requireActual<typeof ModelSettings>(
  '@/lib/ai-gateway/providers/model-settings'
);
const realAutoRouting = jest.requireActual<typeof AutoRouting>(
  '@/lib/ai-gateway/auto-routing-models'
);
const realByok = jest.requireActual<typeof Byok>('@/lib/ai-gateway/byok');
const realDirectByok = jest.requireActual<typeof DirectByok>(
  '@/lib/ai-gateway/providers/direct-byok'
);

beforeEach(() => {
  mockPublicationEnabled = true;
  mockAuth = { user: { id: 'test-user-id' }, organizationId: null };
  jest.clearAllMocks();
  jest.mocked(isFreeModel).mockReset().mockImplementation(realFreeModel.isFreeModel);
  jest
    .mocked(getGatewayOpenCodeSettings)
    .mockReset()
    .mockImplementation(realModelSettings.getGatewayOpenCodeSettings);
  jest
    .mocked(addAutoRoutingModels)
    .mockReset()
    .mockImplementation(realAutoRouting.addAutoRoutingModels);
  jest
    .mocked(addUserByokAvailability)
    .mockReset()
    .mockImplementation(realByok.addUserByokAvailability);
  jest
    .mocked(getDirectByokModelsForUser)
    .mockReset()
    .mockImplementation(realDirectByok.getDirectByokModelsForUser);
  jest.mocked(getUserByokProviderIds).mockReset().mockResolvedValue([]);
  jest.mocked(getAvailableModelsForOrganization).mockReset().mockResolvedValue(null);
  jest.mocked(listAvailableExperimentModels).mockReset().mockResolvedValue([]);
  invalidateModelStatsCache();
  mockRows.mockReset().mockResolvedValue(new Map());
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(enkryptBenchmark.ingestedAt));
  jest.spyOn(console, 'error').mockImplementation(() => {});
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
    jest.mocked(mockRows).mockResolvedValueOnce(new Map([['some-other-model', enkryptBenchmark]]));
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
    jest.mocked(mockRows).mockResolvedValueOnce(new Map([['some-other-model', enkryptBenchmark]]));
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
      .mocked(mockRows)
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
    jest.mocked(mockRows).mockResolvedValueOnce(new Map([['some-other-model', enkryptBenchmark]]));
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
        .mocked(mockRows)
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
    jest.mocked(mockRows).mockResolvedValue(cached);
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
      jest.mocked(mockRows).mockResolvedValue(new Map([['some-other-model', snapshot]]));
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
      expect(mockRows).toHaveBeenCalledTimes(1);

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
    jest.mocked(mockRows).mockResolvedValue(new Map([['some-other-model', withoutSource]]));
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

describe('shared stats and catalog snapshot', () => {
  function listStats() {
    return statsGET(createTestRequest('/api/models/stats'));
  }

  function detailStats(slug = 'some-other-model') {
    return statGET(createTestRequest('/api/models/stats/model'), {
      params: Promise.resolve({ slug }),
    });
  }

  function catalog() {
    return GET(createTestRequest('/api/openrouter/models'));
  }

  beforeEach(() => {
    mockRows.mockResolvedValue(new Map([['some-other-model', enkryptBenchmark]]));
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));
  });

  test('uses one real cache load for concurrent and sequential list, detail, and catalog responses', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => Promise.all([listStats(), detailStats(), catalog()]))
    );
    for (const [all, one, catalogResponse] of responses) {
      expect((await all.json())[0].benchmarks.enkrypt).toEqual(publishedEnkryptBenchmark);
      expect((await one.json()).benchmarks.enkrypt).toEqual(publishedEnkryptBenchmark);
      const data = OpenRouterModelsResponseSchema.parse(await catalogResponse.json());
      expect(data.data.find(model => model.id === 'some-other-model')?.enkrypt).toEqual(
        publishedEnkryptBenchmark
      );
    }
    for (let i = 0; i < 20; i++) await Promise.all([listStats(), detailStats(), catalog()]);
    const missing = await Promise.all(
      Array.from({ length: 100 }, (_, i) => detailStats(`missing-${i}`))
    );
    expect(missing.every(response => response.status === 404)).toBe(true);
    expect(mockRows).toHaveBeenCalledTimes(1);
  });

  test('withholds expired eligibility in both stats and catalogs on repeated refresh failures', async () => {
    await catalog();
    jest.mocked(Date.now).mockReturnValue(Date.parse(enkryptBenchmark.ingestedAt) + 300_000);
    mockRows.mockRejectedValue(new Error('unavailable'));
    for (let i = 0; i < 10; i++) {
      const [all, one, catalogResponse] = await Promise.all([
        listStats(),
        detailStats(),
        catalog(),
      ]);
      expect((await all.json())[0].benchmarks).not.toHaveProperty('enkrypt');
      expect((await one.json()).benchmarks).not.toHaveProperty('enkrypt');
      const data = OpenRouterModelsResponseSchema.parse(await catalogResponse.json());
      expect(data.data.find(model => model.id === 'some-other-model')).not.toHaveProperty(
        'enkrypt'
      );
    }
    expect(mockRows).toHaveBeenCalledTimes(2);
  });

  test.each(['deadline', 'invalidation', 'disabled'] as const)(
    'rechecks %s after an asynchronous sibling benchmark load',
    async boundary => {
      await listStats();
      const entered = Promise.withResolvers<void>();
      const pending =
        Promise.withResolvers<Map<string, { overallScore: number; avgAttemptCostUsd: number }>>();
      jest.mocked(getTerminalBenchSummaries).mockImplementationOnce(() => {
        entered.resolve();
        return pending.promise;
      });
      const response = catalog();
      await entered.promise;
      if (boundary === 'deadline') {
        jest.mocked(Date.now).mockReturnValue(Date.now() + 300_000);
      } else if (boundary === 'invalidation') {
        invalidateModelStatsCache();
      } else {
        mockPublicationEnabled = false;
      }
      mockRows.mockRejectedValue(new Error('unavailable'));
      pending.resolve(new Map());
      const data = OpenRouterModelsResponseSchema.parse(await (await response).json());
      expect(data.data.find(model => model.id === 'some-other-model')).not.toHaveProperty(
        'enkrypt'
      );
      expect(mockRows).toHaveBeenCalledTimes(boundary === 'disabled' ? 1 : 2);
    }
  );
});

describe('final Enkrypt serialization boundaries', () => {
  const stages = [
    ['direct', 'free'],
    ['direct', 'opencode'],
    ['anonymous', 'autoRouting'],
    ['anonymous', 'experiments'],
    ['authenticated', 'autoRouting'],
    ['authenticated', 'experiments'],
    ['authenticated', 'byokModels'],
    ['authenticated', 'byokProviders'],
    ['authenticated', 'byokAvailability'],
    ['organization', 'organization'],
    ['organization', 'autoRouting'],
  ] as const;
  type Stage = (typeof stages)[number][1];
  type Branch = (typeof stages)[number][0];

  function pauseAt(stage: Stage) {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    async function pause() {
      entered.resolve();
      await released.promise;
    }
    switch (stage) {
      case 'free':
        jest.mocked(isFreeModel).mockImplementationOnce(async (...args) => {
          await pause();
          return realFreeModel.isFreeModel(...args);
        });
        break;
      case 'opencode':
        jest.mocked(getGatewayOpenCodeSettings).mockImplementationOnce(async (...args) => {
          await pause();
          return realModelSettings.getGatewayOpenCodeSettings(...args);
        });
        break;
      case 'autoRouting':
        jest.mocked(addAutoRoutingModels).mockImplementationOnce(async (...args) => {
          await pause();
          return realAutoRouting.addAutoRoutingModels(...args);
        });
        break;
      case 'experiments':
        jest.mocked(listAvailableExperimentModels).mockImplementationOnce(async () => {
          await pause();
          return [];
        });
        break;
      case 'byokModels':
        jest.mocked(getDirectByokModelsForUser).mockImplementationOnce(async (...args) => {
          await pause();
          return realDirectByok.getDirectByokModelsForUser(...args);
        });
        break;
      case 'byokProviders':
        jest.mocked(getUserByokProviderIds).mockImplementationOnce(async () => {
          await pause();
          return [];
        });
        break;
      case 'byokAvailability':
        jest.mocked(addUserByokAvailability).mockImplementationOnce(async (...args) => {
          await pause();
          return realByok.addUserByokAvailability(...args);
        });
        break;
      case 'organization':
        jest.mocked(getAvailableModelsForOrganization).mockImplementationOnce(async () => {
          const data = await organizationModels();
          await pause();
          return data;
        });
    }
    return { entered: entered.promise, release: released.resolve };
  }

  async function organizationModels(): Promise<OpenRouterModelsResponse> {
    const response = await getEnhancedOpenRouterModels();
    return { ...response, data: response.data.filter(model => model.id === 'some-other-model') };
  }

  function configureBranch(branch: Branch) {
    if (branch === 'anonymous') mockAuth = { user: null, organizationId: null };
    if (branch === 'organization') {
      mockAuth = { user: { id: 'test-user-id' }, organizationId: 'test-org-id' };
      jest.mocked(getAvailableModelsForOrganization).mockImplementation(organizationModels);
    }
  }

  async function responseFor(branch: Branch) {
    if (branch === 'direct') return getEnhancedOpenRouterModels();
    const response = await GET(createTestRequest('/api/openrouter/models'));
    expect(response.status).toBe(200);
    return OpenRouterModelsResponseSchema.parse(await response.json());
  }

  beforeEach(() => {
    mockRows.mockResolvedValue(new Map([['some-other-model', enkryptBenchmark]]));
    global.fetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(createMockResponse({ jsonData: mockOpenRouterModels }));
  });

  describe.each(['deadline', 'invalidation'] as const)('%s while awaiting enrichment', boundary => {
    describe.each(['failure', 'hidden', 'verified'] as const)('refresh returns %s', refresh => {
      test.each(stages)('%s response rechecks after %s', async (branch, stage) => {
        configureBranch(branch);
        await getEnkryptBenchmarks();
        const pending = pauseAt(stage);
        const response = responseFor(branch);
        await pending.entered;
        expect(mockRows).toHaveBeenCalledTimes(1);
        if (boundary === 'deadline') jest.mocked(Date.now).mockReturnValue(Date.now() + 300_000);
        else invalidateModelStatsCache();
        const updated = { ...enkryptBenchmark, risk_score: 9 };
        const verification = {
          checkedAt: new Date(Date.now()).toISOString(),
          scoreHash: fingerprintEnkryptScore(updated),
        };
        if (refresh === 'failure') mockRows.mockRejectedValue(new Error('unavailable'));
        else
          mockRows.mockResolvedValue(
            new Map([
              [
                'some-other-model',
                {
                  ...updated,
                  verification,
                  isStealth: refresh === 'hidden',
                },
              ],
            ])
          );
        pending.release();
        const result = await response;
        const model = result.data.find(model => model.id === 'some-other-model');
        expect(model).toBeDefined();
        if (refresh === 'verified') {
          expect(model?.enkrypt).toMatchObject({
            risk_score: 9,
            lastCheckedAt: verification.checkedAt,
            freshness: 'fresh',
          });
        } else expect(model).not.toHaveProperty('enkrypt');
        expect(model?.terminalBench).toEqual({ overallScore: 0.551, avgAttemptCostUsd: 53.37 });
        expect(mockRows).toHaveBeenCalledTimes(2);
        for (const field of ['verification', 'scoreHash', 'observedAt', 'generation', 'entries']) {
          expect(JSON.stringify(result)).not.toContain(field);
        }
        if (branch === 'organization') {
          expect(getAvailableModelsForOrganization).toHaveBeenCalledWith('test-org-id', {
            type: 'member',
            kiloUserId: 'test-user-id',
          });
          expect(result.data.map(model => model.id)).toEqual(['some-other-model']);
          expect(getDirectByokModelsForUser).not.toHaveBeenCalled();
        }
      });
    });
  });

  test.each(stages)(
    '%s response applies a kill switch during %s without another query',
    async (branch, stage) => {
      configureBranch(branch);
      await getEnkryptBenchmarks();
      const pending = pauseAt(stage);
      const response = responseFor(branch);
      await pending.entered;
      mockPublicationEnabled = false;
      pending.release();
      const result = await response;
      for (const model of result.data) expect(model).not.toHaveProperty('enkrypt');
      expect(mockRows).toHaveBeenCalledTimes(1);
    }
  );

  test.each(['anonymous', 'authenticated', 'organization'] as const)(
    'sanitizes appended %s models without changing availability',
    async branch => {
      configureBranch(branch);
      const original = mockOpenRouterModels.data.find(model => model.id === 'some-other-model');
      if (!original) throw new Error('Expected catalog fixture');
      const experiment = {
        ...original,
        id: 'partner/experiment',
        enkrypt: publishedEnkryptBenchmark,
      };
      const byok = {
        ...original,
        id: 'byok/provider/model',
        canonical_slug: 'byok/provider/model',
        hugging_face_id: '',
        architecture: { ...original.architecture, modality: 'text->text', instruct_type: null },
        top_provider: {
          ...original.top_provider,
          context_length: 1000,
          max_completion_tokens: 100,
        },
        per_request_limits: null,
        supported_parameters: ['temperature'],
        default_parameters: {},
        preferredIndex: undefined,
        hasUserByokAvailable: true,
        opencode: { ai_sdk_provider: 'openai-compatible' as const, variants: undefined },
        enkrypt: publishedEnkryptBenchmark,
      };
      jest.mocked(listAvailableExperimentModels).mockResolvedValue([experiment]);
      jest.mocked(getDirectByokModelsForUser).mockResolvedValue([byok]);
      const appended = branch === 'anonymous' ? [experiment] : [experiment, byok];
      if (branch === 'organization') {
        jest
          .mocked(getAvailableModelsForOrganization)
          .mockResolvedValue({ data: [original, ...appended] });
      }
      const result = await responseFor(branch);
      for (const { enkrypt: _enkrypt, ...expected } of appended) {
        expect(result.data.find(model => model.id === expected.id)).toEqual(
          OpenRouterModelsResponseSchema.parse({ data: [expected] }).data[0]
        );
      }
      expect(experiment.enkrypt).toEqual(publishedEnkryptBenchmark);
      expect(byok.enkrypt).toEqual(publishedEnkryptBenchmark);
      expect(mockRows).toHaveBeenCalledTimes(1);
    }
  );
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});
