import { afterEach, beforeEach, describe, test, expect, beforeAll } from '@jest/globals';
import { GET, dynamic, revalidate } from './route';
import { NextRequest } from 'next/server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';
import { db } from '@/lib/drizzle';
import { modelStats, type ModelStats } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { EnkryptBenchmark } from '@kilocode/db/schema-types';
import { getEnkryptVerifications } from '@/lib/model-stats/enkrypt-verifications';
import { fingerprintEnkryptScore } from '@/lib/model-stats/enkrypt-fingerprint';

import type * as Config from '@/lib/config.server';

let mockPublicationEnabled = true;

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<typeof Config>('@/lib/config.server'),
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
  ENKRYPT_SYNC_ENABLED: false,
}));

jest.mock('@/lib/model-stats/enkrypt-verifications', () => ({
  getEnkryptVerifications: jest.fn(),
}));

beforeEach(() => {
  jest.mocked(getEnkryptVerifications).mockReset().mockResolvedValue({});
});

describe('GET /api/models/stats/[slug]', () => {
  let testModelStat: Awaited<ReturnType<typeof insertTestModelStats>>;

  beforeAll(async () => {
    await insertTestUser();
    testModelStat = await insertTestModelStats({
      slug: 'test-model-slug',
      name: 'Test Model',
      openrouterId: 'openrouter/test-model',
    });
  });

  test('should return model stats for valid slug', async () => {
    const request = new NextRequest(`http://localhost:3000/api/models/stats/${testModelStat.slug}`);
    const response = await GET(request, {
      params: Promise.resolve({ slug: testModelStat.slug! }),
    });

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.slug).toBe(testModelStat.slug);
    expect(data.id).toBe(testModelStat.id);
  });

  test('should return 404 for non-existent slug', async () => {
    const request = new NextRequest(
      'http://localhost:3000/api/models/stats/non-existent-model-slug-12345'
    );
    const response = await GET(request, {
      params: Promise.resolve({ slug: 'non-existent-model-slug-12345' }),
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  test('should include all expected fields for valid slug', async () => {
    const request = new NextRequest(`http://localhost:3000/api/models/stats/${testModelStat.slug}`);
    const response = await GET(request, {
      params: Promise.resolve({ slug: testModelStat.slug! }),
    });

    const data = await response.json();

    expect(data).toHaveProperty('id');
    expect(data).toHaveProperty('openrouterId');
    expect(data).toHaveProperty('slug');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('isActive');
    expect(data).toHaveProperty('openrouterData');
  });
});

describe('GET /api/models/stats/[slug] Enkrypt publication', () => {
  const benchmark: EnkryptBenchmark = {
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

  beforeEach(() => {
    mockPublicationEnabled = true;
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse(benchmark.ingestedAt));
  });

  afterEach(() => {
    mockPublicationEnabled = true;
    jest.restoreAllMocks();
  });

  async function insertSnapshot(overrides: Partial<ModelStats> = {}) {
    const stat = await insertTestModelStats({ benchmarks: { ...siblings, enkrypt: benchmark } });
    const openrouterData = { ...stat.openrouterData, enkrypt: published };
    const [stored] = await db
      .update(modelStats)
      .set({ openrouterData, ...overrides })
      .where(eq(modelStats.id, stat.id))
      .returning();
    return stored;
  }

  async function responseFor(stat: ModelStats) {
    if (!stat.slug) throw new Error('Expected a test model slug');
    const response = await GET(
      new NextRequest(`http://localhost:3000/api/models/stats/${stat.slug}`),
      {
        params: Promise.resolve({ slug: stat.slug }),
      }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    return response.json();
  }

  test('disables route caching so publication cannot be bypassed by a cached response', () => {
    expect(revalidate).toBe(0);
    expect(dynamic).toBe('force-dynamic');
  });

  test.each([true, false])(
    'publishes only gated snapshots with publication %s and sync disabled',
    async enabled => {
      mockPublicationEnabled = enabled;
      const stored = await insertSnapshot();
      const result = await responseFor(stored);
      expect(result.benchmarks).toEqual(enabled ? { ...siblings, enkrypt: published } : siblings);
      expect(result.openrouterData).not.toHaveProperty('enkrypt');
      expect(result.name).toBe(stored.name);
      const [unchanged] = await db.select().from(modelStats).where(eq(modelStats.id, stored.id));
      expect(unchanged).toEqual(stored);
    }
  );

  test('recomputes freshness at the 26 hour boundary and applies the kill switch on the next response', async () => {
    const stored = await insertSnapshot();
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter) - 1);
    expect((await responseFor(stored)).benchmarks.enkrypt).toEqual(published);
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter));
    expect((await responseFor(stored)).benchmarks.enkrypt).toEqual({
      ...published,
      freshness: 'stale',
    });
    mockPublicationEnabled = false;
    expect((await responseFor(stored)).benchmarks).toEqual(siblings);
  });

  test('uses the slug model check once and retains siblings at the check-time boundary and kill switch', async () => {
    const stored = await insertSnapshot();
    const checkedAt = '2026-08-30T00:00:00.000Z';
    const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) };
    jest.mocked(getEnkryptVerifications).mockResolvedValue({ [stored.openrouterId]: verification });
    jest.mocked(Date.now).mockReturnValue(Date.parse(checkedAt));
    const checked = {
      ...published,
      lastCheckedAt: checkedAt,
      staleAfter: '2026-08-31T02:00:00.000Z',
    };
    const result = await responseFor(stored);
    expect(result.benchmarks).toEqual({ ...siblings, enkrypt: checked });
    expect(result.openrouterData).not.toHaveProperty('enkrypt');
    expect(JSON.stringify(result)).not.toContain(verification.scoreHash);
    expect(getEnkryptVerifications).toHaveBeenCalledTimes(1);

    jest.mocked(Date.now).mockReturnValue(Date.parse(checked.staleAfter) - 1);
    expect((await responseFor(stored)).benchmarks.enkrypt).toEqual(checked);
    jest.mocked(Date.now).mockReturnValue(Date.parse(checked.staleAfter));
    expect((await responseFor(stored)).benchmarks.enkrypt).toEqual({
      ...checked,
      freshness: 'stale',
    });
    mockPublicationEnabled = false;
    expect((await responseFor(stored)).benchmarks).toEqual(siblings);
    const [unchanged] = await db.select().from(modelStats).where(eq(modelStats.id, stored.id));
    expect(unchanged).toEqual(stored);
  });

  test('does not use a different model check to freshen missing or mismatched content', async () => {
    const stored = await insertSnapshot();
    const checkedAt = '2026-08-30T00:00:00.000Z';
    jest.mocked(Date.now).mockReturnValue(Date.parse(checkedAt));
    jest.mocked(getEnkryptVerifications).mockResolvedValue({
      'other/model': { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) },
    });
    expect((await responseFor(stored)).benchmarks.enkrypt).toEqual({
      ...published,
      freshness: 'stale',
    });
    jest.mocked(getEnkryptVerifications).mockResolvedValue({
      [stored.openrouterId]: { checkedAt, scoreHash: '0'.repeat(64) },
    });
    expect((await responseFor(stored)).benchmarks.enkrypt).toEqual({
      ...published,
      freshness: 'stale',
    });
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
  ])('omits nonpublic or invalid stored snapshots %j', async overrides => {
    const stored = await insertSnapshot(overrides);
    const result = await responseFor(stored);
    expect(result.benchmarks).toEqual(siblings);
    expect(result.openrouterData).not.toHaveProperty('enkrypt');
  });

  test('strips raw saved scores even when no benchmark namespace exists', async () => {
    mockPublicationEnabled = false;
    const stored = await insertSnapshot({ benchmarks: null });
    const result = await responseFor(stored);
    expect(result.benchmarks).toBeNull();
    expect(result.openrouterData).not.toHaveProperty('enkrypt');
  });

  test('does not cache error responses', async () => {
    jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('test database failure');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = await GET(
      new NextRequest('http://localhost:3000/api/models/stats/test-error'),
      {
        params: Promise.resolve({ slug: 'test-error' }),
      }
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
