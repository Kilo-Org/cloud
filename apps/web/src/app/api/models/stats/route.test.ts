import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { GET, dynamic, revalidate } from './route';
import { NextRequest } from 'next/server';
import type { ModelStats } from '@kilocode/db/schema';
import type { EnkryptBenchmark } from '@kilocode/db/schema-types';
import { getModelStatsSnapshot } from '@/lib/model-stats/model-stats-cache';
import type * as Cache from '@/lib/model-stats/model-stats-cache';
import { fingerprintEnkryptScore } from '@/lib/model-stats/enkrypt-fingerprint';

let mockPublicationEnabled = true;
jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
  ENKRYPT_SYNC_ENABLED: false,
}));
jest.mock('@/lib/drizzle', () => ({ db: {} }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/model-stats/model-stats-cache', () => ({
  ...jest.requireActual<typeof Cache>('@/lib/model-stats/model-stats-cache'),
  getModelStatsSnapshot: jest.fn(),
}));

const benchmark: EnkryptBenchmark = {
  model_name: 'Stats model',
  provider: 'Provider',
  risk_score: 0,
  bias_score: null,
  ingestedAt: '2026-08-27T00:00:00.000Z',
  evaluatedAt: null,
};
const published = {
  ...benchmark,
  lastCheckedAt: benchmark.ingestedAt,
  staleAfter: '2026-08-28T02:00:00.000Z',
  freshness: 'fresh',
};
const siblings = {
  artificialAnalysis: { codingIndex: 75 },
  kiloBench: { overallScore: 0.7, evals: {} },
  futureBenchmark: { preserved: true },
};
let entries: Cache.ModelStatsCacheEntry[];

function entry(
  overrides: Partial<ModelStats> = {},
  verification?: unknown
): Cache.ModelStatsCacheEntry {
  return {
    stat: {
      id: 'model-id',
      slug: 'model',
      openrouterId: 'provider/model',
      name: 'Model',
      isActive: true,
      isStealth: false,
      isFeatured: true,
      isRecommended: true,
      codingIndex: '75',
      benchmarks: { ...siblings, enkrypt: benchmark },
      openrouterData: {
        name: 'Raw name',
        enkrypt: published,
        terminalBench: { overallScore: 0.7 },
      },
      ...overrides,
    } as ModelStats,
    verification,
  };
}

beforeEach(() => {
  mockPublicationEnabled = true;
  entries = [entry()];
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(benchmark.ingestedAt));
  jest
    .mocked(getModelStatsSnapshot)
    .mockReset()
    .mockImplementation(async () => ({
      entries,
      observedAt: Date.now(),
      generation: 0,
    }));
});
afterEach(() => {
  jest.restoreAllMocks();
});

function response() {
  return GET(new NextRequest('http://localhost/api/models/stats'));
}
async function models() {
  const result = await response();
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  return result.json();
}

describe('GET /api/models/stats', () => {
  test('keeps dynamic no-store responses', () => {
    expect(revalidate).toBe(0);
    expect(dynamic).toBe('force-dynamic');
  });

  test('filters active rows without changing database order or flags', async () => {
    entries = [
      entry({ id: 'null', codingIndex: null }),
      entry({ id: 'inactive', isActive: false, codingIndex: '100' }),
      entry({ id: 'high', codingIndex: '95.5' }),
      entry({ id: 'medium', codingIndex: '85.3' }),
      entry({ id: 'null-active', isActive: null }),
    ];
    const data: ModelStats[] = await models();
    expect(data.map(stat => stat.id)).toEqual(['null', 'high', 'medium']);
    expect(data[0]).toMatchObject({
      slug: 'model',
      openrouterId: 'provider/model',
      name: 'Model',
      isActive: true,
      isFeatured: true,
      isStealth: false,
      isRecommended: true,
    });
  });

  test.each([true, false])(
    'gates scores with publication %s independently of sync',
    async enabled => {
      mockPublicationEnabled = enabled;
      const [model] = await models();
      expect(model.benchmarks).toEqual(enabled ? { ...siblings, enkrypt: published } : siblings);
      expect(model.openrouterData).toEqual({
        name: 'Raw name',
        terminalBench: { overallScore: 0.7 },
      });
      expect(entries[0].stat.benchmarks?.enkrypt).toEqual(benchmark);
      expect(entries[0].stat.openrouterData).toHaveProperty('enkrypt');
    }
  );

  test('recomputes freshness and applies the kill switch without mutating base rows', async () => {
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter) - 1);
    expect((await models())[0].benchmarks.enkrypt).toEqual(published);
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter));
    expect((await models())[0].benchmarks.enkrypt).toEqual({ ...published, freshness: 'stale' });
    mockPublicationEnabled = false;
    expect((await models())[0].benchmarks).toEqual(siblings);
    expect(entries[0].stat.benchmarks?.enkrypt).toEqual(benchmark);
  });

  test('binds each row verification and never exposes hashes or cache metadata', async () => {
    const checkedAt = '2026-08-30T00:00:00.000Z';
    const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) };
    entries = [entry({}, verification), entry({ id: 'missing', openrouterId: 'provider/missing' })];
    jest.mocked(Date.now).mockReturnValue(Date.parse(checkedAt));
    const data = await models();
    expect(data[0].benchmarks.enkrypt).toEqual({
      ...published,
      lastCheckedAt: checkedAt,
      staleAfter: '2026-08-31T02:00:00.000Z',
    });
    expect(data[1].benchmarks.enkrypt).toEqual({ ...published, freshness: 'stale' });
    expect(getModelStatsSnapshot).toHaveBeenCalledTimes(1);
    for (const field of ['verification', 'scoreHash', 'observedAt', 'generation', 'entries']) {
      expect(JSON.stringify(data)).not.toContain(field);
    }
  });

  test.each([
    { isStealth: true },
    { openrouterId: 'kilo-internal/stats-list' },
    { benchmarks: { ...siblings, enkrypt: { ...benchmark, ingestedAt: 'invalid' } } },
    {
      benchmarks: {
        ...siblings,
        enkrypt: { ...benchmark, ingestedAt: '2026-08-27T00:00:00.001Z' },
      },
    },
  ])('withholds nonpublic or malformed Enkrypt %j', async overrides => {
    entries = [entry(overrides)];
    const [model] = await models();
    expect(model.benchmarks).toEqual(siblings);
    expect(model.openrouterData).not.toHaveProperty('enkrypt');
  });

  test('withholds scores from an expired snapshot even when the model metadata is returned', async () => {
    jest
      .mocked(getModelStatsSnapshot)
      .mockResolvedValue({ entries, observedAt: Date.now() - 300_000, generation: 0 });
    expect((await models())[0].benchmarks).toEqual(siblings);
  });

  test('strips raw scores even when no benchmark namespace exists', async () => {
    entries = [entry({ benchmarks: null })];
    const [model] = await models();
    expect(model.benchmarks).toBeNull();
    expect(model.openrouterData).not.toHaveProperty('enkrypt');
  });

  test('returns no-store 500 rather than an empty success on a cold failure', async () => {
    jest.mocked(getModelStatsSnapshot).mockRejectedValue(new Error('unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await response();
    expect(result.status).toBe(500);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({ error: 'Failed to fetch model statistics' });
  });
});
