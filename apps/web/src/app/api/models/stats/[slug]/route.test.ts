import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { GET, dynamic, revalidate } from './route';
import { NextRequest } from 'next/server';
import type { ModelStats } from '@kilocode/db/schema';
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

const benchmark = {
  model_name: 'Stats model',
  provider: 'Provider',
  source: null,
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

function response(slug = 'model') {
  return GET(new NextRequest('http://localhost/api/models/stats/model'), {
    params: Promise.resolve({ slug }),
  });
}
async function model() {
  const result = await response();
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toBe('no-store');
  return result.json();
}

describe('GET /api/models/stats/[slug]', () => {
  test('keeps dynamic no-store responses and selects the requested slug', async () => {
    expect(revalidate).toBe(0);
    expect(dynamic).toBe('force-dynamic');
    entries.unshift(entry({ slug: 'other', id: 'other' }));
    expect(await model()).toMatchObject({
      id: 'model-id',
      slug: 'model',
      openrouterId: 'provider/model',
      name: 'Model',
      isActive: true,
      isFeatured: true,
      isStealth: false,
      isRecommended: true,
    });
  });

  test('returns a no-store 404 for a missing slug', async () => {
    const result = await response('absent');
    expect(result.status).toBe(404);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({ error: 'Model with slug "absent" not found' });
  });

  test.each([true, false])(
    'gates scores with publication %s independently of sync',
    async enabled => {
      mockPublicationEnabled = enabled;
      const data = await model();
      expect(data.benchmarks).toEqual(enabled ? { ...siblings, enkrypt: published } : siblings);
      expect(data.openrouterData).toEqual({
        name: 'Raw name',
        terminalBench: { overallScore: 0.7 },
      });
      expect(entries[0].stat.benchmarks?.enkrypt).toEqual(benchmark);
      expect(entries[0].stat.openrouterData).toHaveProperty('enkrypt');
    }
  );

  test('recomputes freshness from content time and applies the kill switch', async () => {
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter) - 1);
    expect((await model()).benchmarks.enkrypt).toEqual(published);
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter));
    expect((await model()).benchmarks.enkrypt).toEqual({ ...published, freshness: 'stale' });
    mockPublicationEnabled = false;
    expect((await model()).benchmarks).toEqual(siblings);
  });

  test('uses only the slug check and never exposes hashes or cache metadata', async () => {
    const checkedAt = '2026-08-30T00:00:00.000Z';
    const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) };
    entries = [entry({}, verification), entry({ slug: 'other', openrouterId: 'other/model' })];
    jest.mocked(Date.now).mockReturnValue(Date.parse(checkedAt));
    const data = await model();
    const checked = {
      ...published,
      lastCheckedAt: checkedAt,
      staleAfter: '2026-08-31T02:00:00.000Z',
    };
    expect(data.benchmarks.enkrypt).toEqual(checked);
    for (const field of ['verification', 'scoreHash', 'observedAt', 'generation', 'entries']) {
      expect(JSON.stringify(data)).not.toContain(field);
    }
    jest.mocked(Date.now).mockReturnValue(Date.parse(checked.staleAfter) - 1);
    expect((await model()).benchmarks.enkrypt).toEqual(checked);
    jest.mocked(Date.now).mockReturnValue(Date.parse(checked.staleAfter));
    expect((await model()).benchmarks.enkrypt).toEqual({ ...checked, freshness: 'stale' });
    expect(entries[0].stat.benchmarks?.enkrypt).toEqual(benchmark);
  });

  test('does not freshen missing or mismatched checks with another row verification', async () => {
    const checkedAt = '2026-08-30T00:00:00.000Z';
    jest.mocked(Date.now).mockReturnValue(Date.parse(checkedAt));
    entries = [
      entry({ slug: 'other' }, { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) }),
      entry(),
    ];
    expect((await model()).benchmarks.enkrypt).toEqual({ ...published, freshness: 'stale' });
    entries = [entry({}, { checkedAt, scoreHash: '0'.repeat(64) })];
    expect((await model()).benchmarks.enkrypt).toEqual({ ...published, freshness: 'stale' });
  });

  test.each([
    { isStealth: true },
    { isActive: false },
    { isActive: null },
    { openrouterId: 'kilo-internal/stats-slug' },
    { benchmarks: { ...siblings, enkrypt: { ...benchmark, ingestedAt: 'invalid' } } },
    {
      benchmarks: {
        ...siblings,
        enkrypt: { ...benchmark, ingestedAt: '2026-08-27T00:00:00.001Z' },
      },
    },
  ])('retains detail access but omits nonpublic or invalid scores %j', async overrides => {
    entries = [entry(overrides)];
    const data = await model();
    expect(data.benchmarks).toEqual(siblings);
    expect(data.openrouterData).not.toHaveProperty('enkrypt');
    expect(data.isActive).toBe(entries[0].stat.isActive);
  });

  test('strips raw scores with no benchmark namespace', async () => {
    entries = [entry({ benchmarks: null })];
    const data = await model();
    expect(data.benchmarks).toBeNull();
    expect(data.openrouterData).not.toHaveProperty('enkrypt');
  });

  test('returns a no-store 500 instead of 404 on cold load failure', async () => {
    jest.mocked(getModelStatsSnapshot).mockRejectedValue(new Error('unavailable'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await response('absent');
    expect(result.status).toBe(500);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect(await result.json()).toEqual({ error: 'Failed to fetch model statistics' });
  });
});
