import { cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { resolveOpenRouterModelAlias } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { insertLeaderboardUsage, utcDaysAgo } from '@/tests/helpers/leaderboard-usage.helper';
import { GET } from './route';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    get: jest.fn(),
    set: jest.fn(),
  },
}));

// Without the in-process cache, every GET reads the rows the test inserted.
jest.mock('@kilocode/web-shared/lib/cached-fetch', () => ({
  createCachedFetch:
    <T>(fetcher: () => Promise<T>, _ttlMs: number, fallback: T) =>
    async () => {
      try {
        return await fetcher();
      } catch {
        return fallback;
      }
    },
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  resolveOpenRouterModelAlias: jest.fn(),
}));

describe('GET /api/public/leaderboard-model-provider-usage', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    jest.mocked(redisClient.get).mockReset().mockResolvedValue(null);
    jest.mocked(redisClient.set).mockReset().mockResolvedValue('OK');
    jest
      .mocked(resolveOpenRouterModelAlias)
      .mockReset()
      .mockImplementation(async model => model);
  });

  test('answers 502 while the rollup has no rows in the window', async () => {
    await insertLeaderboardUsage([{ usage_date: utcDaysAgo(0) }]);

    const response = await GET();

    expect(response.status).toBe(502);
  });

  test('sums the window per model and inference provider before calculating ratios', async () => {
    await insertLeaderboardUsage([
      {
        usage_date: utcDaysAgo(1),
        requested_model: 'synthetic/alias-test-model',
        inference_provider: 'Particle AI',
        cost_microdollars: 6_000_000,
        input_tokens: 4_000_000,
        output_tokens: 2_000_000,
        cache_hit_tokens: 1_000_000,
        request_count: 30,
      },
      {
        usage_date: utcDaysAgo(7),
        requested_model: 'synthetic/alias-test-model',
        inference_provider: 'particle',
        cost_microdollars: 18_000_000,
        input_tokens: 4_000_000,
        output_tokens: 2_000_000,
        cache_hit_tokens: 1_000_000,
        request_count: 70,
      },
      {
        usage_date: utcDaysAgo(8),
        requested_model: 'synthetic/alias-test-model',
        inference_provider: 'particle',
        input_tokens: 100_000_000,
      },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual([
      {
        model: 'alias-test-model',
        provider: 'Particle AI',
        sumTokens: 12_000_000,
        costPerRequest: 0.24,
        costPerMillionTokens: 2,
        cacheRatio: 0.25,
        errorRate: 0,
        percentageOfModel: 100,
      },
    ]);
  });

  test('keeps Claude Platform on AWS separate from Amazon Bedrock for the same model', async () => {
    await insertLeaderboardUsage([
      { requested_model: 'synthetic/model', inference_provider: 'claudeaws' },
      { requested_model: 'synthetic/model', inference_provider: 'bedrock' },
    ]);

    const response = await GET();

    expect(await response.json()).toEqual([
      expect.objectContaining({
        model: 'model',
        provider: 'Amazon Bedrock',
        sumTokens: 12_000_000,
        percentageOfModel: 50,
      }),
      expect.objectContaining({
        model: 'model',
        provider: 'Claude Platform on AWS',
        sumTokens: 12_000_000,
        percentageOfModel: 50,
      }),
    ]);
  });

  test('beautifies the Meituan inference provider', async () => {
    await insertLeaderboardUsage([
      { requested_model: 'meituan/longcat-flash-chat', inference_provider: 'meituan' },
    ]);

    const response = await GET();

    expect(await response.json()).toEqual([
      expect.objectContaining({ model: 'longcat-flash-chat', provider: 'Meituan LongCat' }),
    ]);
  });

  test('resolves latest aliases to their current gateway target', async () => {
    jest
      .mocked(resolveOpenRouterModelAlias)
      .mockImplementation(async model =>
        model === '~deepseek/deepseek-pro-latest' ? 'deepseek/deepseek-v4-pro-0813' : model
      );
    await insertLeaderboardUsage([
      {
        requested_model: '~deepseek/deepseek-pro-latest',
        model: 'deepseek-v4-pro',
        inference_provider: 'deepseek',
        input_tokens: 5_000_000,
        output_tokens: 1_000_000,
      },
      {
        requested_model: 'deepseek/deepseek-v4-pro-0813',
        inference_provider: 'deepseek',
        input_tokens: 5_000_000,
        output_tokens: 1_000_000,
      },
    ]);

    const response = await GET();

    expect(await response.json()).toEqual([
      expect.objectContaining({
        model: 'deepseek-v4-pro-0813',
        provider: 'DeepSeek',
        sumTokens: 12_000_000,
      }),
    ]);
  });

  test('excludes BYOK, private custom models, mercury-edit and rows without output', async () => {
    await insertLeaderboardUsage([
      { requested_model: 'acme/kept' },
      { requested_model: 'acme/user-byok', is_user_byok: true },
      { provider: 'custom', requested_model: 'private/model' },
      { provider: 'custom', requested_model: 'reflection/beam-free' },
      { provider: 'custom', requested_model: null, model: 'reflection/beam-free' },
      { requested_model: 'inception/mercury-edit' },
      { requested_model: 'acme/no-output', output_tokens: 0 },
    ]);

    const response = await GET();

    expect(
      ((await response.json()) as { model: string }[]).map(usage => usage.model).sort()
    ).toEqual(['beam-free', 'kept']);
  });
});
