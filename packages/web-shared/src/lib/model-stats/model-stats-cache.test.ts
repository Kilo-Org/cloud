import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { NextRequest } from 'next/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ModelStats } from '@kilocode/db/schema';
import type * as Cache from './model-stats-cache';
import type * as Enkrypt from './enkrypt';
import type * as ListRoute from '@/app/api/models/stats/route';
import type * as DetailRoute from '@/app/api/models/stats/[slug]/route';
import { fingerprintEnkryptScore } from './enkrypt-fingerprint';

let mockPublicationEnabled = true;
const mockOrderBy = jest.fn<Promise<Cache.ModelStatsCacheEntry[]>, [unknown]>();
const mockLeftJoin = jest.fn((_table: unknown, _condition: SQL) => ({ orderBy: mockOrderBy }));
const mockFrom = jest.fn((_table: unknown) => ({ leftJoin: mockLeftJoin, orderBy: mockOrderBy }));
const mockSelect = jest.fn((_selection: { stat: unknown; verification?: SQL }) => ({
  from: mockFrom,
}));
const mockReplicaSelect = jest.fn();

jest.mock('@/lib/drizzle', () => ({
  db: { select: mockSelect },
  readDb: { select: mockReplicaSelect },
}));
jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
}));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const TTL = 5 * 60 * 1000;
const benchmark = {
  model_name: 'Model',
  provider: 'Provider',
  risk_score: 0,
  bias_score: null,
  ingestedAt: '2026-08-27T00:00:00.000Z',
  evaluatedAt: null,
};
const checkedAt = '2026-08-30T00:00:00.000Z';
const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) };
const siblings = { artificialAnalysis: { codingIndex: 70 }, futureBenchmark: { preserved: true } };

function entry(overrides: Partial<ModelStats> = {}): Cache.ModelStatsCacheEntry {
  return {
    stat: {
      id: 'model-id',
      openrouterId: 'provider/model',
      slug: 'model',
      name: 'Model',
      isActive: true,
      isFeatured: true,
      isStealth: false,
      isRecommended: true,
      codingIndex: '70',
      benchmarks: { ...siblings, enkrypt: benchmark },
      openrouterData: { name: 'Raw model', enkrypt: benchmark, terminalBench: { overallScore: 1 } },
      ...overrides,
    } as ModelStats,
    verification,
  };
}

let cache: typeof Cache;
let enkrypt: typeof Enkrypt;
let listRoute: typeof ListRoute;
let detailRoute: typeof DetailRoute;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  mockOrderBy.mockReset().mockResolvedValue([entry()]);
  mockPublicationEnabled = true;
  jest.useFakeTimers();
  jest.setSystemTime(Date.parse(checkedAt));
  jest.spyOn(console, 'error').mockImplementation(() => {});
  [cache, enkrypt, listRoute, detailRoute] = await Promise.all([
    import('./model-stats-cache'),
    import('./enkrypt'),
    import('@/app/api/models/stats/route'),
    import('@/app/api/models/stats/[slug]/route'),
  ]);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function list() {
  return listRoute.GET(new NextRequest('http://localhost/api/models/stats'));
}

function detail(slug = 'model') {
  return detailRoute.GET(new NextRequest('http://localhost/api/models/stats/model'), {
    params: Promise.resolve({ slug }),
  });
}

async function catalog() {
  return enkrypt.enkryptFor(await enkrypt.getEnkryptBenchmarks(), 'provider/model');
}

function deferredRows() {
  return Promise.withResolvers<Cache.ModelStatsCacheEntry[]>();
}

