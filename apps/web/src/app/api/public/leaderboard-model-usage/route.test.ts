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

const yesterday = utcDaysAgo(1);

describe('GET /api/public/leaderboard-model-usage', () => {
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
    await insertLeaderboardUsage([{ usage_date: utcDaysAgo(0) }, { usage_date: utcDaysAgo(8) }]);

    const response = await GET();

    expect(response.status).toBe(502);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test('reads the seven complete UTC days before today', async () => {
    await insertLeaderboardUsage([
      { usage_date: utcDaysAgo(0), input_tokens: 1, output_tokens: 0 },
      { usage_date: utcDaysAgo(1), input_tokens: 10, output_tokens: 5 },
      { usage_date: utcDaysAgo(7), input_tokens: 20, output_tokens: 0 },
      { usage_date: utcDaysAgo(8), input_tokens: 40, output_tokens: 0 },
    ]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('public');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await response.json()).toEqual([
      { usageDate: utcDaysAgo(1), model: 'model', mode: 'code', tokens: 15 },
      { usageDate: utcDaysAgo(7), model: 'model', mode: 'code', tokens: 20 },
    ]);
  });

  test('classifies modes without treating the KiloClaw feature as a mode', async () => {
    await insertLeaderboardUsage([
      { mode: 'Code', input_tokens: 700, output_tokens: 0 },
      { mode: 'review', input_tokens: 600, output_tokens: 0 },
      { mode: 'plan', input_tokens: 500, output_tokens: 0 },
      { mode: 'ask', input_tokens: 400, output_tokens: 0 },
      { mode: 'debug', input_tokens: 300, output_tokens: 0 },
      { mode: 'kiloclaw', input_tokens: 100, output_tokens: 0 },
      { mode: null, input_tokens: 100, output_tokens: 0 },
    ]);

    const response = await GET();

    expect(await response.json()).toEqual([
      { usageDate: yesterday, model: 'model', mode: 'code', tokens: 700 },
      { usageDate: yesterday, model: 'model', mode: 'review', tokens: 600 },
      { usageDate: yesterday, model: 'model', mode: 'plan', tokens: 500 },
      { usageDate: yesterday, model: 'model', mode: 'ask', tokens: 400 },
      { usageDate: yesterday, model: 'model', mode: 'debug', tokens: 300 },
      { usageDate: yesterday, model: 'model', mode: null, tokens: 200 },
    ]);
  });

  test('refreshes cached rows containing the retired kiloclaw mode', async () => {
    jest
      .mocked(redisClient.get)
      .mockResolvedValueOnce(
        JSON.stringify([
          { usageDate: yesterday, model: 'acme/model', mode: 'kiloclaw', tokens: 12_000_000 },
        ])
      );
    await insertLeaderboardUsage([{ mode: null, input_tokens: 12_000_000, output_tokens: 0 }]);

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { usageDate: yesterday, model: 'model', mode: null, tokens: 12_000_000 },
    ]);
  });

  test('merges rows whose models normalize to the same leaderboard name', async () => {
    await insertLeaderboardUsage([
      { requested_model: 'acme/model', input_tokens: 1_000_000, output_tokens: 0 },
      { requested_model: 'other/acme/model:nitro', input_tokens: 2_000_000, output_tokens: 0 },
      { requested_model: 'acme/model:free', input_tokens: 4_000_000, output_tokens: 0 },
      {
        requested_model: 'openrouter/free',
        model: null,
        input_tokens: 500_000,
        output_tokens: 0,
      },
      { requested_model: 'acme/model', mode: 'plan', input_tokens: 3_500_000, output_tokens: 0 },
    ]);

    const response = await GET();

    expect(await response.json()).toEqual([
      { usageDate: yesterday, model: 'model:free', mode: 'code', tokens: 4_000_000 },
      { usageDate: yesterday, model: 'model', mode: 'plan', tokens: 3_500_000 },
      { usageDate: yesterday, model: 'model', mode: 'code', tokens: 3_000_000 },
      { usageDate: yesterday, model: 'openrouter/free', mode: 'code', tokens: 500_000 },
    ]);
  });

  test('attributes OpenRouter router ids to the served model', async () => {
    await insertLeaderboardUsage([
      {
        requested_model: 'openrouter/auto',
        model: 'anthropic/claude-sonnet-4.5',
        input_tokens: 1_500_000,
        output_tokens: 0,
      },
      { requested_model: null, model: 'upstream/model', input_tokens: 1_000_000, output_tokens: 0 },
    ]);

    const response = await GET();

    expect(await response.json()).toEqual([
      { usageDate: yesterday, model: 'claude-sonnet-4.5', mode: 'code', tokens: 1_500_000 },
      { usageDate: yesterday, model: 'model', mode: 'code', tokens: 1_000_000 },
    ]);
  });

  test('resolves latest aliases to their current gateway target, falling back to the served model', async () => {
    jest
      .mocked(resolveOpenRouterModelAlias)
      .mockImplementation(async model =>
        model === '~deepseek/deepseek-pro-latest' ? 'deepseek/deepseek-v4-pro-0813' : model
      );
    await insertLeaderboardUsage([
      {
        requested_model: '~deepseek/deepseek-pro-latest',
        model: 'deepseek-v4-pro',
        input_tokens: 6_000_000,
        output_tokens: 0,
      },
      {
        requested_model: 'deepseek/deepseek-v4-pro-0813',
        model: 'deepseek-v4-pro',
        input_tokens: 6_000_000,
        output_tokens: 0,
      },
      {
        requested_model: '~deepseek/unresolved-latest',
        model: 'vendor/served-model',
        input_tokens: 2_000_000,
        output_tokens: 0,
      },
    ]);

    const response = await GET();

    expect(await response.json()).toEqual([
      { usageDate: yesterday, model: 'deepseek-v4-pro-0813', mode: 'code', tokens: 12_000_000 },
      { usageDate: yesterday, model: 'served-model', mode: 'code', tokens: 2_000_000 },
    ]);
  });

  test('excludes private custom models and usage without input tokens', async () => {
    await insertLeaderboardUsage([
      { provider: 'custom', requested_model: 'reflection/beam-free', input_tokens: 600 },
      { provider: 'custom', requested_model: 'stealth/glyph-cluster', input_tokens: 500 },
      {
        provider: 'custom',
        requested_model: null,
        model: 'reflection/beam-free',
        input_tokens: 400,
      },
      { provider: 'custom', requested_model: 'private/model', input_tokens: 10_000 },
      { provider: 'custom-public', requested_model: 'acme/public-model', input_tokens: 300 },
      { requested_model: 'acme/no-input', input_tokens: 0 },
    ]);

    const response = await GET();

    expect(
      ((await response.json()) as { model: string }[]).map(usage => usage.model).sort()
    ).toEqual(['beam-free', 'glyph-cluster', 'public-model']);
  });
});
