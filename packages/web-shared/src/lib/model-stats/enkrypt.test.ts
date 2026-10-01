import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  ENKRYPT_STALE_AFTER_MS,
  EnkryptBenchmarkSchema,
  EnkryptPublishedBenchmarkSchema,
  EnkryptScoreSchema,
} from '@kilocode/db/schema-types';
import { ModelStatsBenchmarksSchema, type ModelStats } from '@kilocode/db/schema';
import type * as Enkrypt from './enkrypt';
import type { ModelStatsCacheEntry } from './model-stats-cache';
import { fingerprintEnkryptScore } from './enkrypt-fingerprint';

let mockPublicationEnabled = true;
let mockSyncEnabled = false;
const mockOrderBy = jest.fn<Promise<ModelStatsCacheEntry[]>, []>();
const mockSelect = jest.fn(() => ({
  from: () => ({ leftJoin: () => ({ orderBy: mockOrderBy }), orderBy: mockOrderBy }),
}));
const mockReplicaSelect = jest.fn();

jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
  get ENKRYPT_SYNC_ENABLED() {
    return mockSyncEnabled;
  },
}));
jest.mock('@/lib/drizzle', () => ({
  db: { select: mockSelect },
  readDb: { select: mockReplicaSelect },
}));

const score = {
  model_name: 'Model Name',
  provider: 'Provider Name',
  source: 'Enkrypt AI',
  risk_score: 0,
  bias_score: null,
  cbrn_score: 12.5,
  harmful_score: -2,
  insecure_code_score: 150,
  toxicity_score: 0.5,
  robustness_score: 80,
  jailbreak_score: null,
  evasion_score: 0,
  safety_score: 99,
  nist_score: 1.25,
  owasp_score: 1000,
};
const benchmark = { ...score, ingestedAt: '2026-08-27T00:00:00.000Z', evaluatedAt: null };
const published = {
  ...benchmark,
  lastCheckedAt: benchmark.ingestedAt,
  staleAfter: '2026-08-28T02:00:00.000Z',
  freshness: 'fresh',
};
const scoreFields = [
  'risk_score',
  'bias_score',
  'cbrn_score',
  'harmful_score',
  'insecure_code_score',
  'toxicity_score',
  'robustness_score',
  'jailbreak_score',
  'evasion_score',
  'safety_score',
  'nist_score',
  'owasp_score',
] as const;
const identity = { model_name: score.model_name, provider: score.provider, source: score.source };

function row(overrides: Partial<ModelStats> = {}, verification?: unknown): ModelStatsCacheEntry {
  return {
    stat: {
      openrouterId: 'openai/model',
      isActive: true,
      isStealth: false,
      benchmarks: { enkrypt: benchmark },
      ...overrides,
    } as ModelStats,
    verification,
  };
}

let enkryptFor: typeof Enkrypt.enkryptFor;
let getEnkryptBenchmarks: typeof Enkrypt.getEnkryptBenchmarks;
let publishEnkryptModels: typeof Enkrypt.publishEnkryptModels;