describe('model stats snapshot cache', () => {
  it('coalesces sequential and concurrent list, detail, and catalog requests onto one primary query', async () => {
    const pending = deferredRows();
    mockOrderBy.mockReturnValueOnce(pending.promise);
    const requests = Array.from({ length: 30 }, () => Promise.all([list(), detail(), catalog()]));
    await Promise.resolve();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    pending.resolve([entry()]);
    for (const [all, one, benchmark] of await Promise.all(requests)) {
      expect(all.status).toBe(200);
      expect(one.status).toBe(200);
      expect(benchmark?.lastCheckedAt).toBe(checkedAt);
    }
    for (let i = 0; i < 30; i++) await Promise.all([list(), detail(), catalog()]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockReplicaSelect).not.toHaveBeenCalled();
    const snapshot = await cache.getModelStatsSnapshot();
    expect(await enkrypt.getEnkryptBenchmarks()).toBe(snapshot);
  });

  it('selects only each row verification alongside nested stats in one ordered left join', async () => {
    await cache.getModelStatsSnapshot();
    const { modelStats, enkrypt_sync_state } = await import('@kilocode/db/schema');
    expect(mockFrom).toHaveBeenCalledWith(modelStats);
    expect(mockSelect).toHaveBeenCalledWith({ stat: modelStats, verification: expect.anything() });
    expect(mockLeftJoin).toHaveBeenCalledWith(enkrypt_sync_state, expect.anything());
    const selection = mockSelect.mock.calls[0][0];
    if (!selection.verification) throw new Error('Expected verification projection');
    const dialect = new PgDialect();
    expect(dialect.sqlToQuery(selection.verification)).toMatchObject({
      sql: '"enkrypt_sync_state"."verified_models" -> "model_stats"."openrouter_id"',
      params: [],
    });
    const join = mockLeftJoin.mock.calls[0];
    expect(dialect.sqlToQuery(join[1])).toMatchObject({
      sql: '"enkrypt_sync_state"."job_name" = $1',
      params: ['enkrypt'],
    });
    expect(dialect.sqlToQuery(mockOrderBy.mock.calls[0][0] as SQL).sql).toBe(
      '"model_stats"."coding_index" desc'
    );
  });

  it('never creates cache entries or extra queries for arbitrary missing slugs', async () => {
    const snapshot = await cache.getModelStatsSnapshot();
    const responses = await Promise.all(
      Array.from({ length: 250 }, (_, i) => detail(`absent-${i}`))
    );
    expect(responses.every(response => response.status === 404)).toBe(true);
    expect(await cache.getModelStatsSnapshot()).toBe(snapshot);
    expect(snapshot.entries).toHaveLength(1);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it('caches base rows without any status join while disabled and suppresses warm raw scores immediately', async () => {
    mockPublicationEnabled = false;
    for (let i = 0; i < 10; i++) {
      const [all, one, benchmark] = await Promise.all([list(), detail(), catalog()]);
      expect((await all.json())[0].benchmarks).toEqual(siblings);
      expect((await one.json()).openrouterData).not.toHaveProperty('enkrypt');
      expect(benchmark).toBeUndefined();
    }
    const { modelStats } = await import('@kilocode/db/schema');
    expect(mockSelect).toHaveBeenCalledWith({ stat: modelStats });
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockLeftJoin).not.toHaveBeenCalled();
    expect(mockReplicaSelect).not.toHaveBeenCalled();
    mockPublicationEnabled = true;
    cache.invalidateModelStatsCache();
    expect(await catalog()).toBeDefined();
    const snapshot = await enkrypt.getEnkryptBenchmarks();
    mockPublicationEnabled = false;
    expect(enkrypt.enkryptFor(snapshot, 'provider/model')).toBeUndefined();
    expect((await (await list()).json())[0].benchmarks).toEqual(siblings);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it.each([{ isStealth: true }, { isActive: false }])(
    'retains base data but revokes Enkrypt at TTL when a newly hidden model cannot refresh: %j',
    async hidden => {
      const old = await cache.getModelStatsSnapshot();
      expect(await catalog()).toBeDefined();
      jest.advanceTimersByTime(TTL - 1);
      expect(await catalog()).toBeDefined();
      expect(mockSelect).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      mockOrderBy.mockRejectedValue(new Error('unavailable'));
      const [all, one, benchmark] = await Promise.all([list(), detail(), catalog()]);
      expect((await all.json())[0].benchmarks).toEqual(siblings);
      expect((await one.json()).name).toBe('Model');
      expect(benchmark).toBeUndefined();
      expect(enkrypt.enkryptFor(old, 'provider/model')).toBeUndefined();
      for (let i = 0; i < 30; i++) await Promise.all([list(), detail(), catalog()]);
      expect(mockSelect).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(15_000);
      mockOrderBy.mockResolvedValue([entry(hidden)]);
      expect(await catalog()).toBeUndefined();
      expect(mockSelect).toHaveBeenCalledTimes(3);
      expect((await (await detail()).json()).benchmarks).toEqual(siblings);
      jest.advanceTimersByTime(48 * 60 * 60 * 1000);
      mockOrderBy.mockRejectedValue(new Error('unavailable'));
      expect(await catalog()).toBeUndefined();
    }
  );

  it('keeps cold failures as stats 500s and backs off without caching fake empty successes', async () => {
    mockOrderBy.mockRejectedValue(new Error('unavailable'));
    for (let i = 0; i < 10; i++) {
      const [all, one, benchmark] = await Promise.all([list(), detail(), catalog()]);
      expect(all.status).toBe(500);
      expect(one.status).toBe(500);
      expect(all.headers.get('Cache-Control')).toBe('no-store');
      expect(benchmark).toBeUndefined();
    }
    expect(mockSelect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(14_999);
    expect((await list()).status).toBe(500);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    mockOrderBy.mockResolvedValue([]);
    expect(await (await list()).json()).toEqual([]);
    expect((await detail()).status).toBe(404);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('invalidates fallback eligibility immediately and bypasses failure cooldown', async () => {
    const snapshot = await cache.getModelStatsSnapshot();
    cache.invalidateModelStatsCache();
    expect(cache.isModelStatsSnapshotFresh(snapshot)).toBe(false);
    expect(enkrypt.enkryptFor(snapshot, 'provider/model')).toBeUndefined();
    mockOrderBy.mockRejectedValueOnce(new Error('unavailable'));
    expect((await (await detail()).json()).benchmarks).toEqual(siblings);
    expect(await cache.getModelStatsSnapshot()).toBe(snapshot);
    expect(mockSelect).toHaveBeenCalledTimes(2);
    cache.invalidateModelStatsCache();
    const next = await cache.getModelStatsSnapshot();
    expect(next).not.toBe(snapshot);
    expect(cache.isModelStatsSnapshotFresh(next)).toBe(true);
    expect(mockSelect).toHaveBeenCalledTimes(3);
  });

  it.each(['resolve', 'reject'] as const)(
    'does not let invalidated in-flight %s overwrite or clear a newer load',
    async outcome => {
      const oldRows = deferredRows();
      const newRows = deferredRows();
      mockOrderBy.mockReturnValueOnce(oldRows.promise).mockReturnValueOnce(newRows.promise);
      const oldResponse = detail();
      await Promise.resolve();
      cache.invalidateModelStatsCache();
      const newResponse = detail();
      await Promise.resolve();
      if (outcome === 'resolve') oldRows.resolve([entry()]);
      else oldRows.reject(new Error('old query failed'));
      const outdated = await oldResponse;
      if (outcome === 'resolve') expect((await outdated.json()).benchmarks).toEqual(siblings);
      else expect(outdated.status).toBe(500);
      const concurrent = cache.getModelStatsSnapshot();
      expect(mockSelect).toHaveBeenCalledTimes(2);
      newRows.resolve([entry({ isStealth: true })]);
      expect((await (await newResponse).json()).benchmarks).toEqual(siblings);
      const current = await concurrent;
      expect(await cache.getModelStatsSnapshot()).toBe(current);
      expect(current.entries[0].stat.isStealth).toBe(true);
      expect(mockSelect).toHaveBeenCalledTimes(2);
    }
  );

  it('never lets a late old query repopulate a completed newer generation', async () => {
    const pending = deferredRows();
    mockOrderBy.mockReturnValueOnce(pending.promise);
    const old = cache.getModelStatsSnapshot();
    cache.invalidateModelStatsCache();
    mockOrderBy.mockResolvedValue([entry({ isStealth: true })]);
    const current = await cache.getModelStatsSnapshot();
    pending.resolve([entry()]);
    expect(enkrypt.enkryptFor(await old, 'provider/model')).toBeUndefined();
    expect(await cache.getModelStatsSnapshot()).toBe(current);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it('starts the deadline at query start, not completion', async () => {
    const pending = deferredRows();
    mockOrderBy.mockReturnValueOnce(pending.promise);
    const observedAt = Date.now();
    const response = list();
    jest.advanceTimersByTime(TTL);
    pending.resolve([entry()]);
    expect((await (await response).json())[0].benchmarks).toEqual(siblings);
    mockOrderBy.mockRejectedValueOnce(new Error('unavailable'));
    const expired = await cache.getModelStatsSnapshot();
    expect(expired.observedAt).toBe(observedAt);
    expect(cache.isModelStatsSnapshotFresh(expired)).toBe(false);
    expect(mockSelect).toHaveBeenCalledTimes(2);
  });

  it.each(['deadline', 'invalidation'] as const)(
    'rechecks %s at publication after another await, not when loading benchmarks',
    async boundary => {
      const snapshot = await enkrypt.getEnkryptBenchmarks();
      expect(enkrypt.enkryptFor(snapshot, 'provider/model')).toBeDefined();
      await Promise.resolve();
      if (boundary === 'deadline') jest.advanceTimersByTime(TTL);
      else cache.invalidateModelStatsCache();
      expect(enkrypt.enkryptFor(snapshot, 'provider/model')).toBeUndefined();
      const { publishEnkryptModelStats } = await import('./enkrypt-publication');
      if (!snapshot) throw new Error('Expected loaded snapshot');
      expect(publishEnkryptModelStats(entry().stat, snapshot, verification).benchmarks).toEqual(
        siblings
      );
    }
  );

  it('keeps hash-bound checks and internal cache fields private without mutating cached rows', async () => {
    const stored = entry();
    Object.freeze(stored.stat);
    Object.freeze(stored.stat.benchmarks);
    Object.freeze(stored.stat.openrouterData);
    mockOrderBy.mockResolvedValue([stored]);
    const [all, one, published] = await Promise.all([list(), detail(), catalog()]);
    for (const model of [(await all.json())[0], await one.json()]) {
      expect(model.benchmarks.enkrypt.lastCheckedAt).toBe(checkedAt);
      expect(model.benchmarks.enkrypt.freshness).toBe('fresh');
      expect(model.benchmarks.futureBenchmark).toEqual(siblings.futureBenchmark);
      expect(model.openrouterData).toEqual({
        name: 'Raw model',
        terminalBench: { overallScore: 1 },
      });
      expect(model).toMatchObject({ isFeatured: true, isRecommended: true, isStealth: false });
      for (const privateField of [
        'scoreHash',
        'verification',
        'observedAt',
        'generation',
        'entries',
      ]) {
        expect(JSON.stringify(model)).not.toContain(privateField);
      }
    }
    expect(published?.lastCheckedAt).toBe(checkedAt);
    expect(stored.stat.benchmarks?.enkrypt).toEqual(benchmark);
    expect(stored.stat.openrouterData).toHaveProperty('enkrypt');
  });
});
