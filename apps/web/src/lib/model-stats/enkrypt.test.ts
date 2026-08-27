import { afterEach, describe, expect, it } from '@jest/globals';
import { EnkryptBenchmarkSchema, EnkryptScoreSchema } from '@kilocode/db/schema-types';
import { ModelStatsBenchmarksSchema } from '@kilocode/db/schema';
import { enkryptFor, getEnkryptBenchmarks, summarizeEnkrypt } from './enkrypt';

jest.mock('@/lib/drizzle', () => ({
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
const benchmark = { ...score, lastUpdated: '2026-08-27T00:00:00.000Z' };
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
  });

  it('allows every score to be omitted without supplying defaults', () => {
    expect(EnkryptScoreSchema.parse(identity)).toEqual(identity);
    const minimal = { ...identity, lastUpdated: benchmark.lastUpdated };
    expect(EnkryptBenchmarkSchema.parse(minimal)).toEqual(minimal);
    expect(ModelStatsBenchmarksSchema.parse({})).toEqual({});
  });

  it.each(scoreFields)('accepts zero and null but not numeric strings for %s', field => {
    for (const value of [0, null]) {
      const input = { ...identity, [field]: value };
      expect(EnkryptScoreSchema.parse(input)).toEqual(input);
    }
    expect(EnkryptScoreSchema.safeParse({ ...identity, [field]: '0' }).success).toBe(false);
  });

  it.each(['model_name', 'provider', 'source'])('requires a nonempty %s', field => {
    for (const value of ['', null, undefined]) {
      expect(EnkryptScoreSchema.safeParse({ ...identity, [field]: value }).success).toBe(false);
    }
  });

  it.each([undefined, null, '', '2026-08-27', '2026-08-27 00:00:00+00'])(
    'requires an ISO datetime lastUpdated, rejecting %s',
    lastUpdated => {
      expect(EnkryptBenchmarkSchema.safeParse({ ...score, lastUpdated }).success).toBe(false);
    }
  );
});

describe('summarizeEnkrypt', () => {
  it('publishes an isolated enkrypt namespace without Terminal Bench attempts or costs', () => {
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
    { enkrypt: { ...benchmark, lastUpdated: 'invalid' } },
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
    expect(enkryptFor(benchmarks, 'openai/model')).toEqual(benchmark);
    expect(enkryptFor(benchmarks, 'kilo/openai/model')).toEqual(exact);
    expect(enkryptFor(new Map([['openai/model', benchmark]]), 'kilo/openai/model')).toEqual(
      benchmark
    );
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
  it('caches for five minutes and falls back to empty or last-known-good scores on errors', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-27T00:00:00.000Z'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockWhere.mockRejectedValueOnce(new Error('unavailable'));
    await expect(getEnkryptBenchmarks()).resolves.toEqual(new Map());

    mockWhere.mockResolvedValueOnce([row()]);
    const expected = new Map([['openai/model', benchmark]]);
    await expect(getEnkryptBenchmarks()).resolves.toEqual(expected);
    jest.advanceTimersByTime(5 * 60 * 1000 - 1);
    await expect(getEnkryptBenchmarks()).resolves.toEqual(expected);
    expect(mockWhere).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(1);
    mockWhere.mockRejectedValueOnce(new Error('unavailable'));
    await expect(getEnkryptBenchmarks()).resolves.toEqual(expected);
    expect(mockWhere).toHaveBeenCalledTimes(3);

    mockWhere.mockResolvedValueOnce([]);
    await expect(getEnkryptBenchmarks()).resolves.toEqual(new Map());
    expect(mockWhere).toHaveBeenCalledTimes(4);
  });
});
