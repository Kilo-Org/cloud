import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  ENKRYPT_STALE_AFTER_MS,
  EnkryptBenchmarkSchema,
  EnkryptPublishedBenchmarkSchema,
  EnkryptScoreSchema,
} from '@kilocode/db/schema-types';
import { ModelStatsBenchmarksSchema } from '@kilocode/db/schema';
import { db, readDb } from '@/lib/drizzle';
import { enkryptFor, getEnkryptBenchmarks, summarizeEnkrypt } from './enkrypt';
import { fingerprintEnkryptScore } from './enkrypt-fingerprint';

let mockPublicationEnabled = true;
let mockSyncEnabled = false;

jest.mock('@/lib/config.server', () => ({
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
  get ENKRYPT_SYNC_ENABLED() {
    return mockSyncEnabled;
  },
}));

jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: mockVerificationWhere })),
    })),
  },
  readDb: {
    select: jest.fn(() => ({
      from: jest.fn(() => ({ where: mockWhere })),
    })),
  },
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
const identity = {
  model_name: score.model_name,
  provider: score.provider,
  source: score.source,
};

function row(overrides: Partial<Parameters<typeof summarizeEnkrypt>[0][number]> = {}) {
  return {
    openrouterId: 'openai/model',
    isActive: true,
    isStealth: false,
    benchmarks: { enkrypt: benchmark },
    ...overrides,
  };
}

const mockWhere = jest.fn<Promise<Parameters<typeof summarizeEnkrypt>[0]>, []>();
const mockVerificationWhere = jest.fn<Promise<{ verified_models: unknown }[]>, []>();

beforeEach(() => {
  mockPublicationEnabled = true;
  mockSyncEnabled = false;
  jest.clearAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse(benchmark.ingestedAt));
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

  it('rejects the legacy lastUpdated-only storage contract and unpublished response values', () => {
    expect(
      EnkryptBenchmarkSchema.safeParse({ ...score, lastUpdated: benchmark.ingestedAt }).success
    ).toBe(false);
    expect(EnkryptPublishedBenchmarkSchema.safeParse(benchmark).success).toBe(false);
    expect(
      EnkryptPublishedBenchmarkSchema.safeParse({ ...published, freshness: 'unknown' }).success
    ).toBe(false);
    expect(
      EnkryptPublishedBenchmarkSchema.safeParse({ ...published, staleAfter: 'invalid' }).success
    ).toBe(false);
    expect(
      EnkryptPublishedBenchmarkSchema.safeParse({ ...published, lastCheckedAt: 'invalid' }).success
    ).toBe(false);
  });
});

describe('summarizeEnkrypt', () => {
  it('caches an isolated storage namespace without publication metadata or Terminal Bench costs', () => {
    expect(summarizeEnkrypt([row()])).toEqual(new Map([['openai/model', benchmark]]));
  });

  it('ignores malformed unrelated benchmark namespaces', () => {
    const benchmarks = {
      enkrypt: benchmark,
      kiloBench: { overallScore: 'invalid', evals: null },
      artificialAnalysis: { liveCodeBench: null },
      futureBenchmark: 'unknown',
    };
    expect(summarizeEnkrypt([row({ benchmarks })])).toEqual(new Map([['openai/model', benchmark]]));
  });

  it('excludes internal and inactive rows while preserving active public scores', () => {
    expect(
      summarizeEnkrypt([
        row(),
        row({ openrouterId: 'kilo-internal/custom' }),
        row({ openrouterId: 'inactive/model', isActive: false }),
        row({ openrouterId: 'null-active/model', isActive: null }),
      ])
    ).toEqual(new Map([['openai/model', benchmark]]));
  });

  it('withholds previously stored scores for models marked stealth', () => {
    expect(summarizeEnkrypt([row({ isStealth: true })])).toEqual(new Map());
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
  ])('omits absent or malformed Enkrypt scores: %j', benchmarks => {
    expect(summarizeEnkrypt([row({ benchmarks })]).size).toBe(0);
  });
});

describe('enkryptFor', () => {
  it('prefers an exact match over a safe gateway-prefixed fallback', () => {
    const exact = { ...benchmark, risk_score: 25 };
    const benchmarks = new Map([
      ['openai/model', benchmark],
      ['kilo/openai/model', exact],
    ]);
    expect(enkryptFor(benchmarks, 'openai/model')).toEqual(published);
    expect(enkryptFor(benchmarks, 'kilo/openai/model')).toEqual({ ...published, risk_score: 25 });
    expect(enkryptFor(new Map([['openai/model', benchmark]]), 'kilo/openai/model')).toEqual(
      published
    );
  });

  it('withholds cached scores for exact and gateway-prefixed matches when publication is disabled', () => {
    mockPublicationEnabled = false;
    const benchmarks = new Map([['openai/model', benchmark]]);
    expect(enkryptFor(benchmarks, 'openai/model')).toBeUndefined();
    expect(enkryptFor(benchmarks, 'kilo/openai/model')).toBeUndefined();
    expect(benchmarks.get('openai/model')).toEqual(benchmark);
  });

  it('omits a future ingestion timestamp', () => {
    jest.mocked(Date.now).mockReturnValue(Date.parse(benchmark.ingestedAt) - 1);
    expect(enkryptFor(new Map([['openai/model', benchmark]]), 'openai/model')).toBeUndefined();
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
  ])('does not infer a score for %s', id => {
    const benchmarks = new Map([
      ['openai/model', benchmark],
      ['special-model', benchmark],
    ]);
    expect(enkryptFor(benchmarks, id)).toBeUndefined();
  });
});

