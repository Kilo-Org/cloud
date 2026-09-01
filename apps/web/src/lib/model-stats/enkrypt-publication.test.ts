import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { ModelStats } from '@kilocode/db/schema';
import { ENKRYPT_STALE_AFTER_MS, type EnkryptBenchmark } from '@kilocode/db/schema-types';
import { publishEnkryptBenchmark, publishEnkryptModelStats } from './enkrypt-publication';

import type * as Config from '@/lib/config.server';

let mockPublicationEnabled = true;

jest.mock('@/lib/config.server', () => ({
  ...jest.requireActual<typeof Config>('@/lib/config.server'),
  get ENKRYPT_PUBLICATION_ENABLED() {
    return mockPublicationEnabled;
  },
  ENKRYPT_SYNC_ENABLED: false,
}));

const benchmark: EnkryptBenchmark = {
  model_name: 'Model',
  provider: 'Provider',
  risk_score: 0,
  bias_score: null,
  ingestedAt: '2026-08-27T00:00:00.000Z',
  evaluatedAt: null,
};
const ingestedAt = Date.parse(benchmark.ingestedAt);
const staleAfter = '2026-08-28T02:00:00.000Z';
const published = { ...benchmark, staleAfter, freshness: 'fresh' };
const siblings = {
  kiloBench: { overallScore: 0.6, evals: {} },
  artificialAnalysis: { codingIndex: 70 },
  futureBenchmark: { score: 2 },
};
const openrouterData: ModelStats['openrouterData'] = {
  slug: 'provider/model',
  name: 'Model',
  author: 'Provider',
  description: 'Model description',
  context_length: 1000,
  input_modalities: ['text'],
  output_modalities: ['text'],
  group: 'test',
  updated_at: benchmark.ingestedAt,
  endpoint: null,
};

function stat() {
  return {
    openrouterId: 'provider/model',
    isActive: true,
    isStealth: false,
    openrouterData: { ...openrouterData, enkrypt: published, terminalBench: { overallScore: 0.6 } },
    benchmarks: { ...siblings, enkrypt: { ...benchmark } },
    name: 'Preserved name',
    chartData: { preserved: true },
  };
}

beforeEach(() => {
  mockPublicationEnabled = true;
  jest.spyOn(Date, 'now').mockReturnValue(ingestedAt);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('publishEnkryptBenchmark', () => {
  it.each([
    [0, 'fresh'],
    [ENKRYPT_STALE_AFTER_MS - 1, 'fresh'],
    [ENKRYPT_STALE_AFTER_MS, 'stale'],
    [ENKRYPT_STALE_AFTER_MS + 1, 'stale'],
  ])(
    'computes freshness at ingestion age %s milliseconds with ingestion disabled',
    (age, freshness) => {
      expect(publishEnkryptBenchmark(benchmark, ingestedAt + age)).toEqual({
        ...published,
        freshness,
      });
    }
  );

  it('withholds valid stored data when publication is disabled', () => {
    mockPublicationEnabled = false;
    expect(publishEnkryptBenchmark(benchmark)).toBeUndefined();
  });

  it.each([ingestedAt - 1, NaN, Infinity, -Infinity])(
    'omits invalid or future snapshots for response time %s',
    now => {
      expect(publishEnkryptBenchmark(benchmark, now)).toBeUndefined();
    }
  );

  it.each([
    null,
    undefined,
    {},
    { ...benchmark, ingestedAt: 'invalid' },
    { ...benchmark, ingestedAt: '2026-08-27 00:00:00+00' },
    { ...benchmark, evaluatedAt: benchmark.ingestedAt },
    { ...benchmark, risk_score: '0' },
  ])('omits invalid stored data %j', value => {
    expect(publishEnkryptBenchmark(value)).toBeUndefined();
  });

  it('does not invent source, evaluation time, scores, or retain obsolete publication metadata', () => {
    const stored = Object.freeze({
      ...benchmark,
      freshness: 'stale',
      staleAfter: 'invalid',
      lastUpdated: 'invalid',
    });
    const result = publishEnkryptBenchmark(stored);
    expect(result).toEqual(published);
    expect(result).not.toHaveProperty('source');
    expect(result).not.toHaveProperty('safety_score');
    expect(result).not.toHaveProperty('lastUpdated');
    expect(stored.freshness).toBe('stale');
    expect(stored.staleAfter).toBe('invalid');
  });

  it.each([null, '', 'upstream value'])('preserves the upstream source %j', source => {
    expect(publishEnkryptBenchmark({ ...benchmark, source })).toEqual({ ...published, source });
  });
});

describe('publishEnkryptModelStats', () => {
  it('recomputes each response without mutating stored namespaces or raw OpenRouter data', () => {
    const stored = stat();
    Object.freeze(stored);
    Object.freeze(stored.benchmarks);
    Object.freeze(stored.benchmarks.enkrypt);
    Object.freeze(stored.openrouterData);
    const result = publishEnkryptModelStats(stored);
    expect(result.benchmarks).toEqual({ ...siblings, enkrypt: published });
    expect(result.openrouterData).toEqual({
      ...openrouterData,
      terminalBench: { overallScore: 0.6 },
    });
    expect(result.name).toBe(stored.name);
    expect(result.chartData).toBe(stored.chartData);
    expect(result.benchmarks.kiloBench).toBe(stored.benchmarks.kiloBench);
    expect(stored.openrouterData.enkrypt).toEqual(published);
    expect(stored.benchmarks.enkrypt).toEqual(benchmark);
    jest.mocked(Date.now).mockReturnValue(Date.parse(staleAfter));
    expect(publishEnkryptModelStats(stored).benchmarks.enkrypt).toEqual({
      ...published,
      freshness: 'stale',
    });
    expect(result.benchmarks.enkrypt).toEqual(published);
  });

  it('strips stored and raw Enkrypt values while retaining all siblings when disabled', () => {
    mockPublicationEnabled = false;
    const stored = stat();
    const result = publishEnkryptModelStats(stored);
    expect(result.benchmarks).toEqual(siblings);
    expect(result.openrouterData).not.toHaveProperty('enkrypt');
    expect(result.openrouterData.terminalBench).toEqual(stored.openrouterData.terminalBench);
    expect(stored.benchmarks.enkrypt).toEqual(benchmark);
    expect(stored.openrouterData.enkrypt).toEqual(published);
  });

  it.each([null, undefined])('strips raw Enkrypt even with %s benchmarks', benchmarks => {
    mockPublicationEnabled = false;
    const stored = { ...stat(), benchmarks };
    const result = publishEnkryptModelStats(stored);
    expect(result.benchmarks).toBe(benchmarks);
    expect(result.openrouterData).not.toHaveProperty('enkrypt');
    expect(stored.openrouterData.enkrypt).toEqual(published);
  });

  it.each([
    { isActive: false },
    { isActive: null },
    { isStealth: true },
    { openrouterId: 'kilo-internal/model' },
  ])('withholds all saved scores for nonpublic models %j', overrides => {
    const result = publishEnkryptModelStats({ ...stat(), ...overrides });
    expect(result.benchmarks).toEqual(siblings);
    expect(result.openrouterData).not.toHaveProperty('enkrypt');
  });

  it('omits invalid or future saved snapshots without affecting siblings', () => {
    const stored = stat();
    stored.benchmarks.enkrypt.ingestedAt = 'invalid';
    expect(publishEnkryptModelStats(stored).benchmarks).toEqual(siblings);
    stored.benchmarks.enkrypt.ingestedAt = new Date(ingestedAt + 1).toISOString();
    expect(publishEnkryptModelStats(stored).benchmarks).toEqual(siblings);
  });
});
