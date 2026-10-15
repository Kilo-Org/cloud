import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BenchmarkConfig } from '@kilocode/auto-routing-contracts';
import type * as DbModule from './db';
import type * as ConfigModule from './config';
import type { OfflineSweep } from './scoreboard/schema';
import { caseSplitForId, optimizeThresholdPolicy, reevaluateSystemOptimalSettings } from './system-optimal';

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getRoutingCaseResultsForEntries: vi.fn(),
    listReadyCurrentProfilesForEntries: vi.fn(),
    savePolicyComputed: vi.fn(),
  };
});

vi.mock('./config', async importOriginal => {
  const actual = await importOriginal<typeof ConfigModule>();
  return { ...actual, getBenchmarkConfig: vi.fn() };
});

import {
  getRoutingCaseResultsForEntries,
  listReadyCurrentProfilesForEntries,
  savePolicyComputed,
} from './db';
import { getBenchmarkConfig } from './config';

const ROUTES = ['implementation/code_generation', 'debugging/bug_fixing'];

function caseIdsFor(split: 'train' | 'heldOut', count: number): string[] {
  const ids: string[] = [];
  for (let index = 0; ids.length < count; index++) {
    const id = `${split}-case-${index}`;
    if (caseSplitForId(id) === split) ids.push(id);
  }
  return ids;
}

function resultsFor(
  routes: readonly string[],
  split: 'train' | 'heldOut',
  count: number,
  score: number,
  costUsd: number
): OfflineSweep['pairs'][number]['results'] {
  return routes.flatMap(routeKey =>
    caseIdsFor(split, count).map(caseId => ({
      caseId,
      rep: 0,
      routeKey,
      split,
      score,
      costUsd,
      graderCostUsd: 0,
      latencyMs: 100,
      error: null,
    }))
  );
}

function pairsFor(
  models: { model: string; train: { score: number; costUsd: number }; heldOut: { score: number; costUsd: number } }[],
  routes: readonly string[] = ROUTES,
  cases = 12
): OfflineSweep['pairs'] {
  return models.map(model => ({
    model: model.model,
    variant: null,
    results: [
      ...resultsFor(routes, 'train', cases, model.train.score, model.train.costUsd),
      ...resultsFor(routes, 'heldOut', cases, model.heldOut.score, model.heldOut.costUsd),
    ],
  }));
}

const noPricing = new Map<string, null>();

describe('optimizeThresholdPolicy', () => {
  it('picks the middle of a stable plateau instead of its edge', () => {
    const optimization = optimizeThresholdPolicy({
      pairs: pairsFor([
        { model: 'strong', train: { score: 1, costUsd: 0.001 }, heldOut: { score: 1, costUsd: 0.001 } },
        { model: 'also-strong', train: { score: 1, costUsd: 0.01 }, heldOut: { score: 1, costUsd: 0.01 } },
      ]),
      profile: null,
      pricing: noPricing,
    });

    // Every grid point produces the same table, so the plateau spans the whole
    // grid: the chosen point is its middle, not 0.5 / band 0.
    expect(optimization).toMatchObject({
      minAccuracy: 0.7,
      accuracyNoiseBand: 0.05,
      heldOutAccuracy: 1,
      heldOutCases: 48,
      routes: 2,
    });
  });

  it('returns null when the held-out sample is too small', () => {
    const optimization = optimizeThresholdPolicy({
      pairs: pairsFor(
        [
          { model: 'strong', train: { score: 1, costUsd: 0.001 }, heldOut: { score: 1, costUsd: 0.001 } },
          { model: 'also-strong', train: { score: 1, costUsd: 0.01 }, heldOut: { score: 1, costUsd: 0.01 } },
        ],
        ROUTES,
        1
      ),
      profile: null,
      pricing: noPricing,
    });

    expect(optimization).toBeNull();
  });

  it('returns null when only one route carries held-out results', () => {
    const optimization = optimizeThresholdPolicy({
      pairs: pairsFor(
        [
          { model: 'strong', train: { score: 1, costUsd: 0.001 }, heldOut: { score: 1, costUsd: 0.001 } },
          { model: 'also-strong', train: { score: 1, costUsd: 0.01 }, heldOut: { score: 1, costUsd: 0.01 } },
        ],
        ROUTES.slice(0, 1)
      ),
      profile: null,
      pricing: noPricing,
    });

    expect(optimization).toBeNull();
  });
});

