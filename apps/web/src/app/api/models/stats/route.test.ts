import { afterEach, beforeEach, describe, test, expect, beforeAll } from '@jest/globals';
import { GET, dynamic, revalidate } from './route';
import { NextRequest } from 'next/server';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { insertTestModelStats } from '@/tests/helpers/model-stats.helper';
import { db } from '@/lib/drizzle';
import { modelStats, type ModelStats } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import type { EnkryptBenchmark } from '@kilocode/db/schema-types';

import type * as Config from '@/lib/config.server';

let mockPublicationEnabled = true;

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<typeof Config>('@/lib/config.server'),
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
  ENKRYPT_SYNC_ENABLED: false,
}));

describe('GET /api/models/stats', () => {
  beforeAll(async () => {
    await insertTestUser();

    // Insert test model stats with different coding indexes for sorting tests
    await Promise.all([
      insertTestModelStats({
        slug: 'test-model-high-coding',
        name: 'High Coding Model',
        openrouterId: 'test/high-coding',
        codingIndex: '95.5',
        isActive: true,
      }),
      insertTestModelStats({
        slug: 'test-model-med-coding',
        name: 'Medium Coding Model',
        openrouterId: 'test/med-coding',
        codingIndex: '85.3',
        isActive: true,
      }),
      insertTestModelStats({
        slug: 'test-model-no-coding',
        name: 'No Coding Model',
        openrouterId: 'test/no-coding',
        codingIndex: null,
        isActive: true,
      }),
      insertTestModelStats({
        slug: 'test-model-inactive',
        name: 'Inactive Model',
        openrouterId: 'test/inactive',
        codingIndex: '99.9',
        isActive: false, // Should not appear in results
      }),
    ]);
  });

  test('should return all active model stats', async () => {
    const request = new NextRequest('http://localhost:3000/api/models/stats');
    const response = await GET(request);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(3); // At least our 3 active test models

    // Verify all returned models are active
    for (const stat of data) {
      expect(stat.isActive).toBe(true);
    }

    // Verify inactive model is not included
    expect(
      data.find((s: { slug: string | null }) => s.slug === 'test-model-inactive')
    ).toBeUndefined();

    // Verify our test models are present
    const testSlugs = ['test-model-high-coding', 'test-model-med-coding', 'test-model-no-coding'];
    for (const slug of testSlugs) {
      expect(data.find((s: { slug: string | null }) => s.slug === slug)).toBeDefined();
    }
  });

  test('should order results by coding index descending', async () => {
    const request = new NextRequest('http://localhost:3000/api/models/stats');
    const response = await GET(request);

    const data = await response.json();

    // Check that coding index is in descending order (nulls at end)
    for (let i = 0; i < data.length - 1; i++) {
      const current = data[i].codingIndex;
      const next = data[i + 1].codingIndex;

      if (current !== null && next !== null) {
        expect(Number(current)).toBeGreaterThanOrEqual(Number(next));
      }
    }
  });

  test('should include all expected fields', async () => {
    // First ensure we have at least one model stat
    const [existingStat] = await db.select().from(modelStats).limit(1);

    if (!existingStat) {
      // Skip test if no data exists
      return;
    }

    const request = new NextRequest('http://localhost:3000/api/models/stats');
    const response = await GET(request);
    const data = await response.json();

    if (data.length > 0) {
      const stat = data[0];
      expect(stat).toHaveProperty('id');
      expect(stat).toHaveProperty('openrouterId');
      expect(stat).toHaveProperty('slug');
      expect(stat).toHaveProperty('name');
      expect(stat).toHaveProperty('isActive');
    }
  });
});

describe('GET /api/models/stats Enkrypt publication', () => {
  const benchmark: EnkryptBenchmark = {
    model_name: 'Stats model',
    provider: 'Provider',
    risk_score: 0,
    bias_score: null,
    ingestedAt: '2026-08-27T00:00:00.000Z',
    evaluatedAt: null,
  };
  const published = { ...benchmark, staleAfter: '2026-08-28T02:00:00.000Z', freshness: 'fresh' };
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
    const response = await GET(new NextRequest('http://localhost:3000/api/models/stats'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const data: ModelStats[] = await response.json();
    return data.find(row => row.id === stat.id);
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
      expect(result?.benchmarks).toEqual(enabled ? { ...siblings, enkrypt: published } : siblings);
      expect(result?.openrouterData).not.toHaveProperty('enkrypt');
      expect(result?.name).toBe(stored.name);
      if (enabled) expect(result?.benchmarks?.enkrypt).not.toHaveProperty('source');
      const [unchanged] = await db.select().from(modelStats).where(eq(modelStats.id, stored.id));
      expect(unchanged).toEqual(stored);
    }
  );

  test('recomputes freshness at the 26 hour boundary and applies the kill switch on the next response', async () => {
    const stored = await insertSnapshot();
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter) - 1);
    expect((await responseFor(stored))?.benchmarks?.enkrypt).toEqual(published);
    jest.mocked(Date.now).mockReturnValue(Date.parse(published.staleAfter));
    expect((await responseFor(stored))?.benchmarks?.enkrypt).toEqual({
      ...published,
      freshness: 'stale',
    });
    mockPublicationEnabled = false;
    expect((await responseFor(stored))?.benchmarks).toEqual(siblings);
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
  ])('omits nonpublic or invalid stored snapshots %j', async overrides => {
    const stored = await insertSnapshot(overrides);
    const result = await responseFor(stored);
    expect(result?.benchmarks).toEqual(siblings);
    expect(result?.openrouterData).not.toHaveProperty('enkrypt');
  });

  test('strips raw saved scores even when no benchmark namespace exists', async () => {
    mockPublicationEnabled = false;
    const stored = await insertSnapshot({ benchmarks: null });
    const result = await responseFor(stored);
    expect(result?.benchmarks).toBeNull();
    expect(result?.openrouterData).not.toHaveProperty('enkrypt');
  });

  test('does not cache error responses', async () => {
    jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('test database failure');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const response = await GET(new NextRequest('http://localhost:3000/api/models/stats'));
    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