beforeEach(async () => {
  jest.resetModules();
  jest.clearAllMocks();
  mockOrderBy.mockReset().mockResolvedValue([row()]);
  mockPublicationEnabled = true;
  mockSyncEnabled = false;
  jest.useFakeTimers();
  jest.setSystemTime(Date.parse(benchmark.ingestedAt));
  ({ enkryptFor, getEnkryptBenchmarks, publishEnkryptModels } = await import('./enkrypt'));
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('Enkrypt schemas', () => {
  it('preserves upstream names, numeric values, zeros, and nulls without normalization', () => {
    expect(EnkryptScoreSchema.parse(score)).toEqual(score);
    expect(EnkryptBenchmarkSchema.parse(benchmark)).toEqual(benchmark);
    expect(ModelStatsBenchmarksSchema.parse({ enkrypt: benchmark })).toEqual({
      enkrypt: benchmark,
    });
    expect(EnkryptPublishedBenchmarkSchema.parse(published)).toEqual(published);
  });

  it('allows every score to be omitted without supplying defaults', () => {
    expect(EnkryptScoreSchema.parse(identity)).toEqual(identity);
    const minimal = { ...identity, ingestedAt: benchmark.ingestedAt, evaluatedAt: null };
    expect(EnkryptBenchmarkSchema.parse(minimal)).toEqual(minimal);
    expect(ModelStatsBenchmarksSchema.parse({})).toEqual({});
  });

  it.each(scoreFields)(
    'accepts zero and null but not nonnumeric or nonfinite values for %s',
    field => {
      for (const value of [0, null]) {
        const input = { ...identity, [field]: value };
        expect(EnkryptScoreSchema.parse(input)).toEqual(input);
      }
      for (const value of ['0', NaN, Infinity, -Infinity]) {
        expect(EnkryptScoreSchema.safeParse({ ...identity, [field]: value }).success).toBe(false);
      }
    }
  );

  it.each(['model_name', 'provider'])('requires a nonempty %s', field => {
    for (const value of ['', null, undefined]) {
      expect(EnkryptScoreSchema.safeParse({ ...identity, [field]: value }).success).toBe(false);
    }
  });

  it.each([undefined, null, '', 'supplied by upstream'])('preserves optional source %s', source => {
    const input = { model_name: score.model_name, provider: score.provider, source };
    expect(EnkryptScoreSchema.parse(input)).toEqual(input);
  });

  it('does not invent a source when upstream omits it', () => {
    const input = { model_name: score.model_name, provider: score.provider };
    expect(EnkryptScoreSchema.parse(input)).toEqual(input);
    expect(EnkryptScoreSchema.parse(input)).not.toHaveProperty('source');
  });

  it.each([undefined, null, '', '2026-08-27', '2026-08-27 00:00:00+00'])(
    'requires an ISO datetime ingestedAt, rejecting %s',
    ingestedAt => {
      expect(EnkryptBenchmarkSchema.safeParse({ ...benchmark, ingestedAt }).success).toBe(false);
    }
  );

  it.each([undefined, '', benchmark.ingestedAt])(
    'requires explicitly unknown evaluatedAt, rejecting %s',
    evaluatedAt => {
      expect(EnkryptBenchmarkSchema.safeParse({ ...benchmark, evaluatedAt }).success).toBe(false);
    }
  );

  it('rejects legacy storage and unpublished response values', () => {
    expect(
      EnkryptBenchmarkSchema.safeParse({ ...score, lastUpdated: benchmark.ingestedAt }).success
    ).toBe(false);
    expect(EnkryptPublishedBenchmarkSchema.safeParse(benchmark).success).toBe(false);
    for (const override of [
      { freshness: 'unknown' },
      { staleAfter: 'invalid' },
      { lastCheckedAt: 'invalid' },
    ]) {
      expect(EnkryptPublishedBenchmarkSchema.safeParse({ ...published, ...override }).success).toBe(
        false
      );
    }
  });
});

describe('enkryptFor', () => {
  it('ignores malformed unrelated namespaces and never includes Terminal Bench costs', async () => {
    const benchmarks: unknown = {
      enkrypt: benchmark,
      kiloBench: { overallScore: 'invalid', evals: null },
      futureBenchmark: 'unknown',
    };
    mockOrderBy.mockResolvedValue([row({ benchmarks: benchmarks as ModelStats['benchmarks'] })]);
    expect(enkryptFor(await getEnkryptBenchmarks(), 'openai/model')).toEqual(published);
  });

  it.each([
    { openrouterId: 'kilo-internal/custom' },
    { isActive: false },
    { isActive: null },
    { isStealth: true },
  ])('withholds nonpublic rows %j', async overrides => {
    const entry = row(overrides);
    mockOrderBy.mockResolvedValue([entry]);
    expect(enkryptFor(await getEnkryptBenchmarks(), entry.stat.openrouterId)).toBeUndefined();
  });

  it.each([
    undefined,
    null,
    'invalid',
    {},
    { kiloBench: {} },
    { enkrypt: null },
    { enkrypt: {} },
    { enkrypt: { ...benchmark, risk_score: '0' } },
    { enkrypt: { ...benchmark, ingestedAt: 'invalid' } },
  ])('omits absent or malformed Enkrypt scores: %j', async benchmarks => {
    mockOrderBy.mockResolvedValue([row({ benchmarks: benchmarks as ModelStats['benchmarks'] })]);
    expect(enkryptFor(await getEnkryptBenchmarks(), 'openai/model')).toBeUndefined();
  });

  it('prefers exact identity over a safe gateway-prefixed fallback', async () => {
    const exact = { ...benchmark, risk_score: 25 };
    mockOrderBy.mockResolvedValue([
      row(),
      row({ openrouterId: 'kilo/openai/model', benchmarks: { enkrypt: exact } }),
      row({ openrouterId: 'openai/other' }),
    ]);
    const snapshot = await getEnkryptBenchmarks();
    expect(enkryptFor(snapshot, 'openai/model')).toEqual(published);
    expect(enkryptFor(snapshot, 'kilo/openai/model')).toEqual({ ...published, risk_score: 25 });
    expect(enkryptFor(snapshot, 'kilo/openai/other')).toEqual(published);
  });

  it('does not substitute a public fallback for an ineligible exact match', async () => {
    mockOrderBy.mockResolvedValue([
      row(),
      row({ openrouterId: 'kilo/openai/model', isStealth: true }),
    ]);
    expect(enkryptFor(await getEnkryptBenchmarks(), 'kilo/openai/model')).toBeUndefined();
  });

  it('withholds warm scores immediately when publication is disabled', async () => {
    const snapshot = await getEnkryptBenchmarks();
    mockPublicationEnabled = false;
    expect(enkryptFor(snapshot, 'openai/model')).toBeUndefined();
    expect(enkryptFor(snapshot, 'kilo/openai/model')).toBeUndefined();
    expect(snapshot?.entries[0].stat.benchmarks?.enkrypt).toEqual(benchmark);
  });

  it('omits a future ingestion timestamp', async () => {
    jest.setSystemTime(Date.parse(benchmark.ingestedAt) - 1);
    expect(enkryptFor(await getEnkryptBenchmarks(), 'openai/model')).toBeUndefined();
  });

  it.each([
    'kilo/special-model',
    'kilocode/openai/model',
    'byok/openai/model',
    'kilo-internal/openai/model',
    'kilo-auto/openai/model',
    'kilo/kilo/openai/model',
    'openai/model:free',
    'kilo/openai/model:free',
    'unknown/model',
  ])('does not infer a score for %s', async id => {
    mockOrderBy.mockResolvedValue([row(), row({ openrouterId: 'special-model' })]);
    expect(enkryptFor(await getEnkryptBenchmarks(), id)).toBeUndefined();
  });
});

describe('publishEnkryptModels', () => {
  it('replaces raw scores without altering model order, availability, or cached rows', async () => {
    const models = Object.freeze([
      Object.freeze({
        id: 'openai/model',
        enkrypt: { untrusted: true },
        hasUserByokAvailable: true,
      }),
      Object.freeze({
        id: 'unmatched/model',
        enkrypt: { untrusted: true },
        hasUserByokAvailable: false,
      }),
    ]);
    const snapshot = await getEnkryptBenchmarks();
    expect(publishEnkryptModels(models, snapshot)).toEqual([
      { id: 'openai/model', enkrypt: published, hasUserByokAvailable: true },
      { id: 'unmatched/model', hasUserByokAvailable: false },
    ]);
    expect(models[0].enkrypt).toEqual({ untrusted: true });
    expect(snapshot?.entries[0].stat.benchmarks?.enkrypt).toEqual(benchmark);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it.each(['disabled', 'expired', 'invalidated'] as const)(
    'strips old annotations when %s',
    async boundary => {
      const snapshot = await getEnkryptBenchmarks();
      const models = publishEnkryptModels([{ id: 'openai/model' }], snapshot);
      if (boundary === 'disabled') mockPublicationEnabled = false;
      else if (boundary === 'expired') jest.advanceTimersByTime(300_000);
      else (await import('./model-stats-cache')).invalidateModelStatsCache();
      expect(publishEnkryptModels(models, snapshot)).toEqual([{ id: 'openai/model' }]);
      expect(models[0].enkrypt).toEqual(published);
      expect(mockSelect).toHaveBeenCalledTimes(1);
    }
  );

  it('never annotates virtual auto models even if a matching stats row exists', async () => {
    mockOrderBy.mockResolvedValue([row({ openrouterId: 'kilo-auto/org' })]);
    const snapshot = await getEnkryptBenchmarks();
    expect(publishEnkryptModels([{ id: 'kilo-auto/org', enkrypt: published }], snapshot)).toEqual([
      { id: 'kilo-auto/org' },
    ]);
  });
});

describe('getEnkryptBenchmarks', () => {
  it.each([true, false])(
    'does not query when publication is disabled and sync is %s',
    async enabled => {
      mockPublicationEnabled = false;
      mockSyncEnabled = enabled;
      expect(await getEnkryptBenchmarks()).toBeNull();
      expect(mockSelect).not.toHaveBeenCalled();
      expect(mockReplicaSelect).not.toHaveBeenCalled();
    }
  );

  it('recomputes check freshness without changing or exposing the shared snapshot', async () => {
    const checkedAt = '2026-08-30T00:00:00.000Z';
    const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) };
    const staleAfter = Date.parse(checkedAt) + ENKRYPT_STALE_AFTER_MS;
    jest.setSystemTime(staleAfter - 1);
    mockOrderBy.mockResolvedValue([row({}, verification), row({ openrouterId: 'openai/missing' })]);
    const snapshot = await getEnkryptBenchmarks();
    const checked = {
      ...published,
      lastCheckedAt: checkedAt,
      staleAfter: new Date(staleAfter).toISOString(),
    };
    expect(enkryptFor(snapshot, 'openai/model')).toEqual(checked);
    expect(enkryptFor(snapshot, 'openai/missing')).toEqual({ ...published, freshness: 'stale' });
    jest.advanceTimersByTime(1);
    expect(await getEnkryptBenchmarks()).toBe(snapshot);
    expect(enkryptFor(snapshot, 'openai/model')).toEqual({ ...checked, freshness: 'stale' });
    expect(snapshot?.entries[0].verification).toEqual(verification);
    expect(snapshot?.entries[0].stat.benchmarks?.enkrypt).toEqual(benchmark);
    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(mockReplicaSelect).not.toHaveBeenCalled();
  });
});