const baseConfig: BenchmarkConfig = {
  router: 'efficient',
  accuracyNoiseBand: 0.05,
  frontierMinAccuracyDelta: 0,
  classifierModels: ['classifier/a'],
  deciderModels: [{ id: 'platform/a' }],
  minAccuracy: 0.7,
  switchCostFactor: 3,
  bestAccuracySwitchThreshold: 0.05,
  productionTokenProfile: null,
  switchHorizonTurns: null,
  lowConfidenceThreshold: null,
  maxConcurrency: 4,
  userMaxConcurrency: 100,
  benchmarkUserId: null,
  benchmarkOrgId: null,
  classifierRepetitions: 1,
  deciderRepetitions: 1,
  classifierMaxP95LatencyMs: 1000,
  policyOverrides: null,
  policyComputed: null,
  updatedAt: '2026-06-01T00:00:00.000Z',
  updatedBy: null,
};

const env = {
  BENCH_DB: {} as D1Database,
  INTERNAL_API_SECRET_PROD: { get: async () => 'secret' },
  KILO_WEB_API_BASE_URL: 'https://app.test',
} as unknown as Env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ data: [{ id: 'platform/a' }] }))
  );
  vi.mocked(savePolicyComputed).mockResolvedValue(undefined);
  vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([]);
  vi.mocked(getRoutingCaseResultsForEntries).mockResolvedValue([]);
});

describe('reevaluateSystemOptimalSettings', () => {
  it('keeps the previous computed threshold when the registry has no ready entries', async () => {
    vi.mocked(getBenchmarkConfig).mockResolvedValue({
      ...baseConfig,
      policyComputed: {
        minAccuracy: {
          value: 0.65,
          computedAt: '2026-06-01T00:00:00.000Z',
          source: 'held-out-grid',
          evidence: 'earlier run',
        },
      },
    });

    const saved = await reevaluateSystemOptimalSettings(env, 'efficient', {
      windowDays: 7,
      sampleRequests: 100,
      uncachedInputTokens: 1000,
      cachedInputTokens: 200,
      medianTurnsPerSession: 7.2,
    });

    expect(saved).toMatchObject({
      minAccuracy: { value: 0.65 },
      productionTokenProfile: { value: { uncachedInputTokens: 1000, cachedInputTokens: 200 } },
      switchHorizonTurns: { value: 7 },
    });
    expect(savePolicyComputed).toHaveBeenCalledWith(
      env.BENCH_DB,
      'efficient',
      expect.objectContaining({ minAccuracy: expect.objectContaining({ value: 0.65 }) })
    );
  });

  it('leaves stored values alone when there is no production data and too few cases', async () => {
    vi.mocked(getBenchmarkConfig).mockResolvedValue(baseConfig);
    vi.mocked(listReadyCurrentProfilesForEntries).mockResolvedValue([
      { model: 'platform/a', variant: '', run_id: 'run-1' },
    ]);
    vi.mocked(getRoutingCaseResultsForEntries).mockResolvedValue(
      pairsFor(
        [
          { model: 'strong', train: { score: 1, costUsd: 0.001 }, heldOut: { score: 1, costUsd: 0.001 } },
        ],
        ROUTES,
        1
      )
    );

    const saved = await reevaluateSystemOptimalSettings(env, 'efficient', null);

    expect(saved).toBeNull();
    expect(savePolicyComputed).not.toHaveBeenCalled();
  });
});