describe('getEnkryptBenchmarks', () => {
  it.each([true, false])(
    'does not read the database when publication is disabled and sync is %s',
    async enabled => {
      mockPublicationEnabled = false;
      mockSyncEnabled = enabled;
      await expect(getEnkryptBenchmarks()).resolves.toEqual(new Map());
      expect(readDb.select).not.toHaveBeenCalled();
      expect(db.select).not.toHaveBeenCalled();
    }
  );

  it('joins five-minute raw caches per call and ages checks outside the caches without per-model queries', async () => {
    jest.useFakeTimers();
    const checkedAt = '2026-08-30T00:00:00.000Z';
    const verification = { checkedAt, scoreHash: fingerprintEnkryptScore(benchmark) };
    const staleAfter = Date.parse(checkedAt) + ENKRYPT_STALE_AFTER_MS;
    const checkedPublication = {
      ...published,
      lastCheckedAt: checkedAt,
      staleAfter: new Date(staleAfter).toISOString(),
    };
    jest.setSystemTime(staleAfter - 1);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWhere.mockRejectedValueOnce(new Error('unavailable'));
    mockVerificationWhere.mockResolvedValueOnce([
      { verified_models: { 'openai/model': verification } },
    ]);
    await expect(getEnkryptBenchmarks()).resolves.toEqual(new Map());

    const stored = [row(), row({ openrouterId: 'openai/missing' })];
    mockWhere.mockResolvedValueOnce(stored);
    const cached = await getEnkryptBenchmarks();
    expect([...cached]).toEqual([
      ['openai/model', { ...benchmark, verification }],
      ['openai/missing', benchmark],
    ]);
    expect(enkryptFor(cached, 'openai/model')).toEqual(checkedPublication);
    expect(enkryptFor(cached, 'kilo/openai/model')).toEqual(checkedPublication);
    expect(enkryptFor(cached, 'openai/missing')).toEqual({ ...published, freshness: 'stale' });
    expect(mockVerificationWhere).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    expect(enkryptFor(await getEnkryptBenchmarks(), 'openai/model')).toEqual({
      ...checkedPublication,
      freshness: 'stale',
    });
    expect(mockWhere).toHaveBeenCalledTimes(2);
    expect(mockVerificationWhere).toHaveBeenCalledTimes(1);
    expect(cached.get('openai/model')).toEqual({ ...benchmark, verification });
    expect(stored[0].benchmarks).toEqual({ enkrypt: benchmark });

    mockPublicationEnabled = false;
    await expect(getEnkryptBenchmarks()).resolves.toEqual(new Map());
    expect(enkryptFor(cached, 'openai/model')).toBeUndefined();
    expect(readDb.select).toHaveBeenCalledTimes(2);
    expect(db.select).toHaveBeenCalledTimes(1);
    mockPublicationEnabled = true;

    jest.advanceTimersByTime(5 * 60 * 1000 - 2);
    await expect(getEnkryptBenchmarks()).resolves.toEqual(cached);
    expect(mockWhere).toHaveBeenCalledTimes(2);
    expect(mockVerificationWhere).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1);
    mockWhere.mockRejectedValueOnce(new Error('unavailable'));
    mockVerificationWhere.mockRejectedValueOnce(new Error('unavailable'));
    const fallback = await getEnkryptBenchmarks();
    expect(fallback).toEqual(cached);
    expect(enkryptFor(fallback, 'openai/model')?.freshness).toBe('stale');
    expect(mockWhere).toHaveBeenCalledTimes(3);
    expect(mockVerificationWhere).toHaveBeenCalledTimes(2);

    const nextCheck = new Date(Date.now()).toISOString();
    mockWhere.mockRejectedValueOnce(new Error('unavailable'));
    mockVerificationWhere.mockResolvedValueOnce([
      {
        verified_models: {
          'openai/model': { ...verification, checkedAt: nextCheck },
          'openai/missing': { checkedAt: nextCheck, scoreHash: '0'.repeat(64) },
        },
      },
    ]);
    const rechecked = await getEnkryptBenchmarks();
    expect(enkryptFor(rechecked, 'openai/model')).toMatchObject({
      ingestedAt: benchmark.ingestedAt,
      lastCheckedAt: nextCheck,
      freshness: 'fresh',
      evaluatedAt: null,
    });
    expect(enkryptFor(rechecked, 'openai/missing')).toEqual({ ...published, freshness: 'stale' });
    expect(enkryptFor(cached, 'openai/model')?.lastCheckedAt).toBe(checkedAt);
    expect(mockVerificationWhere).toHaveBeenCalledTimes(3);

    mockWhere.mockResolvedValueOnce([]);
    await expect(getEnkryptBenchmarks()).resolves.toEqual(new Map());
    expect(mockWhere).toHaveBeenCalledTimes(5);
    expect(mockVerificationWhere).toHaveBeenCalledTimes(3);
  });
});
